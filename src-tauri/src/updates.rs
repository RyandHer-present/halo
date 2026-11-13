//! App updates via winget, driver/Windows updates via the Windows Update Agent, and Halo's own
//! updates from GitHub releases.

use crate::system::run_hidden;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const REPO: &str = "RyandHer-present/halo";

#[derive(Serialize, Clone)]
pub struct AppUpdate {
    pub name: String,
    pub id: String,
    pub version: String,
    pub available: String,
    pub source: String,
}

fn winget(args: &str) -> Result<String, String> {
    // UTF-8 code page so names with accents survive.
    run_hidden("cmd", &["/C", &format!("chcp 65001 >nul & winget {args}")])
}

/// Parse winget's fixed-width table (Name | Id | Version | Available | Source).
fn parse_table(out: &str) -> Vec<AppUpdate> {
    let lines: Vec<String> = out.lines().map(|l| l.rsplit('\r').next().unwrap_or(l).to_string()).collect();
    let Some(h) = lines.iter().position(|l| l.contains("Name") && l.contains(" Id") && l.contains("Version")) else { return vec![] };
    let header: Vec<char> = lines[h].chars().collect();
    let find = |word: &str| -> Option<usize> {
        let w: Vec<char> = word.chars().collect();
        (0..header.len().saturating_sub(w.len() - 1)).find(|&i| header[i..i + w.len()] == w[..] && (i == 0 || header[i - 1] == ' '))
    };
    let (Some(ci), Some(cv)) = (find("Id"), find("Version")) else { return vec![] };
    let ca = find("Available");
    let cs = find("Source");
    let mut out = vec![];
    for l in lines.iter().skip(h + 1) {
        let c: Vec<char> = l.chars().collect();
        if c.is_empty() || c.iter().all(|&x| x == '-') {
            continue;
        }
        if c.len() < cv || !l.starts_with(|ch: char| !ch.is_whitespace()) && l.contains("upgrades available") {
            break;
        }
        let slice = |a: usize, b: Option<usize>| -> String {
            let b = b.unwrap_or(c.len()).min(c.len());
            if a >= b { String::new() } else { c[a..b].iter().collect::<String>().trim().to_string() }
        };
        let id = slice(ci, Some(cv));
        if id.is_empty() || id.contains(' ') {
            continue;
        }
        out.push(AppUpdate {
            name: slice(0, Some(ci)),
            id,
            version: slice(cv, ca.or(cs)),
            available: ca.map(|a| slice(a, cs)).unwrap_or_default(),
            source: cs.map(|s| slice(s, None)).unwrap_or_default(),
        });
    }
    out
}

