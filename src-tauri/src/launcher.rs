//! Game library (Steam + Prism Launcher instances), Start-menu app list, and launching.
//! Halo runs elevated, so everything is launched *unelevated* through Explorer's shell
//! (otherwise Steam/Minecraft would inherit admin rights).

use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct Game {
    pub id: String,
    pub name: String,
    pub source: String,      // "steam" | "prism"
    pub art: Option<String>, // file path to cover art (load via read_image)
    pub subtitle: String,
    pub last_played: u64, // unix secs
}

#[derive(Serialize, Clone)]
pub struct StartApp {
    pub name: String,
    pub path: String,
}

// ---------- Steam ----------

fn steam_path() -> Option<PathBuf> {
    use windows::Win32::System::Registry::*;
    use windows::core::w;
    let mut buf = [0u16; 512];
    let mut len = (buf.len() * 2) as u32;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Valve\\Steam"),
            w!("SteamPath"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut len),
        )
        .ok()
        .ok()?;
    }
    let s = String::from_utf16_lossy(&buf[..(len as usize / 2).saturating_sub(1)]);
    Some(PathBuf::from(s.replace('/', "\\")))
}

/// Pull `"key"  "value"` pairs out of a VDF/ACF file (flat, good enough for what we need).
fn vdf_values(text: &str, key: &str) -> Vec<String> {
    let needle = format!("\"{}\"", key.to_lowercase());
    text.lines()
        .filter_map(|l| {
            let t = l.trim();
            if !t.to_lowercase().starts_with(&needle) {
                return None;
            }
            let rest = t[needle.len()..].trim();
            let v = rest.trim_matches('"');
            Some(v.replace("\\\\", "\\"))
        })
        .collect()
}

fn find_steam_art(steam: &Path, appid: &str) -> Option<String> {
    let base = steam.join("appcache").join("librarycache");
    // Old layout: librarycache/{appid}_library_600x900.jpg
    let flat = base.join(format!("{appid}_library_600x900.jpg"));
    if flat.exists() {
        return Some(flat.to_string_lossy().into());
    }
    // New layout: librarycache/{appid}/library_600x900.jpg or {appid}/<hash>/library_600x900.jpg
    let dir = base.join(appid);
    let direct = dir.join("library_600x900.jpg");
    if direct.exists() {
        return Some(direct.to_string_lossy().into());
    }
    for e in std::fs::read_dir(&dir).ok()?.flatten() {
        let p = e.path().join("library_600x900.jpg");
        if p.exists() {
            return Some(p.to_string_lossy().into());
        }
    }
    None
}

fn steam_games() -> Vec<Game> {
    let Some(steam) = steam_path() else { return vec![] };
    let lf = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf")).unwrap_or_default();
    let mut libs: Vec<PathBuf> = vdf_values(&lf, "path").into_iter().map(PathBuf::from).collect();
    if libs.is_empty() {
        libs.push(steam.clone());
    }
    let skip = ["228980", "1070560", "1391110", "1628350", "1493710"]; // redistributables / runtimes
    let mut out = vec![];
    for lib in libs {
        let Ok(rd) = std::fs::read_dir(lib.join("steamapps")) else { continue };
        for e in rd.flatten() {
            let fname = e.file_name().to_string_lossy().to_string();
            if !fname.starts_with("appmanifest_") || !fname.ends_with(".acf") {
                continue;
            }
            let Ok(t) = std::fs::read_to_string(e.path()) else { continue };
            let Some(appid) = vdf_values(&t, "appid").into_iter().next() else { continue };
            if skip.contains(&appid.as_str()) {
                continue;
            }
            let name = vdf_values(&t, "name").into_iter().next().unwrap_or_else(|| appid.clone());
            if name.to_lowercase().contains("redistributable") || name.contains("Proton") {
                continue;
            }
            let last = vdf_values(&t, "LastPlayed").into_iter().next().and_then(|v| v.parse().ok()).unwrap_or(0);
            out.push(Game {
                art: find_steam_art(&steam, &appid),
                id: appid,
                name,
                source: "steam".into(),
                subtitle: "Steam".into(),
                last_played: last,
            });
        }
    }
    out
}

