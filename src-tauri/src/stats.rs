//! Live system stats. Sampled only when the front end asks (i.e. while Halo is visible),
//! so Halo costs almost nothing while hidden.

use serde::Serialize;
use std::sync::Mutex;
use std::time::Instant;
use sysinfo::{Components, Disks, Networks, System};

#[derive(Serialize, Clone, Default)]
pub struct Gpu {
    pub name: String,
    pub load: f32,
    pub temp: Option<f32>,
    pub vram_used: u64,
    pub vram_total: u64,
    pub power_w: Option<f32>,
    pub fan_pct: Option<f32>,
    pub clock_mhz: Option<u32>,
}

#[derive(Serialize, Clone)]
pub struct Disk {
    pub name: String,
    pub mount: String,
    pub total: u64,
    pub free: u64,
}

#[derive(Serialize, Clone, Default)]
pub struct Battery {
    pub percent: u8,
    pub charging: bool,
    pub plugged: bool,
    pub minutes_left: Option<u32>,
}

#[derive(Serialize, Clone)]
pub struct Stats {
    pub cpu_name: String,
    pub cpu: f32,
    pub cores: Vec<f32>,
    pub cpu_mhz: u64,
    pub cpu_temp: Option<f32>,
    pub ram_used: u64,
    pub ram_total: u64,
    pub disks: Vec<Disk>,
    pub net_down: f64, // bytes/sec
    pub net_up: f64,
    pub net_today_down: u64,
    pub net_today_up: u64,
    pub gpu: Option<Gpu>,
    pub battery: Option<Battery>,
    pub uptime: u64,
    pub processes: usize,
}

pub struct StatsState {
    pub sys: System,
    nets: Networks,
    pub disks: Disks,
    comps: Components,
    pub cimv2: Option<wmi::WMIConnection>,
    pub last: Option<(Instant, Stats)>,
    pub procs_refreshed: Option<Instant>,
    last_net: Option<Instant>,
    total_down: u64,
    total_up: u64,
    nvml: Option<nvml_wrapper::Nvml>,
    nvml_tried: bool,
    tick: u64,
    cached_cpu_temp: Option<f32>,
}

impl StatsState {
    pub fn new() -> Self {
        Self {
            sys: System::new().expect("sysinfo"),
            nets: Networks::new_with_refreshed_list().expect("sysinfo"),
            disks: Disks::new_with_refreshed_list().expect("sysinfo"),
            comps: Components::new_with_refreshed_list().expect("sysinfo"),
            last_net: None,
            total_down: 0,
            total_up: 0,
            nvml: None,
            nvml_tried: false,
            tick: 0,
            cached_cpu_temp: None,
            cimv2: None,
            last: None,
            procs_refreshed: None,
        }
    }
}

/// All stats work happens on one dedicated thread: sysinfo/WMI hold COM objects that must
/// stay on the thread that created them (using them elsewhere crashed with an access violation).
/// Other modules send closures to run on it. Between jobs it checks alerts every few seconds.
pub type Job = Box<dyn FnOnce(&mut StatsState) + Send>;
pub struct StatsWorker(pub Mutex<std::sync::mpsc::Sender<Job>>);

impl StatsWorker {
    pub fn spawn() -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<Job>();
        std::thread::spawn(move || {
            let mut st = StatsState::new();
            let mut last_alert = Instant::now();
            loop {
                match rx.recv_timeout(std::time::Duration::from_secs(5)) {
                    Ok(job) => job(&mut st),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => break,
                }
                if last_alert.elapsed().as_secs() >= 5 {
                    last_alert = Instant::now();
                    crate::alerts::check(&mut st);
                }
            }
        });
        Self(Mutex::new(tx))
    }

    /// Run `f` on the stats thread and wait for its result without blocking the async runtime.
    pub async fn run<T: Send + 'static>(&self, f: impl FnOnce(&mut StatsState) -> T + Send + 'static) -> Result<T, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.0
            .lock()
            .unwrap()
            .send(Box::new(move |s| {
                let _ = tx.send(f(s));
            }))
            .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())?
    }
}

fn gpu_stats(s: &mut StatsState) -> Option<Gpu> {
    if !s.nvml_tried {
        s.nvml_tried = true;
        s.nvml = nvml_wrapper::Nvml::init().ok();
    }
    let nvml = s.nvml.as_ref()?;
    let dev = nvml.device_by_index(0).ok()?;
    let mem = dev.memory_info().ok();
    Some(Gpu {
        name: dev.name().unwrap_or_else(|_| "GPU".into()).replace("NVIDIA GeForce ", "").replace(" Laptop GPU", ""),
        load: dev.utilization_rates().map(|u| u.gpu as f32).unwrap_or(0.0),
        temp: dev
            .temperature(nvml_wrapper::enum_wrappers::device::TemperatureSensor::Gpu)
            .ok()
            .map(|t| t as f32),
        vram_used: mem.as_ref().map(|m| m.used).unwrap_or(0),
        vram_total: mem.as_ref().map(|m| m.total).unwrap_or(0),
        power_w: dev.power_usage().ok().map(|mw| mw as f32 / 1000.0),
        fan_pct: dev.fan_speed(0).ok().map(|f| f as f32),
        clock_mhz: dev
            .clock_info(nvml_wrapper::enum_wrappers::device::Clock::Graphics)
            .ok(),
    })
}