#[tauri::command]
pub async fn winget_updates() -> Result<Vec<AppUpdate>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = winget("upgrade --include-unknown --accept-source-agreements --disable-interactivity").or_else(|e| if e.contains("Name") { Ok(e) } else { Err(e) })?;
        Ok(parse_table(&out).into_iter().filter(|u| !u.available.is_empty()).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Upgrade one package (or all with id "--all"). Emits "halo://upgrade" when done.
#[tauri::command]
pub async fn winget_upgrade(app: AppHandle, id: String) -> Result<String, String> {
    let r = tauri::async_runtime::spawn_blocking(move || {
        let target = if id == "--all" { "--all --include-unknown".to_string() } else { format!("--id \"{id}\" --exact") };
        winget(&format!("upgrade {target} --silent --accept-package-agreements --accept-source-agreements --disable-interactivity"))
            .map(|o| o.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("Done").trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = app.emit("halo://upgrade", ());
    r
}

#[tauri::command]
pub async fn winget_search(query: String) -> Result<Vec<AppUpdate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = winget(&format!("search \"{}\" --accept-source-agreements --disable-interactivity", query.replace('"', "")))?;
        Ok(parse_table(&out))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn winget_install(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        winget(&format!("install --id \"{id}\" --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity"))
            .map(|o| o.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("Done").trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------- Windows Update (drivers + system) ----------------

#[derive(Serialize, Clone)]
pub struct WinUpdate {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub size: u64,
}

fn wua_search(criteria: &str) -> Result<Vec<(WinUpdate, windows::Win32::System::UpdateAgent::IUpdate)>, String> {
    use windows::core::BSTR;
    use windows::Win32::System::Com::*;
    use windows::Win32::System::UpdateAgent::*;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let session: IUpdateSession = CoCreateInstance(&UpdateSession, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        let searcher = session.CreateUpdateSearcher().map_err(|e| e.to_string())?;
        let result = searcher.Search(&BSTR::from(criteria)).map_err(|e| e.to_string())?;
        let ups = result.Updates().map_err(|e| e.to_string())?;
        let n = ups.Count().map_err(|e| e.to_string())?;
        let mut out = vec![];
        for i in 0..n {
            let Ok(u) = ups.get_Item(i) else { continue };
            let title = u.Title().map(|b| b.to_string()).unwrap_or_default();
            let id = u.Identity().and_then(|x| x.UpdateID()).map(|b| b.to_string()).unwrap_or_default();
            let kind = if u.Type().map(|t| t == utDriver).unwrap_or(false) { "driver" } else { "windows" };
            out.push((WinUpdate { id, title, kind: kind.into(), size: 0 }, u));
        }
        Ok(out)
    }
}

#[tauri::command]
pub async fn windows_updates() -> Result<Vec<WinUpdate>, String> {
    tauri::async_runtime::spawn_blocking(|| wua_search("IsInstalled=0 and IsHidden=0").map(|v| v.into_iter().map(|x| x.0).collect()))
        .await
        .map_err(|e| e.to_string())?
}

/// Download + install the chosen updates. Returns a short status (and whether a restart is needed).
#[tauri::command]
pub async fn install_windows_updates(ids: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || unsafe {
        use windows::Win32::System::Com::*;
        use windows::Win32::System::UpdateAgent::*;
        let found = wua_search("IsInstalled=0 and IsHidden=0")?;
        let session: IUpdateSession = CoCreateInstance(&UpdateSession, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        let coll: IUpdateCollection = CoCreateInstance(&UpdateCollection, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        let mut n = 0;
        for (w, u) in found {
            if ids.contains(&w.id) {
                if !u.EulaAccepted().map(|b| b.as_bool()).unwrap_or(true) {
                    let _ = u.AcceptEula();
                }
                coll.Add(&u).map_err(|e| e.to_string())?;
                n += 1;
            }
        }
        if n == 0 {
            return Err("Those updates are no longer available".into());
        }
        let dl = session.CreateUpdateDownloader().map_err(|e| e.to_string())?;
        dl.SetUpdates(&coll).map_err(|e| e.to_string())?;
        dl.Download().map_err(|e| e.to_string())?;
        let inst = session.CreateUpdateInstaller().map_err(|e| e.to_string())?;
        inst.SetUpdates(&coll).map_err(|e| e.to_string())?;
        let r = inst.Install().map_err(|e| e.to_string())?;
        let reboot = r.RebootRequired().map(|b| b.as_bool()).unwrap_or(false);
        let code = r.ResultCode().map(|c| c.0).unwrap_or(0);
        Ok(format!("{}{}", if code == 2 { "Installed" } else if code == 3 { "Partly installed" } else { "Finished" }, if reboot { " — restart to finish" } else { "" }))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------- Halo itself ----------------

#[derive(Serialize)]
pub struct HaloUpdate {
    pub current: String,
    pub latest: Option<String>,
    pub notes: String,
    pub url: Option<String>,
}

fn ver(s: &str) -> Vec<u32> {
    s.trim_start_matches('v').split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

#[tauri::command]
pub async fn check_halo_update() -> Result<HaloUpdate, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let r = crate::net::client().get(format!("https://api.github.com/repos/{REPO}/releases/latest")).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Ok(HaloUpdate { current, latest: None, notes: String::new(), url: None });
    }
    let v: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
    let tag = v["tag_name"].as_str().unwrap_or("").to_string();
    let url = v["assets"].as_array().and_then(|a| {
        a.iter().find(|x| x["name"].as_str().map_or(false, |n| n.ends_with("-setup.exe"))).and_then(|x| x["browser_download_url"].as_str()).map(String::from)
    });
    let newer = ver(&tag) > ver(&current);
    Ok(HaloUpdate { current, latest: if newer { Some(tag) } else { None }, notes: v["body"].as_str().unwrap_or("").to_string(), url: if newer { url } else { None } })
}

/// Download the new installer, run it silently, and relaunch Halo afterwards.
#[tauri::command]
pub async fn install_halo_update(app: AppHandle, url: String) -> Result<(), String> {
    let dest = std::env::temp_dir().join("Halo-update-setup.exe");
    crate::net::download(&app, &url, &dest, "halo").await?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    use std::os::windows::process::CommandExt;
    std::process::Command::new("cmd")
        .raw_arg(format!("/C \"\"{}\" /S & start \"\" \"{}\"\"", dest.display(), exe.display()))
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}
