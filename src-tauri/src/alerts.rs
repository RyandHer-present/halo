//! Background alerts (high temps, low disk, resource hogs, network down), shown as glass toasts
//! in a small always-on-top window. Checked on the stats thread every ~5 s, only if enabled.

use crate::stats::StatsState;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Deserialize, Serialize, Clone)]
pub struct AlertCfg {
    pub cpu_temp: Option<f32>, // °C, None = off
    pub gpu_temp: Option<f32>,
    pub disk_free_pct: Option<f32>,
    pub hog_cpu: Option<f32>, // % of total CPU for ~1 minute
    pub net_down: bool,
}

impl Default for AlertCfg {
    fn default() -> Self {
        Self { cpu_temp: Some(95.0), gpu_temp: Some(87.0), disk_free_pct: Some(8.0), hog_cpu: Some(70.0), net_down: true }
    }
}

#[derive(Serialize, Clone)]
pub struct Toast {
    pub id: u64,
    pub title: String,
    pub body: String,
    pub kind: String, // "warn" | "info" | "ok"
}

struct AlertState {
    cfg: AlertCfg,
    streak: HashMap<String, u32>,
    cooldown: HashMap<String, Instant>,
    last_disk: Option<Instant>,
    last_net: Option<Instant>,
}

static STATE: OnceLock<Mutex<AlertState>> = OnceLock::new();
static QUEUE: OnceLock<Mutex<VecDeque<Toast>>> = OnceLock::new();
// 0 = unknown, 1 = up, 2 = down (once), 3 = down (reported)
static NET: AtomicU8 = AtomicU8::new(0);

fn state() -> &'static Mutex<AlertState> {
    STATE.get_or_init(|| {
        Mutex::new(AlertState { cfg: AlertCfg::default(), streak: HashMap::new(), cooldown: HashMap::new(), last_disk: None, last_net: None })
    })
}
fn queue() -> &'static Mutex<VecDeque<Toast>> {
    QUEUE.get_or_init(|| Mutex::new(VecDeque::new()))
}

#[tauri::command]
pub fn set_alerts(cfg: AlertCfg) {
    state().lock().unwrap().cfg = cfg;
}

/// Show a toast in the corner of the screen (creates the little toast window on demand).
pub fn show_toast(title: &str, body: &str, kind: &str) {
    let Some(app) = crate::APP.get() else { return };
    let t = Toast {
        id: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        title: title.into(),
        body: body.into(),
        kind: kind.into(),
    };
    queue().lock().unwrap().push_back(t.clone());
    let app2 = app.clone();
    // build off the event-loop thread: creating a WebView2 window inside a main-thread callback can deadlock
    std::thread::spawn(move || {
        if let Some(w) = app2.get_webview_window("toast") {
            let _ = w.emit("halo://toast", t);
            return;
        }
        let (mut x, mut y, scale) = (1500.0, 20.0, 1.0);
        if let Ok(Some(m)) = app2.primary_monitor() {
            let s = m.scale_factor();
            x = m.position().x as f64 / s + m.size().width as f64 / s - 400.0;
            y = m.position().y as f64 / s + 16.0;
            let _ = scale;
        }
        let _ = WebviewWindowBuilder::new(&app2, "toast", WebviewUrl::App("index.html#toast".into()))
            .title("Halo alert")
            .inner_size(384.0, 300.0)
            .position(x, y)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .resizable(false)
            .build();
    });
}

/// The toast window asks for anything queued.
#[tauri::command]
pub fn toast_pending() -> Vec<Toast> {
    queue().lock().unwrap().drain(..).collect()
}

#[tauri::command]
pub fn toast_done(app: AppHandle) {
    if let Some(w) = app.get_webview_window("toast") {
        let _ = w.destroy();
    }
}

#[tauri::command]
pub fn test_toast() {
    show_toast("Alerts are on", "This is what a Halo alert looks like.", "info");
}

fn fire(st: &mut AlertState, key: &str, title: &str, body: &str) {
    if st.cooldown.get(key).map_or(false, |t| t.elapsed() < Duration::from_secs(15 * 60)) {
        return;
    }
    st.cooldown.insert(key.into(), Instant::now());
    show_toast(title, body, "warn");
}

/// Count how many checks in a row a condition has held.
fn streak(st: &mut AlertState, key: &str, on: bool) -> u32 {
    let e = st.streak.entry(key.to_string()).or_insert(0);
    *e = if on { *e + 1 } else { 0 };
    *e
}