// ---------- Prism Launcher ----------

fn prism_root() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let p = PathBuf::from(appdata).join("PrismLauncher");
    p.join("instances").exists().then_some(p)
}

fn prism_exe() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let cands = [
        PathBuf::from(&local).join("Programs").join("PrismLauncher").join("prismlauncher.exe"),
        PathBuf::from(r"C:\Program Files\PrismLauncher\prismlauncher.exe"),
    ];
    cands.into_iter().find(|p| p.exists())
}

fn cfg_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let (k, v) = l.split_once('=')?;
        (k.trim() == key).then(|| v.trim().to_string())
    })
}

fn prism_games() -> Vec<Game> {
    let Some(root) = prism_root() else { return vec![] };
    let mut out = vec![];
    let Ok(rd) = std::fs::read_dir(root.join("instances")) else { return out };
    for e in rd.flatten() {
        let dir = e.path();
        let Ok(cfg) = std::fs::read_to_string(dir.join("instance.cfg")) else { continue };
        let folder = e.file_name().to_string_lossy().to_string();
        let name = cfg_value(&cfg, "name").unwrap_or_else(|| folder.clone());
        let last = cfg_value(&cfg, "lastLaunchTime").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) / 1000;

        // Minecraft version + loader from mmc-pack.json
        let mut mc = String::new();
        let mut loader = String::new();
        if let Ok(pack) = std::fs::read_to_string(dir.join("mmc-pack.json")) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&pack) {
                for c in v["components"].as_array().into_iter().flatten() {
                    let uid = c["uid"].as_str().unwrap_or("");
                    let ver = c["version"].as_str().unwrap_or("");
                    match uid {
                        "net.minecraft" => mc = ver.to_string(),
                        "net.fabricmc.fabric-loader" => loader = "Fabric".into(),
                        "org.quiltmc.quilt-loader" => loader = "Quilt".into(),
                        "net.neoforged" => loader = "NeoForge".into(),
                        "net.minecraftforge" => loader = "Forge".into(),
                        _ => {}
                    }
                }
            }
        }
        let subtitle = [loader.as_str(), mc.as_str()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" ");

        // Icon: custom icons live in PrismLauncher/icons/<key>.*, or inside the instance folder.
        let key = cfg_value(&cfg, "iconKey").unwrap_or_default();
        let mut art = None;
        for base in [root.join("icons"), dir.clone()] {
            for ext in ["png", "jpg", "jpeg", "gif", "webp"] {
                let p = base.join(format!("{key}.{ext}"));
                if !key.is_empty() && p.exists() {
                    art = Some(p.to_string_lossy().to_string());
                }
            }
        }
        out.push(Game {
            id: folder,
            name,
            source: "prism".into(),
            art,
            subtitle: if subtitle.is_empty() { "Minecraft".into() } else { format!("Minecraft {subtitle}") },
            last_played: last,
        });
    }
    out
}

#[tauri::command]
pub async fn get_games() -> Vec<Game> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut g = steam_games();
        g.extend(prism_games());
        g.sort_by(|a, b| b.last_played.cmp(&a.last_played).then(a.name.cmp(&b.name)));
        g
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn launch_game(source: String, id: String) -> Result<(), String> {
    match source.as_str() {
        "steam" => shell_open(&format!("steam://rungameid/{id}"), ""),
        "prism" => {
            let exe = prism_exe().ok_or("Prism Launcher not found")?;
            shell_open(&exe.to_string_lossy(), &format!("--launch \"{id}\""))
        }
        _ => Err("unknown source".into()),
    }
}

// ---------- Start menu apps ----------