fn battery() -> Option<Battery> {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut st = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut st).ok()? };
    if st.BatteryFlag == 128 || st.BatteryLifePercent == 255 {
        return None; // no battery
    }
    Some(Battery {
        percent: st.BatteryLifePercent,
        charging: st.BatteryFlag & 8 != 0,
        plugged: st.ACLineStatus == 1,
        minutes_left: if st.BatteryLifeTime == u32::MAX { None } else { Some(st.BatteryLifeTime / 60) },
    })
}

/// CPU temperature: sysinfo components first, then the ACPI thermal zone over WMI (needs admin).
fn cpu_temp(s: &mut StatsState) -> Option<f32> {
    s.comps.refresh(false);
    let from_comps = s
        .comps
        .iter()
        .filter(|c| {
            let l = c.label().to_lowercase();
            l.contains("cpu") || l.contains("package") || l.contains("core")
        })
        .filter_map(|c| c.temperature())
        .fold(None, |m: Option<f32>, t| Some(m.map_or(t, |m| m.max(t))));
    if from_comps.is_some() {
        return from_comps;
    }
    // WMI is slow-ish, so only every 3rd tick.
    if s.tick % 3 == 0 {
        s.cached_cpu_temp = wmi_thermal();
    }
    s.cached_cpu_temp
}

fn wmi_thermal() -> Option<f32> {
    use std::collections::HashMap;
    use wmi::{Variant, WMIConnection};
    let con = WMIConnection::with_namespace_path("root\\WMI").ok()?;
    let rows: Vec<HashMap<String, Variant>> = con
        .raw_query("SELECT CurrentTemperature FROM MSAcpi_ThermalZoneTemperature")
        .ok()?;
    rows.iter()
        .filter_map(|r| match r.get("CurrentTemperature") {
            Some(Variant::UI4(k)) => Some(*k as f32 / 10.0 - 273.15),
            Some(Variant::I4(k)) => Some(*k as f32 / 10.0 - 273.15),
            _ => None,
        })
        .filter(|t| *t > 5.0 && *t < 120.0)
        .fold(None, |m: Option<f32>, t| Some(m.map_or(t, |m| m.max(t))))
}

#[tauri::command]
pub async fn get_stats(state: tauri::State<'_, StatsWorker>) -> Result<Stats, String> {
    state.run(sample).await
}

pub fn sample(s: &mut StatsState) -> Stats {
    s.tick += 1;
    s.sys.refresh_cpu_all();
    s.sys.refresh_memory();
    if s.tick % 5 == 1 {
        s.disks.refresh(true);
        if s.procs_refreshed.map_or(true, |t| t.elapsed().as_secs() >= 3) {
            s.sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            s.procs_refreshed = Some(Instant::now());
        }
    }

    // network rate
    s.nets.refresh(true);
    let now = Instant::now();
    let (mut down, mut up) = (0u64, 0u64);
    for (_, n) in s.nets.iter() {
        down += n.received();
        up += n.transmitted();
    }
    let secs = s.last_net.map(|t| now.duration_since(t).as_secs_f64()).unwrap_or(1.0).max(0.1);
    let first = s.last_net.is_none();
    s.last_net = Some(now);
    if !first {
        s.total_down += down;
        s.total_up += up;
    }
    let net_down = if first { 0.0 } else { down as f64 / secs };
    let net_up = if first { 0.0 } else { up as f64 / secs };

    let cpus = s.sys.cpus();
    let cpu_name = cpus.first().map(|c| c.brand().trim().to_string()).unwrap_or_default();
    let cores: Vec<f32> = cpus.iter().map(|c| c.usage()).collect();
    let cpu_mhz = cpus.iter().map(|c| c.frequency()).max().unwrap_or(0);
    let cpu = s.sys.global_cpu_usage();
    let ram_used = s.sys.used_memory();
    let ram_total = s.sys.total_memory();
    let processes = s.sys.processes().len();

    let disks = s
        .disks
        .iter()
        .map(|d| Disk {
            name: d.name().to_string_lossy().to_string(),
            mount: d.mount_point().to_string_lossy().to_string(),
            total: d.total_space(),
            free: d.available_space(),
        })
        .collect();

    let cpu_temp = cpu_temp(s);
    let gpu = gpu_stats(s);

    let out = Stats {
        cpu_name,
        cpu,
        cores,
        cpu_mhz,
        cpu_temp,
        ram_used,
        ram_total,
        disks,
        net_down,
        net_up,
        net_today_down: s.total_down,
        net_today_up: s.total_up,
        gpu,
        battery: battery(),
        uptime: System::uptime().unwrap_or(0),
        processes,
    };
    s.last = Some((Instant::now(), out.clone()));
    out
}
