//! Display (resolution, refresh rate, scaling, HDR), mouse, keyboard and default apps.
#![allow(non_snake_case)]

use serde::Serialize;
use windows::core::PCWSTR;
use windows::Win32::Devices::Display::*;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use winreg::enums::*;
use winreg::RegKey;

#[derive(Serialize, Clone, PartialEq)]
pub struct Mode {
    pub width: u32,
    pub height: u32,
    pub hz: u32,
}

#[derive(Serialize)]
pub struct DisplayInfo {
    pub device: String,
    pub name: String,
    pub current: Mode,
    pub modes: Vec<Mode>,
    pub scale: Option<u32>,
    pub scales: Vec<u32>,
    pub hdr_supported: bool,
    pub hdr_on: bool,
    pub primary: bool,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
fn from_wide(w: &[u16]) -> String {
    String::from_utf16_lossy(&w[..w.iter().position(|&c| c == 0).unwrap_or(w.len())])
}

fn devmode() -> DEVMODEW {
    DEVMODEW { dmSize: std::mem::size_of::<DEVMODEW>() as u16, ..Default::default() }
}

// ---- DisplayConfig helpers (HDR + scaling) ----

struct Path {
    adapter: LUID,
    source_id: u32,
    target_id: u32,
    gdi: String,
}

fn active_paths() -> Vec<Path> {
    unsafe {
        let (mut np, mut nm) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm) != ERROR_SUCCESS {
            return vec![];
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); np as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); nm as usize];
        if QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &mut np, paths.as_mut_ptr(), &mut nm, modes.as_mut_ptr(), None) != ERROR_SUCCESS {
            return vec![];
        }
        paths.truncate(np as usize);
        paths
            .iter()
            .map(|p| {
                let mut src = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
                src.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
                src.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
                src.header.adapterId = p.sourceInfo.adapterId;
                src.header.id = p.sourceInfo.id;
                DisplayConfigGetDeviceInfo(&mut src.header);
                Path { adapter: p.targetInfo.adapterId, source_id: p.sourceInfo.id, target_id: p.targetInfo.id, gdi: from_wide(&src.viewGdiDeviceName) }
            })
            .collect()
    }
}

fn monitor_name(p: &Path) -> String {
    unsafe {
        let mut t = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
        t.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
        t.header.size = std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
        t.header.adapterId = p.adapter;
        t.header.id = p.target_id;
        DisplayConfigGetDeviceInfo(&mut t.header);
        let n = from_wide(&t.monitorFriendlyDeviceName);
        if n.is_empty() { "Built-in display".into() } else { n }
    }
}

fn hdr_state(p: &Path) -> (bool, bool) {
    unsafe {
        let mut i = DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO::default();
        i.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO;
        i.header.size = std::mem::size_of::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>() as u32;
        i.header.adapterId = p.adapter;
        i.header.id = p.target_id;
        if DisplayConfigGetDeviceInfo(&mut i.header) != 0 {
            return (false, false);
        }
        let v = i.Anonymous.value;
        (v & 1 != 0, v & 2 != 0)
    }
}

// Undocumented but widely used: per-monitor DPI scale relative to the recommended one.
#[repr(C)]
struct DpiGet {
    header: DISPLAYCONFIG_DEVICE_INFO_HEADER,
    min_rel: i32,
    cur_rel: i32,
    max_rel: i32,
}
#[repr(C)]
struct DpiSet {
    header: DISPLAYCONFIG_DEVICE_INFO_HEADER,
    rel: i32,
}
const DPI_VALUES: [u32; 12] = [100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500];

fn dpi_get(p: &Path) -> Option<(u32, Vec<u32>, i32)> {
    unsafe {
        let mut g = DpiGet { header: DISPLAYCONFIG_DEVICE_INFO_HEADER::default(), min_rel: 0, cur_rel: 0, max_rel: 0 };
        g.header.r#type = DISPLAYCONFIG_DEVICE_INFO_TYPE(-3);
        g.header.size = std::mem::size_of::<DpiGet>() as u32;
        g.header.adapterId = p.adapter;
        g.header.id = p.source_id;
        if DisplayConfigGetDeviceInfo(&mut g.header) != 0 {
            return None;
        }
        let rec = g.min_rel.unsigned_abs() as i32;
        let cur = (rec + g.cur_rel).clamp(0, DPI_VALUES.len() as i32 - 1);
        let max = (rec + g.max_rel).clamp(0, DPI_VALUES.len() as i32 - 1);
        Some((DPI_VALUES[cur as usize], DPI_VALUES[..=max as usize].to_vec(), rec))
    }
}

