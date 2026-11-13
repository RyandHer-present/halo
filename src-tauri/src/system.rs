//! Power actions, power modes, Wi-Fi/Bluetooth radios + Wi-Fi networks, accent color, wallpaper.

use base64::Engine;
use serde::Serialize;
use std::os::windows::process::CommandExt;
use std::process::Command;
use windows::core::GUID;
use windows::Devices::Radios::{Radio, RadioKind, RadioState};

const NO_WINDOW: u32 = 0x0800_0000;

pub fn run_hidden(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(cmd)
        .args(args)
        .creation_flags(NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() {
        Ok(text)
    } else {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        Err(if err.trim().is_empty() { text } else { err })
    }
}

// ---------- Power ----------

#[tauri::command]
pub async fn power_action(action: String) -> Result<(), String> {
    match action.as_str() {
        "lock" => unsafe { windows::Win32::System::Shutdown::LockWorkStation().map_err(|e| e.to_string()) },
        "sleep" => {
            unsafe { windows::Win32::System::Power::SetSuspendState(false, false, false) };
            Ok(())
        }
        "hibernate" => run_hidden("shutdown", &["/h"]).map(|_| ()),
        "shutdown" => run_hidden("shutdown", &["/s", "/t", "0"]).map(|_| ()),
        "restart" => run_hidden("shutdown", &["/r", "/t", "0"]).map(|_| ()),
        "signout" => run_hidden("shutdown", &["/l"]).map(|_| ()),
        _ => Err("unknown action".into()),
    }
}

/// The power-mode ("overlay") functions are exported by powrprof.dll but not in its import lib,
/// so resolve them at runtime.
fn powrprof_fn(name: &str) -> Option<unsafe extern "system" fn(*mut GUID) -> u32> {
    use windows::core::{s, PCSTR};
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};
    unsafe {
        let lib = LoadLibraryA(s!("powrprof.dll")).ok()?;
        let cname = std::ffi::CString::new(name).ok()?;
        let f = GetProcAddress(lib, PCSTR(cname.as_ptr() as *const u8))?;
        Some(std::mem::transmute::<_, unsafe extern "system" fn(*mut GUID) -> u32>(f))
    }
}

#[allow(non_snake_case)]
unsafe fn PowerGetEffectiveOverlayScheme(g: *mut GUID) -> u32 {
    powrprof_fn("PowerGetEffectiveOverlayScheme").map(|f| unsafe { f(g) }).unwrap_or(1)
}

#[allow(non_snake_case)]
unsafe fn PowerSetActiveOverlayScheme(g: *const GUID) -> u32 {
    powrprof_fn("PowerSetActiveOverlayScheme").map(|f| unsafe { f(g as *mut GUID) }).unwrap_or(1)
}

const MODE_EFFICIENCY: GUID = GUID::from_u128(0x961cc777_2547_4f9d_8174_7d86181b8a7a);
const MODE_BALANCED: GUID = GUID::from_u128(0);
const MODE_PERFORMANCE: GUID = GUID::from_u128(0xded574b5_45a0_4f42_8737_46345c09c238);

#[tauri::command]
pub async fn get_power_mode() -> String {
    let mut g = GUID::zeroed();
    unsafe { PowerGetEffectiveOverlayScheme(&mut g) };
    if g == MODE_EFFICIENCY {
        "efficiency"
    } else if g == MODE_PERFORMANCE {
        "performance"
    } else {
        "balanced"
    }
    .into()
}

#[tauri::command]
pub async fn set_power_mode(mode: String) -> Result<(), String> {
    let g = match mode.as_str() {
        "efficiency" => MODE_EFFICIENCY,
        "performance" => MODE_PERFORMANCE,
        _ => MODE_BALANCED,
    };
    let r = unsafe { PowerSetActiveOverlayScheme(&g) };
    if r == 0 { Ok(()) } else { Err(format!("error {r}")) }
}

// ---------- Radios ----------

#[derive(Serialize, Default)]
pub struct Radios {
    pub wifi: Option<bool>,
    pub bluetooth: Option<bool>,
}

fn radios_inner() -> windows::core::Result<Radios> {
    let _ = Radio::RequestAccessAsync()?.join();
    let list = Radio::GetRadiosAsync()?.join()?;
    let mut r = Radios::default();
    for radio in list {
        let on = radio.State()? == RadioState::On;
        match radio.Kind()? {
            RadioKind::WiFi => r.wifi = Some(on),
            RadioKind::Bluetooth => r.bluetooth = Some(on),
            _ => {}
        }
    }
    Ok(r)
}