fn walk_lnks(dir: &Path, out: &mut Vec<StartApp>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_lnks(&p, out);
        } else if p.extension().map(|x| x.eq_ignore_ascii_case("lnk")).unwrap_or(false) {
            let name = p.file_stem().unwrap().to_string_lossy().to_string();
            let l = name.to_lowercase();
            if ["uninstall", "readme", "help", "website", "documentation", "release notes", "license"]
                .iter()
                .any(|b| l.contains(b))
            {
                continue;
            }
            out.push(StartApp { name, path: p.to_string_lossy().into() });
        }
    }
}

#[tauri::command]
pub async fn get_start_apps() -> Vec<StartApp> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out = vec![];
        if let Ok(pd) = std::env::var("ProgramData") {
            walk_lnks(&PathBuf::from(pd).join(r"Microsoft\Windows\Start Menu\Programs"), &mut out);
        }
        if let Ok(ad) = std::env::var("APPDATA") {
            walk_lnks(&PathBuf::from(ad).join(r"Microsoft\Windows\Start Menu\Programs"), &mut out);
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        out.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
        out
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn launch_path(path: String, args: Option<String>) -> Result<(), String> {
    shell_open(&path, args.as_deref().unwrap_or(""))
}

#[tauri::command]
pub async fn read_image(path: String) -> Option<String> {
    let ext = Path::new(&path).extension()?.to_string_lossy().to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => return None,
    };
    let bytes = tokio_read(path).await?;
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

async fn tokio_read(path: String) -> Option<Vec<u8>> {
    tauri::async_runtime::spawn_blocking(move || std::fs::read(path).ok()).await.ok().flatten()
}

// ---------- Unelevated launching ----------

pub fn is_elevated() -> bool {
    unsafe { windows::Win32::UI::Shell::IsUserAnAdmin().as_bool() }
}

pub fn shell_open(file: &str, args: &str) -> Result<(), String> {
    let file = file.to_string();
    let args = args.to_string();
    // COM apartment work goes on its own thread.
    std::thread::spawn(move || {
        if is_elevated() {
            if shell_execute_via_explorer(&file, &args).is_ok() {
                return Ok(());
            }
        }
        shell_execute_direct(&file, &args)
    })
    .join()
    .map_err(|_| "launch thread panicked".to_string())?
}

fn shell_execute_direct(file: &str, args: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let r = unsafe {
        ShellExecuteW(
            None,
            &HSTRING::from("open"),
            &HSTRING::from(file),
            &HSTRING::from(args),
            None,
            SW_SHOWNORMAL,
        )
    };
    if r.0 as isize > 32 { Ok(()) } else { Err(format!("ShellExecute failed ({})", r.0 as isize)) }
}

/// Raymond Chen's trick: ask the desktop's Explorer window to run it, so it starts unelevated.
fn shell_execute_via_explorer(file: &str, args: &str) -> windows::core::Result<()> {
    use windows::core::{Interface, BSTR}; use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::System::Com::*;
    use windows::Win32::UI::Shell::*;
    use windows::Win32::System::Com::IServiceProvider;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER)?;
        let mut hwnd = 0i32;
        let disp = windows.FindWindowSW(
            &VARIANT::from(CSIDL_DESKTOP as i32),
            &VARIANT::default(),
            SWC_DESKTOP,
            &mut hwnd,
            SWFO_NEEDDISPATCH,
        )?;

        let sp: IServiceProvider = disp.cast()?;
        let browser: IShellBrowser = sp.QueryService(&SID_STopLevelBrowser)?;
        let view = browser.QueryActiveShellView()?;
        let bg: windows::Win32::System::Com::IDispatch = view.GetItemObject(SVGIO_BACKGROUND)?;
        let folder_view: IShellFolderViewDual = bg.cast()?;
        let app = folder_view.Application()?;
        let shell: IShellDispatch2 = app.cast()?;
        shell.ShellExecute(
            &BSTR::from(file),
            &VARIANT::from(BSTR::from(args)),
            &VARIANT::from(BSTR::from("")),
            &VARIANT::from(BSTR::from("open")),
            &VARIANT::from(SW_SHOWNORMAL.0),
        )?;
        Ok(())
    }
}
