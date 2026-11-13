//! Task manager: processes, services, startup apps and installed programs.

use crate::stats::StatsWorker;
use crate::system::run_hidden;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::os::windows::process::CommandExt;
use winreg::enums::*;
use winreg::RegKey;

#[derive(Serialize, Clone)]
pub struct Proc {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    pub exe: Option<String>,
    pub cpu: f32,
    pub mem: u64,
    pub disk_read: u64,
    pub disk_write: u64,
    pub start: u64,
    pub window: Option<String>,
}

/// pid -> title of its main visible window (these are the "apps", like Task Manager shows).
fn window_titles() -> HashMap<u32, String> {
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::*;
    unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> windows::core::BOOL {
        unsafe {
            let map = &mut *(l.0 as *mut HashMap<u32, String>);
            if !IsWindowVisible(h).as_bool() || GetWindow(h, GW_OWNER).map(|o| !o.is_invalid()).unwrap_or(false) {
                return true.into();
            }
            let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
            if ex & WS_EX_TOOLWINDOW.0 != 0 {
                return true.into();
            }
            let mut buf = [0u16; 256];
            let n = GetWindowTextW(h, &mut buf);
            if n > 0 {
                let mut pid = 0u32;
                GetWindowThreadProcessId(h, Some(&mut pid));
                map.entry(pid).or_insert_with(|| String::from_utf16_lossy(&buf[..n as usize]));
            }
            true.into()
        }
    }
    let mut map: HashMap<u32, String> = HashMap::new();
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut map as *mut _ as isize));
    }
    map.remove(&std::process::id());
    map
}

#[tauri::command]
pub async fn get_processes(state: tauri::State<'_, StatsWorker>) -> Result<Vec<Proc>, String> {
    let titles = window_titles();
    state
        .run(move |s| {
            let fresh = s.procs_refreshed.map_or(true, |t| t.elapsed().as_millis() >= 900);
            let secs = s.procs_refreshed.map(|t| t.elapsed().as_secs_f64()).unwrap_or(1.0).max(0.2);
            if fresh {
                s.sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
                s.procs_refreshed = Some(std::time::Instant::now());
            }
            let n = s.sys.cpus().len().max(1) as f32;
            s.sys
                .processes()
                .iter()
                .map(|(pid, p)| {
                    let d = p.disk_usage();
                    let pid = pid.as_u32();
                    Proc {
                        pid,
                        parent: p.parent().map(|x| x.as_u32()),
                        name: p.name().to_string_lossy().to_string(),
                        exe: p.exe().map(|e| e.to_string_lossy().to_string()),
                        cpu: p.cpu_usage() / n,
                        mem: p.memory(),
                        disk_read: (d.read_bytes as f64 / secs) as u64,
                        disk_write: (d.written_bytes as f64 / secs) as u64,
                        start: p.start_time(),
                        window: titles.get(&pid).cloned(),
                    }
                })
                .collect()
        })
        .await
}

#[tauri::command]
pub fn kill_process(pid: u32, tree: Option<bool>) -> Result<(), String> {
    let pid_s = pid.to_string();
    let mut args = vec!["/PID", &pid_s, "/F"];
    if tree.unwrap_or(false) {
        args.push("/T");
    }
    run_hidden("taskkill", &args).map(|_| ())
}

/// Kill every process with this image name (e.g. "chrome.exe"). Returns how many matched.
#[tauri::command]
pub fn kill_by_name(name: &str) -> Result<String, String> {
    let mut n = name.to_string();
    if !n.to_lowercase().ends_with(".exe") {
        n.push_str(".exe");
    }
    run_hidden("taskkill", &["/IM", &n, "/F", "/T"])
}

#[tauri::command]
pub fn set_priority(pid: u32, level: String) -> Result<(), String> {
    let class = match level.as_str() {
        "low" => "64",
        "below" => "16384",
        "normal" => "32",
        "above" => "32768",
        "high" => "128",
        _ => return Err("unknown priority".into()),
    };
    run_hidden(
        "powershell",
        &["-NoProfile", "-Command", &format!("(Get-Process -Id {pid}).PriorityClass = [System.Diagnostics.ProcessPriorityClass]{class}")],
    )
    .map(|_| ())
}