pub fn check(s: &mut StatsState) {
    let mut st = state().lock().unwrap();
    let cfg = st.cfg.clone();
    let any = cfg.cpu_temp.is_some() || cfg.gpu_temp.is_some() || cfg.disk_free_pct.is_some() || cfg.hog_cpu.is_some() || cfg.net_down;
    if !any {
        return;
    }
    // Reuse the UI's last sample when it is fresh, otherwise take one.
    let stats = match &s.last {
        Some((t, x)) if t.elapsed() < Duration::from_secs(4) => x.clone(),
        _ => crate::stats::sample(s),
    };

    if let Some(lim) = cfg.cpu_temp {
        let t = stats.cpu_temp.unwrap_or(0.0);
        if streak(&mut st, "cpu", t >= lim) >= 3 {
            fire(&mut st, "cpu", "CPU is running hot", &format!("{:.0}°C for the last 15 seconds. Check what is using it.", t));
        }
    }
    if let Some(lim) = cfg.gpu_temp {
        let t = stats.gpu.as_ref().and_then(|g| g.temp).unwrap_or(0.0);
        if streak(&mut st, "gpu", t >= lim) >= 3 {
            fire(&mut st, "gpu", "GPU is running hot", &format!("{:.0}°C for the last 15 seconds.", t));
        }
    }
    if let Some(lim) = cfg.disk_free_pct {
        if st.last_disk.map_or(true, |t| t.elapsed() > Duration::from_secs(300)) {
            st.last_disk = Some(Instant::now());
            for d in &stats.disks {
                if d.total > 0 {
                    let pct = d.free as f32 / d.total as f32 * 100.0;
                    if pct < lim {
                        let key = format!("disk{}", d.mount);
                        fire(&mut st, &key, "Running out of space", &format!("{} has only {:.0}% free ({:.1} GB). Try Files → Cleanup.", d.mount.trim_end_matches('\\'), pct, d.free as f64 / 1e9));
                    }
                }
            }
        }
    }
    if let Some(lim) = cfg.hog_cpu {
        if s.procs_refreshed.map_or(true, |t| t.elapsed() >= Duration::from_secs(3)) {
            s.sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            s.procs_refreshed = Some(Instant::now());
        }
        let n = s.sys.cpus().len().max(1) as f32;
        let me = std::process::id();
        let top = s
            .sys
            .processes()
            .iter()
            .filter(|(pid, _)| pid.as_u32() != me && pid.as_u32() > 4)
            .map(|(_, p)| (p.name().to_string_lossy().to_string(), p.cpu_usage() / n))
            .fold(None, |m: Option<(String, f32)>, x| if m.as_ref().map_or(true, |m| x.1 > m.1) { Some(x) } else { m });
        if let Some((name, pct)) = top {
            let key = format!("hog:{name}");
            // reset other hogs' streaks
            let keys: Vec<String> = st.streak.keys().filter(|k| k.starts_with("hog:") && **k != key).cloned().collect();
            for k in keys {
                st.streak.insert(k, 0);
            }
            if streak(&mut st, &key, pct >= lim) >= 12 {
                fire(&mut st, &key, "An app is hogging the CPU", &format!("{} has used {:.0}% of your CPU for a minute.", name.trim_end_matches(".exe"), pct));
            }
        }
    }
    if cfg.net_down && st.last_net.map_or(true, |t| t.elapsed() > Duration::from_secs(30)) {
        st.last_net = Some(Instant::now());
        std::thread::spawn(|| {
            let ok = ["1.1.1.1:443", "8.8.8.8:53", "9.9.9.9:443"].iter().any(|a| {
                std::net::TcpStream::connect_timeout(&a.parse().unwrap(), Duration::from_secs(3)).is_ok()
            });
            let prev = NET.load(Ordering::Relaxed);
            if ok {
                if prev == 3 {
                    show_toast("Back online", "Your internet connection is working again.", "ok");
                }
                NET.store(1, Ordering::Relaxed);
            } else if prev == 1 {
                NET.store(2, Ordering::Relaxed);
            } else if prev == 2 {
                NET.store(3, Ordering::Relaxed);
                show_toast("Internet is down", "Halo can't reach the internet. Check Wi-Fi or your router.", "warn");
            }
        });
    }
}