#[tauri::command]
pub fn get_displays() -> Vec<DisplayInfo> {
    let paths = active_paths();
    let mut out = vec![];
    unsafe {
        let mut i = 0u32;
        loop {
            let mut dd = DISPLAY_DEVICEW { cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
            if !EnumDisplayDevicesW(PCWSTR::null(), i, &mut dd, 0).as_bool() {
                break;
            }
            i += 1;
            if (dd.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP).0 == 0 {
                continue;
            }
            let dev = from_wide(&dd.DeviceName);
            let w = wide(&dev);
            let mut cur = devmode();
            if !EnumDisplaySettingsW(PCWSTR(w.as_ptr()), ENUM_CURRENT_SETTINGS, &mut cur).as_bool() {
                continue;
            }
            let mut modes: Vec<Mode> = vec![];
            let mut k = 0u32;
            loop {
                let mut m = devmode();
                if !EnumDisplaySettingsW(PCWSTR(w.as_ptr()), ENUM_DISPLAY_SETTINGS_MODE(k), &mut m).as_bool() {
                    break;
                }
                k += 1;
                if m.dmBitsPerPel != 32 {
                    continue;
                }
                let md = Mode { width: m.dmPelsWidth, height: m.dmPelsHeight, hz: m.dmDisplayFrequency };
                if !modes.contains(&md) {
                    modes.push(md);
                }
            }
            modes.sort_by(|a, b| (b.width * b.height).cmp(&(a.width * a.height)).then(b.hz.cmp(&a.hz)));
            let path = paths.iter().find(|p| p.gdi == dev);
            let (hdr_supported, hdr_on) = path.map(hdr_state).unwrap_or((false, false));
            let dpi = path.and_then(dpi_get);
            out.push(DisplayInfo {
                name: path.map(monitor_name).unwrap_or_else(|| from_wide(&dd.DeviceString)),
                device: dev,
                current: Mode { width: cur.dmPelsWidth, height: cur.dmPelsHeight, hz: cur.dmDisplayFrequency },
                modes,
                scale: dpi.as_ref().map(|d| d.0),
                scales: dpi.map(|d| d.1).unwrap_or_default(),
                hdr_supported,
                hdr_on,
                primary: (dd.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE).0 != 0,
            });
        }
    }
    out
}

#[tauri::command]
pub fn set_display_mode(device: String, width: u32, height: u32, hz: u32) -> Result<(), String> {
    unsafe {
        let w = wide(&device);
        let mut m = devmode();
        m.dmPelsWidth = width;
        m.dmPelsHeight = height;
        m.dmDisplayFrequency = hz;
        m.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;
        let r = ChangeDisplaySettingsExW(PCWSTR(w.as_ptr()), Some(&m), None, CDS_UPDATEREGISTRY, None);
        if r == DISP_CHANGE_SUCCESSFUL { Ok(()) } else { Err(format!("Windows refused that mode ({})", r.0)) }
    }
}

#[tauri::command]
pub fn set_hdr(device: String, on: bool) -> Result<(), String> {
    let paths = active_paths();
    let p = paths.iter().find(|p| p.gdi == device).ok_or("display not found")?;
    unsafe {
        let mut s = DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE::default();
        s.header.r#type = DISPLAYCONFIG_DEVICE_INFO_SET_ADVANCED_COLOR_STATE;
        s.header.size = std::mem::size_of::<DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE>() as u32;
        s.header.adapterId = p.adapter;
        s.header.id = p.target_id;
        s.Anonymous.value = if on { 1 } else { 0 };
        let r = DisplayConfigSetDeviceInfo(&s.header);
        if r == 0 { Ok(()) } else { Err(format!("HDR change failed ({r})")) }
    }
}

#[tauri::command]
pub fn set_scale(device: String, scale: u32) -> Result<(), String> {
    let paths = active_paths();
    let p = paths.iter().find(|p| p.gdi == device).ok_or("display not found")?;
    let (_, _, rec) = dpi_get(p).ok_or("scaling not available")?;
    let idx = DPI_VALUES.iter().position(|&v| v == scale).ok_or("unsupported scale")? as i32;
    unsafe {
        let mut s = DpiSet { header: DISPLAYCONFIG_DEVICE_INFO_HEADER::default(), rel: idx - rec };
        s.header.r#type = DISPLAYCONFIG_DEVICE_INFO_TYPE(-4);
        s.header.size = std::mem::size_of::<DpiSet>() as u32;
        s.header.adapterId = p.adapter;
        s.header.id = p.source_id;
        let r = DisplayConfigSetDeviceInfo(&s.header);
        if r == 0 { Ok(()) } else { Err(format!("scale change failed ({r})")) }
    }
}

// ---- mouse + keyboard ----

#[derive(Serialize)]
pub struct Input {
    pub mouse_speed: u32,      // 1..20
    pub precision: bool,       // "enhance pointer precision"
    pub swap_buttons: bool,
    pub scroll_lines: u32,
    pub double_click_ms: u32,
    pub key_delay: u32,        // 0..3
    pub key_speed: u32,        // 0..31
    pub caret_blink_ms: u32,
}

const UPD: SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS = SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(SPIF_UPDATEINIFILE.0 | SPIF_SENDCHANGE.0);

fn spi_get_u32(action: SYSTEM_PARAMETERS_INFO_ACTION) -> u32 {
    let mut v = 0u32;
    unsafe {
        let _ = SystemParametersInfoW(action, 0, Some(&mut v as *mut _ as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0));
    }
    v
}

#[tauri::command]
pub fn get_input() -> Input {
    unsafe {
        let mut accel = [0i32; 3];
        let _ = SystemParametersInfoW(SPI_GETMOUSE, 0, Some(accel.as_mut_ptr() as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0));
        Input {
            mouse_speed: spi_get_u32(SPI_GETMOUSESPEED),
            precision: accel[2] != 0,
            swap_buttons: GetSystemMetrics(SM_SWAPBUTTON) != 0,
            scroll_lines: spi_get_u32(SPI_GETWHEELSCROLLLINES),
            double_click_ms: windows::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime(),
            key_delay: spi_get_u32(SPI_GETKEYBOARDDELAY),
            key_speed: spi_get_u32(SPI_GETKEYBOARDSPEED),
            caret_blink_ms: GetCaretBlinkTime(),
        }
    }
}

#[tauri::command]
pub fn set_input(key: String, value: u32) -> Result<(), String> {
    unsafe {
        let r = match key.as_str() {
            "mouse_speed" => SystemParametersInfoW(SPI_SETMOUSESPEED, 0, Some(value.clamp(1, 20) as usize as *mut _), UPD),
            "precision" => {
                let mut a: [i32; 3] = if value != 0 { [6, 10, 1] } else { [0, 0, 0] };
                SystemParametersInfoW(SPI_SETMOUSE, 0, Some(a.as_mut_ptr() as *mut _), UPD)
            }
            "swap_buttons" => SystemParametersInfoW(SPI_SETMOUSEBUTTONSWAP, value, None, UPD),
            "scroll_lines" => SystemParametersInfoW(SPI_SETWHEELSCROLLLINES, value, None, UPD),
            "double_click_ms" => SystemParametersInfoW(SPI_SETDOUBLECLICKTIME, value, None, UPD),
            "key_delay" => SystemParametersInfoW(SPI_SETKEYBOARDDELAY, value.min(3), None, UPD),
            "key_speed" => SystemParametersInfoW(SPI_SETKEYBOARDSPEED, value.min(31), None, UPD),
            "caret_blink_ms" => SetCaretBlinkTime(value).map(|_| {
                let _ = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(r"Control Panel\Desktop", KEY_SET_VALUE).and_then(|k| k.set_value("CursorBlinkRate", &value.to_string()));
            }),
            _ => return Err("unknown setting".into()),
        };
        r.map_err(|e| e.to_string())
    }
}

// ---- default apps (read-only; Windows only lets the user change them in Settings) ----

#[derive(Serialize)]
pub struct DefaultApp {
    pub kind: String,
    pub label: String,
    pub app: String,
}

/// The friendly name Windows itself shows for the default handler (resolves Store apps too).
fn assoc_name(assoc: &str, protocol: bool) -> Option<String> {
    use windows::Win32::UI::Shell::{AssocQueryStringW, ASSOCF_INIT_IGNOREUNKNOWN, ASSOCF_IS_PROTOCOL, ASSOCF_NONE, ASSOCSTR_FRIENDLYAPPNAME};
    let wide: Vec<u16> = assoc.encode_utf16().chain(Some(0)).collect();
    let mut buf = [0u16; 260];
    let mut len = buf.len() as u32;
    let flags = (if protocol { ASSOCF_IS_PROTOCOL } else { ASSOCF_NONE }) | ASSOCF_INIT_IGNOREUNKNOWN;
    let hr = unsafe { AssocQueryStringW(flags, ASSOCSTR_FRIENDLYAPPNAME, PCWSTR(wide.as_ptr()), PCWSTR::null(), Some(windows::core::PWSTR(buf.as_mut_ptr())), &mut len) };
    if hr.is_err() {
        return None;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let n = String::from_utf16_lossy(&buf[..end]).trim().to_string();
    (!n.is_empty() && !n.contains("OpenWith") && !n.eq_ignore_ascii_case("pick an app")).then_some(n)
}

fn prog_name(progid: &str) -> String {
    if progid.is_empty() {
        return "Not set".into();
    }
    let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
    if let Ok(k) = hkcr.open_subkey(format!(r"{progid}\Application")) {
        if let Ok(n) = k.get_value::<String, _>("ApplicationName") {
            if !n.starts_with('@') {
                return n;
            }
        }
    }
    if let Ok(k) = hkcr.open_subkey(format!(r"{progid}\shell\open\command")) {
        if let Ok(cmd) = k.get_value::<String, _>("") {
            if let Some(exe) = crate::procs::exe_from_command(&cmd) {
                return crate::icons::pretty_exe_name(&exe);
            }
        }
    }
    if let Ok(n) = hkcr.open_subkey(progid).and_then(|k| k.get_value::<String, _>("")) {
        if !n.is_empty() && !n.starts_with('@') {
            return n;
        }
    }
    let p = progid.split(|c| c == '.' || c == '-').next().unwrap_or(progid);
    match p {
        "ChromeHTML" => "Google Chrome".into(),
        "MSEdgeHTM" | "MSEdgePDF" => "Microsoft Edge".into(),
        "FirefoxURL" | "FirefoxHTML" | "FirefoxPDF" => "Firefox".into(),
        "BraveHTML" => "Brave".into(),
        "AppX" => "Store app".into(),
        _ => p.to_string(),
    }
}

#[tauri::command]
pub fn get_default_apps() -> Vec<DefaultApp> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let url = |proto: &str| {
        hkcu.open_subkey(format!(r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\{proto}\UserChoice"))
            .and_then(|k| k.get_value::<String, _>("ProgId"))
            .unwrap_or_default()
    };
    let ext = |e: &str| {
        hkcu.open_subkey(format!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{e}\UserChoice"))
            .and_then(|k| k.get_value::<String, _>("ProgId"))
            .or_else(|_| RegKey::predef(HKEY_CLASSES_ROOT).open_subkey(e).and_then(|k| k.get_value::<String, _>("")))
            .unwrap_or_default()
    };
    let mut v = vec![
        DefaultApp { kind: "https".into(), label: "Web browser".into(), app: assoc_name("https", true).unwrap_or_else(|| prog_name(&url("https"))) },
        DefaultApp { kind: "mailto".into(), label: "Email".into(), app: assoc_name("mailto", true).unwrap_or_else(|| prog_name(&url("mailto"))) },
    ];
    for (e, label) in [(".pdf", "PDF"), (".jpg", "Photos"), (".png", "PNG images"), (".mp4", "Videos"), (".mp3", "Music"), (".txt", "Text files"), (".zip", "Zip files"), (".html", "HTML files")] {
        v.push(DefaultApp { kind: e.into(), label: label.into(), app: { let id = ext(e); assoc_name(e, false).filter(|n| *n != id && !n.starts_with("AppX")).unwrap_or_else(|| prog_name(&id)) } });
    }
    v
}

/// Opens Windows' own "Open with" picker for a file type, where "Always" sets the default.
#[tauri::command]
pub fn change_default_app(kind: String) -> Result<(), String> {
    if !kind.starts_with('.') {
        return crate::launcher::shell_open("ms-settings:defaultapps", "");
    }
    // A throwaway file of that type, so the picker knows what it's for.
    let p = std::env::temp_dir().join(format!("Halo sample{kind}"));
    let _ = std::fs::write(&p, b"");
    std::process::Command::new("rundll32.exe")
        .args(["shell32.dll,OpenAs_RunDLL", &p.to_string_lossy()])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[allow(dead_code)]
fn _unused(_: HWND) {}