#[tauri::command]
pub fn open_location(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .raw_arg(format!("/select,\"{}\"", path))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ---------------- services ----------------

#[derive(Serialize, Clone)]
pub struct Service {
    pub name: String,
    pub display: String,
    pub state: String,
    pub start_mode: String,
    pub pid: u32,
    pub description: String,
}

#[tauri::command]
pub async fn get_services(state: tauri::State<'_, StatsWorker>) -> Result<Vec<Service>, String> {
    state
        .run(|s| {
            use wmi::Variant;
            if s.cimv2.is_none() {
                s.cimv2 = wmi::WMIConnection::new().ok();
            }
            let Some(con) = s.cimv2.as_ref() else { return Err("WMI unavailable".to_string()) };
            let rows: Vec<HashMap<String, Variant>> = con
                .raw_query("SELECT Name, DisplayName, State, StartMode, ProcessId, Description FROM Win32_Service")
                .map_err(|e| e.to_string())?;
            let txt = |r: &HashMap<String, Variant>, k: &str| match r.get(k) {
                Some(Variant::String(s)) => s.clone(),
                _ => String::new(),
            };
            let mut out: Vec<Service> = rows
                .iter()
                .map(|r| Service {
                    name: txt(r, "Name"),
                    display: txt(r, "DisplayName"),
                    state: txt(r, "State"),
                    start_mode: txt(r, "StartMode"),
                    pid: match r.get("ProcessId") {
                        Some(Variant::UI4(p)) => *p,
                        Some(Variant::I4(p)) => *p as u32,
                        _ => 0,
                    },
                    description: txt(r, "Description"),
                })
                .collect();
            out.sort_by(|a, b| a.display.to_lowercase().cmp(&b.display.to_lowercase()));
            Ok(out)
        })
        .await?
}

#[tauri::command]
pub async fn service_action(name: String, action: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "start" => run_hidden("sc.exe", &["start", &name]),
        "stop" => run_hidden("sc.exe", &["stop", &name]),
        "restart" => {
            let _ = run_hidden("powershell", &["-NoProfile", "-Command", &format!("Restart-Service -Name '{}' -Force", name.replace('\'', "''"))]);
            Ok(String::new())
        }
        "auto" | "demand" | "disabled" | "delayed-auto" => run_hidden("sc.exe", &["config", &name, "start=", &action]),
        _ => Err("unknown action".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------- startup apps ----------------

#[derive(Serialize, Clone)]
pub struct StartupItem {
    pub id: String, // "<scope>|<location>|<name>"
    pub name: String,
    pub command: String,
    pub path: Option<String>,
    pub enabled: bool,
    pub location: String,
}

const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN32: &str = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run";
const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved";

/// The exe inside a command line like `"C:\x\app.exe" --min` or `C:\x\app.exe -s`.
pub fn exe_from_command(cmd: &str) -> Option<String> {
    let c = cmd.trim();
    if let Some(rest) = c.strip_prefix('"') {
        return rest.split('"').next().map(|s| s.to_string());
    }
    let lower = c.to_lowercase();
    if let Some(i) = lower.find(".exe") {
        return Some(c[..i + 4].to_string());
    }
    c.split_whitespace().next().map(|s| s.to_string())
}

fn approved(root: &RegKey, sub: &str, name: &str) -> bool {
    root.open_subkey(format!(r"{APPROVED}\{sub}"))
        .and_then(|k| k.get_raw_value(name))
        .map(|v| v.bytes.first().map_or(true, |b| b % 2 == 0))
        .unwrap_or(true)
}

fn startup_folders() -> Vec<(String, std::path::PathBuf)> {
    let mut v = vec![];
    if let Ok(a) = std::env::var("APPDATA") {
        v.push(("user".to_string(), std::path::PathBuf::from(a).join(r"Microsoft\Windows\Start Menu\Programs\Startup")));
    }
    if let Ok(a) = std::env::var("PROGRAMDATA") {
        v.push(("machine".to_string(), std::path::PathBuf::from(a).join(r"Microsoft\Windows\Start Menu\Programs\StartUp")));
    }
    v
}

#[tauri::command]
pub fn get_startup() -> Vec<StartupItem> {
    let mut out = vec![];
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    for (scope, root, key, approved_sub) in [("user", &hkcu, RUN, "Run"), ("machine", &hklm, RUN, "Run"), ("machine32", &hklm, RUN32, "Run32")] {
        let Ok(k) = root.open_subkey(key) else { continue };
        for (name, _) in k.enum_values().flatten() {
            let command: String = k.get_value(&name).unwrap_or_default();
            if command.is_empty() {
                continue;
            }
            out.push(StartupItem {
                id: format!("{scope}|reg|{name}"),
                enabled: approved(root, approved_sub, &name),
                path: exe_from_command(&command),
                command,
                location: if scope == "user" { "Registry (you)".into() } else { "Registry (all users)".into() },
                name,
            });
        }
    }
    for (scope, dir) in startup_folders() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let root = if scope == "user" { &hkcu } else { &hklm };
        for e in rd.flatten() {
            let file = e.file_name().to_string_lossy().to_string();
            if file.eq_ignore_ascii_case("desktop.ini") {
                continue;
            }
            let full = e.path().to_string_lossy().to_string();
            out.push(StartupItem {
                id: format!("{scope}|folder|{file}"),
                name: file.trim_end_matches(".lnk").to_string(),
                enabled: approved(root, "StartupFolder", &file),
                path: Some(full.clone()),
                command: full,
                location: "Startup folder".into(),
            });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[tauri::command]
pub fn set_startup(id: String, enabled: bool) -> Result<(), String> {
    let mut parts = id.splitn(3, '|');
    let (scope, kind, name) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let root = RegKey::predef(if scope == "user" { HKEY_CURRENT_USER } else { HKEY_LOCAL_MACHINE });
    let sub = match (kind, scope) {
        ("folder", _) => "StartupFolder",
        (_, "machine32") => "Run32",
        _ => "Run",
    };
    let (k, _) = root.create_subkey(format!(r"{APPROVED}\{sub}")).map_err(|e| e.to_string())?;
    let mut bytes = vec![if enabled { 2u8 } else { 3u8 }, 0, 0, 0];
    let ft: u64 = if enabled {
        0
    } else {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        (now.as_secs() + 11_644_473_600) * 10_000_000
    };
    bytes.extend_from_slice(&ft.to_le_bytes());
    k.set_raw_value(name, &winreg::RegValue { bytes: bytes.into(), vtype: REG_BINARY }).map_err(|e| e.to_string())
}

// ---------------- installed programs ----------------

#[derive(Serialize, Clone)]
pub struct Program {
    pub id: String,
    pub name: String,
    pub publisher: String,
    pub version: String,
    pub size: u64,
    pub installed: String,
    pub icon: Option<String>,
    pub uninstall: String,
    pub kind: String, // "win32" | "store"
}

#[tauri::command]
pub async fn get_programs() -> Result<Vec<Program>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out = vec![];
        let mut seen = HashSet::new();
        let roots = [
            (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
            (HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        ];
        for (hive, path) in roots {
            let Ok(k) = RegKey::predef(hive).open_subkey(path) else { continue };
            for sub in k.enum_keys().flatten() {
                let Ok(e) = k.open_subkey(&sub) else { continue };
                let name: String = e.get_value("DisplayName").unwrap_or_default();
                let uninstall: String = e.get_value("UninstallString").unwrap_or_default();
                let system: u32 = e.get_value("SystemComponent").unwrap_or(0);
                let parent: String = e.get_value("ParentKeyName").unwrap_or_default();
                if name.trim().is_empty() || uninstall.is_empty() || system == 1 || !parent.is_empty() {
                    continue;
                }
                let version: String = e.get_value("DisplayVersion").unwrap_or_default();
                if !seen.insert(format!("{name}|{version}")) {
                    continue;
                }
                let icon: String = e.get_value("DisplayIcon").unwrap_or_default();
                let icon = icon.trim().trim_matches('"').split(',').next().unwrap_or("").trim_matches('"').to_string();
                let date: String = e.get_value("InstallDate").unwrap_or_default();
                let size: u32 = e.get_value("EstimatedSize").unwrap_or(0);
                out.push(Program {
                    id: format!("{}|{}", if hive == HKEY_CURRENT_USER { "cu" } else { "lm" }, sub),
                    name: name.trim().to_string(),
                    publisher: e.get_value::<String, _>("Publisher").unwrap_or_default(),
                    version,
                    size: size as u64 * 1024,
                    installed: if date.len() == 8 { format!("{}-{}-{}", &date[..4], &date[4..6], &date[6..]) } else { String::new() },
                    icon: if icon.to_lowercase().ends_with(".exe") || icon.to_lowercase().ends_with(".ico") { Some(icon) } else { None },
                    uninstall,
                    kind: "win32".into(),
                });
            }
        }
        // Microsoft Store apps
        if let Ok(json) = run_hidden(
            "powershell",
            &["-NoProfile", "-Command", "Get-AppxPackage -PackageTypeFilter Main | ? { -not $_.NonRemovable -and $_.SignatureKind -eq 'Store' } | select Name,PackageFullName,Version,Publisher | ConvertTo-Json -Compress"],
        ) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(json.trim()) {
                let arr = if v.is_array() { v.as_array().cloned().unwrap_or_default() } else { vec![v] };
                for a in arr {
                    let raw = a["Name"].as_str().unwrap_or_default();
                    let pretty = pretty_appx(raw);
                    if raw.is_empty() || pretty.len() < 3 || pretty.chars().all(|c| c.is_ascii_hexdigit()) {
                        continue;
                    }
                    out.push(Program {
                        id: format!("appx|{}", a["PackageFullName"].as_str().unwrap_or_default()),
                        name: pretty,
                        publisher: a["Publisher"].as_str().unwrap_or_default().split(',').next().unwrap_or("").trim_start_matches("CN=").to_string(),
                        version: a["Version"].as_str().unwrap_or_default().to_string(),
                        size: 0,
                        installed: String::new(),
                        icon: None,
                        uninstall: String::new(),
                        kind: "store".into(),
                    });
                }
            }
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        out
    })
    .await
    .map_err(|e| e.to_string())
}

/// "Microsoft.WindowsCalculator" -> "Windows Calculator"
fn pretty_appx(raw: &str) -> String {
    let last = raw.rsplit('.').next().unwrap_or(raw);
    let mut s = String::new();
    let chars: Vec<char> = last.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if i > 0 && c.is_uppercase() && (chars[i - 1].is_lowercase() || chars.get(i + 1).map_or(false, |n| n.is_lowercase()) && chars[i - 1].is_uppercase()) {
            s.push(' ');
        }
        s.push(*c);
    }
    s
}

#[tauri::command]
pub fn uninstall_program(id: String, uninstall: String) -> Result<(), String> {
    if let Some(full) = id.strip_prefix("appx|") {
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &format!("Remove-AppxPackage -Package '{}'", full.replace('\'', "''"))])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let mut cmd = uninstall.trim().to_string();
    // MsiExec /I{GUID} opens the repair UI; /X uninstalls.
    if cmd.to_lowercase().starts_with("msiexec") {
        cmd = cmd.replace("/I{", "/X{").replace("/i{", "/X{");
    }
    std::process::Command::new("cmd")
        .raw_arg(format!("/C \"{}\"", cmd))
        .creation_flags(0x0800_0000)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