#[tauri::command]
pub async fn get_radios() -> Result<Radios, String> {
    tauri::async_runtime::spawn_blocking(|| radios_inner().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_radio(kind: String, on: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> windows::core::Result<()> {
        let _ = Radio::RequestAccessAsync()?.join();
        let want = if kind == "wifi" { RadioKind::WiFi } else { RadioKind::Bluetooth };
        for radio in Radio::GetRadiosAsync()?.join()? {
            if radio.Kind()? == want {
                radio.SetStateAsync(if on { RadioState::On } else { RadioState::Off })?.join()?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

// ---------- Wi-Fi networks (netsh) ----------

#[derive(Serialize)]
pub struct WifiNet {
    pub ssid: String,
    pub signal: u32,
    pub secure: bool,
    pub known: bool,
    pub connected: bool,
}

fn after_colon(l: &str) -> String {
    l.split_once(':').map(|(_, v)| v.trim().to_string()).unwrap_or_default()
}

#[tauri::command]
pub async fn get_wifi() -> Result<Vec<WifiNet>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let current = run_hidden("netsh", &["wlan", "show", "interfaces"]).unwrap_or_default();
        let cur_ssid = current
            .lines()
            .find(|l| l.trim_start().starts_with("SSID") && !l.contains("BSSID"))
            .map(after_colon)
            .unwrap_or_default();
        let profiles = run_hidden("netsh", &["wlan", "show", "profiles"]).unwrap_or_default();
        let known: Vec<String> = profiles
            .lines()
            .filter(|l| l.contains("All User Profile") || l.contains("User Profile"))
            .map(after_colon)
            .collect();
        let text = run_hidden("netsh", &["wlan", "show", "networks", "mode=bssid"])?;
        let mut nets: Vec<WifiNet> = vec![];
        let mut cur: Option<WifiNet> = None;
        for l in text.lines() {
            let t = l.trim();
            if t.starts_with("SSID") && !t.starts_with("BSSID") {
                if let Some(n) = cur.take() {
                    nets.push(n);
                }
                let ssid = after_colon(t);
                cur = Some(WifiNet {
                    connected: !ssid.is_empty() && ssid == cur_ssid,
                    known: known.contains(&ssid),
                    ssid,
                    signal: 0,
                    secure: true,
                });
            } else if let Some(n) = cur.as_mut() {
                if t.starts_with("Authentication") {
                    n.secure = !after_colon(t).eq_ignore_ascii_case("Open");
                } else if t.starts_with("Signal") {
                    let s: u32 = after_colon(t).trim_end_matches('%').parse().unwrap_or(0);
                    n.signal = n.signal.max(s);
                }
            }
        }
        if let Some(n) = cur.take() {
            nets.push(n);
        }
        nets.retain(|n| !n.ssid.is_empty());
        nets.sort_by(|a, b| b.connected.cmp(&a.connected).then(b.signal.cmp(&a.signal)));
        Ok(nets)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

#[tauri::command]
pub async fn connect_wifi(ssid: String, password: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(pw) = password.filter(|p| !p.is_empty()) {
            // Create a WPA2 profile for a new network.
            let xml = format!(
                r#"<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>{n}</name>
  <SSIDConfig><SSID><name>{n}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType><connectionMode>auto</connectionMode>
  <MSM><security>
    <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>{p}</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>"#,
                n = xml_escape(&ssid),
                p = xml_escape(&pw)
            );
            let path = std::env::temp_dir().join("halo-wifi.xml");
            std::fs::write(&path, xml).map_err(|e| e.to_string())?;
            let r = run_hidden("netsh", &["wlan", "add", "profile", &format!("filename={}", path.display())]);
            let _ = std::fs::remove_file(&path);
            r?;
        }
        run_hidden("netsh", &["wlan", "connect", &format!("name={ssid}")]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn disconnect_wifi() -> Result<(), String> {
    run_hidden("netsh", &["wlan", "disconnect"]).map(|_| ())
}

// ---------- Look: accent + wallpaper ----------

#[tauri::command]
pub fn get_windows_accent() -> Option<String> {
    use windows::core::w;
    use windows::Win32::System::Registry::*;
    let mut v: u32 = 0;
    let mut len = 4u32;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\DWM"),
            w!("AccentColor"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut v as *mut _ as *mut _),
            Some(&mut len),
        )
        .ok()
        .ok()?;
    }
    // ABGR
    let (r, g, b) = (v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff);
    Some(format!("#{r:02x}{g:02x}{b:02x}"))
}

#[tauri::command]
pub async fn get_wallpaper() -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETDESKWALLPAPER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS};
    let mut buf = [0u16; 1024];
    unsafe {
        SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            buf.len() as u32,
            Some(buf.as_mut_ptr() as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .ok()?;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(0);
    let mut path = String::from_utf16_lossy(&buf[..len]);
    if path.is_empty() || !std::path::Path::new(&path).exists() {
        path = format!(r"{}\Microsoft\Windows\Themes\TranscodedWallpaper", std::env::var("APPDATA").ok()?);
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(path).ok()).await.ok().flatten()?;
    let mime = if bytes.starts_with(&[0x89, b'P']) {
        "image/png"
    } else if bytes.starts_with(b"BM") {
        "image/bmp"
    } else {
        "image/jpeg"
    };
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[tauri::command]
pub fn is_admin() -> bool {
    crate::launcher::is_elevated()
}

/// Register Halo to start at logon, elevated, without a UAC prompt (Task Scheduler, highest privileges).
#[tauri::command]
pub async fn set_autostart(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let args: Vec<String> = if enabled {
        vec![
            "/create".into(), "/f".into(), "/tn".into(), "Halo".into(), "/sc".into(), "onlogon".into(),
            "/rl".into(), "highest".into(), "/tr".into(), format!("\"{}\" --hidden", exe.display()),
        ]
    } else {
        vec!["/delete".into(), "/f".into(), "/tn".into(), "Halo".into()]
    };
    if crate::launcher::is_elevated() {
        let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_hidden("schtasks", &a).map(|_| ())
    } else {
        // Ask for elevation once via PowerShell's RunAs.
        let joined = args.iter().map(|a| format!("'{}'", a.replace('\'', "''"))).collect::<Vec<_>>().join(",");
        let ps = format!("Start-Process schtasks -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList {joined}");
        run_hidden("powershell", &["-NoProfile", "-Command", &ps]).map(|_| ())
    }
}

#[tauri::command]
pub async fn get_autostart() -> bool {
    run_hidden("schtasks", &["/query", "/tn", "Halo"]).is_ok()
}
