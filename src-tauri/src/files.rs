//! Files: folder-size map, cleanup, big files, duplicates, quick folders, recent files,
//! and the live Downloads organizer.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

const REPARSE: u32 = 0x400;

fn home() -> PathBuf {
    std::env::var("USERPROFILE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(r"C:\Users\Public"))
}
pub fn downloads_dir() -> PathBuf {
    known_folder("{374DE290-123F-4565-9164-39C4925E467B}").unwrap_or_else(|| home().join("Downloads"))
}

fn known_folder(guid: &str) -> Option<PathBuf> {
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    let id = windows::core::GUID::try_from(guid.trim_matches(|c| c == '{' || c == '}')).ok()?;
    unsafe {
        let p = SHGetKnownFolderPath(&id, KF_FLAG_DEFAULT, None).ok()?;
        let s = p.to_string().ok();
        windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _));
        s.map(PathBuf::from)
    }
}

// ---------------- folder sizes ----------------

#[derive(Serialize, Clone)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub files: u64,
    pub dir: bool,
}

static SIZE_CACHE: OnceLock<Mutex<HashMap<PathBuf, (u64, u64)>>> = OnceLock::new();
static CANCEL: AtomicBool = AtomicBool::new(false);

fn cache() -> &'static Mutex<HashMap<PathBuf, (u64, u64)>> {
    SIZE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Recursive size of a folder. Remembers sizes of folders down to `keep` levels so drilling
/// down after a scan is instant.
fn dir_size(p: &Path, depth: u32, keep: u32, out: &mut Vec<(PathBuf, u64, u64)>) -> (u64, u64) {
    if CANCEL.load(Ordering::Relaxed) {
        return (0, 0);
    }
    let mut total = 0u64;
    let mut files = 0u64;
    let Ok(rd) = std::fs::read_dir(p) else { return (0, 0) };
    for e in rd.flatten() {
        let Ok(md) = e.metadata() else { continue };
        if md.file_attributes() & REPARSE != 0 {
            continue;
        }
        if md.is_dir() {
            let (s, f) = dir_size(&e.path(), depth + 1, keep, out);
            total += s;
            files += f;
        } else {
            total += md.len();
            files += 1;
        }
    }
    if depth <= keep {
        out.push((p.to_path_buf(), total, files));
    }
    (total, files)
}

#[tauri::command]
pub async fn scan_folder(path: String, fresh: Option<bool>) -> Result<Vec<Entry>, String> {
    CANCEL.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        let rd = std::fs::read_dir(&root).map_err(|e| e.to_string())?;
        let mut dirs = vec![];
        let mut out = vec![];
        for e in rd.flatten() {
            let Ok(md) = e.metadata() else { continue };
            if md.file_attributes() & REPARSE != 0 {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if md.is_dir() {
                dirs.push((name, e.path()));
            } else {
                out.push(Entry { name, path: e.path().to_string_lossy().to_string(), size: md.len(), files: 1, dir: false });
            }
        }
        // Folders in parallel (a few threads), using cached sizes when we have them.
        let fresh = fresh.unwrap_or(false);
        let results = Mutex::new(vec![]);
        let work = Mutex::new(dirs);
        std::thread::scope(|sc| {
            for _ in 0..6 {
                sc.spawn(|| loop {
                    let Some((name, p)) = work.lock().unwrap().pop() else { break };
                    let cached = if fresh { None } else { cache().lock().unwrap().get(&p).copied() };
                    let (size, files) = match cached {
                        Some(x) => x,
                        None => {
                            let mut keep = vec![];
                            let r = dir_size(&p, 0, 2, &mut keep);
                            let mut c = cache().lock().unwrap();
                            for (k, s, f) in keep {
                                c.insert(k, (s, f));
                            }
                            r
                        }
                    };
                    results.lock().unwrap().push(Entry { name, path: p.to_string_lossy().to_string(), size, files, dir: true });
                });
            }
        });
        out.extend(results.into_inner().unwrap());
        out.sort_by(|a, b| b.size.cmp(&a.size));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cancel_scan() {
    CANCEL.store(true, Ordering::Relaxed);
}

/// Send files/folders to the Recycle Bin.
#[tauri::command]
pub fn trash_paths(paths: Vec<String>) -> Result<(), String> {
    trash::delete_all(&paths).map_err(|e| e.to_string())?;
    let mut c = cache().lock().unwrap();
    c.clear();
    Ok(())
}

/// Restore items that were deleted from these original paths.
#[tauri::command]
pub fn restore_paths(paths: Vec<String>) -> Result<usize, String> {
    let want: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let items = trash::os_limited::list().map_err(|e| e.to_string())?;
    let mut hits: Vec<trash::TrashItem> = items.into_iter().filter(|i| want.iter().any(|w| *w == i.original_path())).collect();
    // newest first; only one per path
    hits.sort_by(|a, b| b.time_deleted.cmp(&a.time_deleted));
    let mut seen = std::collections::HashSet::new();
    hits.retain(|i| seen.insert(i.original_path()));
    let n = hits.len();
    trash::os_limited::restore_all(hits).map_err(|e| e.to_string())?;
    Ok(n)
}

// ---------------- cleanup ----------------

#[derive(Serialize, Clone)]
pub struct CleanCat {
    pub id: String,
    pub name: String,
    pub desc: String,
    pub size: u64,
    pub files: u64,
}

fn local() -> PathBuf {
    std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| home().join(r"AppData\Local"))
}
fn windir() -> PathBuf {
    std::env::var("WINDIR").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(r"C:\Windows"))
}

fn browser_caches() -> Vec<PathBuf> {
    let l = local();
    let mut v = vec![];
    for b in [r"Google\Chrome\User Data", r"Microsoft\Edge\User Data", r"BraveSoftware\Brave-Browser\User Data", r"Vivaldi\User Data"] {
        let base = l.join(b);
        let Ok(rd) = std::fs::read_dir(&base) else { continue };
        for p in rd.flatten() {
            let n = p.file_name().to_string_lossy().to_string();
            if n == "Default" || n.starts_with("Profile ") {
                for c in [r"Cache\Cache_Data", "Code Cache", "GPUCache", r"Service Worker\CacheStorage"] {
                    v.push(p.path().join(c));
                }
            }
        }
    }
    v.push(l.join(r"Mozilla\Firefox\Profiles"));
    v
}

fn cat_paths(id: &str) -> Vec<PathBuf> {
    match id {
        "temp" => vec![std::env::temp_dir()],
        "wintemp" => vec![windir().join("Temp")],
        "updates" => vec![windir().join(r"SoftwareDistribution\Download")],
        "thumbs" => vec![local().join(r"Microsoft\Windows\Explorer")],
        "browser" => browser_caches(),
        "dumps" => vec![local().join("CrashDumps"), windir().join("Minidump"), local().join(r"Microsoft\Windows\WER\ReportArchive"), PathBuf::from(r"C:\ProgramData\Microsoft\Windows\WER\ReportArchive")],
        "delivery" => vec![windir().join(r"ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache")],
        "logs" => vec![windir().join("Logs\\CBS"), windir().join(r"Panther")],
        _ => vec![],
    }
}

fn cat_filter(id: &str, p: &Path) -> bool {
    match id {
        "thumbs" => p.file_name().map_or(false, |n| {
            let n = n.to_string_lossy();
            n.starts_with("thumbcache_") || n.starts_with("iconcache_")
        }),
        "browser" => {
            // Firefox: only cache2 folders
            let s = p.to_string_lossy();
            !s.contains("Firefox") || s.contains("cache2")
        }
        "logs" => p.extension().map_or(false, |e| e == "log" || e == "cab"),
        _ => true,
    }
}

fn walk_files(p: &Path, f: &mut dyn FnMut(&Path, u64)) {
    let Ok(rd) = std::fs::read_dir(p) else { return };
    for e in rd.flatten() {
        let Ok(md) = e.metadata() else { continue };
        if md.file_attributes() & REPARSE != 0 {
            continue;
        }
        if md.is_dir() {
            walk_files(&e.path(), f);
        } else {
            f(&e.path(), md.len());
        }
    }
}

fn recycle_bin_size() -> (u64, u64) {
    use windows::Win32::UI::Shell::{SHQueryRecycleBinW, SHQUERYRBINFO};
    let mut info = SHQUERYRBINFO { cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32, ..Default::default() };
    unsafe {
        if SHQueryRecycleBinW(None, &mut info).is_ok() {
            return (info.i64Size as u64, info.i64NumItems as u64);
        }
    }
    (0, 0)
}

const CATS: [(&str, &str, &str); 9] = [
    ("temp", "Your temp files", "Leftovers apps write to %TEMP%"),
    ("wintemp", "Windows temp files", "C:\\Windows\\Temp"),
    ("recycle", "Recycle Bin", "Empties it for good"),
    ("browser", "Browser caches", "Chrome, Edge, Brave, Firefox caches (sites load a bit slower once)"),
    ("updates", "Windows Update downloads", "Already-installed update files"),
    ("delivery", "Delivery Optimization", "Update pieces shared with other PCs"),
    ("thumbs", "Thumbnail cache", "Rebuilt automatically"),
    ("dumps", "Crash dumps & error reports", "Only useful for debugging"),
    ("logs", "Old system logs", "CBS and setup logs"),
];

#[tauri::command]
pub async fn cleanup_scan() -> Vec<CleanCat> {
    tauri::async_runtime::spawn_blocking(|| {
        CATS.iter()
            .map(|(id, name, desc)| {
                let (mut size, mut files) = (0u64, 0u64);
                if *id == "recycle" {
                    (size, files) = recycle_bin_size();
                } else {
                    for p in cat_paths(id) {
                        walk_files(&p, &mut |f, len| {
                            if cat_filter(id, f) {
                                size += len;
                                files += 1;
                            }
                        });
                    }
                }
                CleanCat { id: id.to_string(), name: name.to_string(), desc: desc.to_string(), size, files }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Deletes the chosen categories. Files in use are skipped. Returns bytes freed.
#[tauri::command]
pub async fn cleanup_run(ids: Vec<String>) -> u64 {
    tauri::async_runtime::spawn_blocking(move || {
        let mut freed = 0u64;
        for id in ids {
            if id == "recycle" {
                use windows::Win32::UI::Shell::{SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND};
                freed += recycle_bin_size().0;
                unsafe {
                    let _ = SHEmptyRecycleBinW(None, None, SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND);
                }
                continue;
            }
            if id == "updates" {
                let _ = crate::system::run_hidden("net", &["stop", "wuauserv"]);
            }
            for p in cat_paths(&id) {
                walk_files(&p, &mut |f, len| {
                    if cat_filter(&id, f) && std::fs::remove_file(f).is_ok() {
                        freed += len;
                    }
                });
                remove_empty_dirs(&p, true);
            }
            if id == "updates" {
                let _ = crate::system::run_hidden("net", &["start", "wuauserv"]);
            }
        }
        freed
    })
    .await
    .unwrap_or(0)
}

fn remove_empty_dirs(p: &Path, root: bool) {
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            if e.file_type().map_or(false, |t| t.is_dir()) {
                remove_empty_dirs(&e.path(), false);
            }
        }
    }
    if !root {
        let _ = std::fs::remove_dir(p);
    }
}

// ---------------- big files + duplicates ----------------

#[derive(Serialize, Clone)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: u64,
}

fn mtime(md: &std::fs::Metadata) -> u64 {
    md.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())
}

#[tauri::command]
pub async fn big_files(path: Option<String>, min_mb: Option<u64>) -> Vec<FileInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = path.map(PathBuf::from).unwrap_or_else(home);
        let min = min_mb.unwrap_or(200) * 1024 * 1024;
        let mut out = vec![];
        fn go(p: &Path, min: u64, out: &mut Vec<FileInfo>) {
            let Ok(rd) = std::fs::read_dir(p) else { return };
            for e in rd.flatten() {
                let Ok(md) = e.metadata() else { continue };
                if md.file_attributes() & REPARSE != 0 {
                    continue;
                }
                if md.is_dir() {
                    go(&e.path(), min, out);
                } else if md.len() >= min {
                    out.push(FileInfo { name: e.file_name().to_string_lossy().to_string(), path: e.path().to_string_lossy().to_string(), size: md.len(), modified: mtime(&md) });
                }
            }
        }
        go(&root, min, &mut out);
        out.sort_by(|a, b| b.size.cmp(&a.size));
        out.truncate(100);
        out
    })
    .await
    .unwrap_or_default()
}

fn quick_hash(p: &Path, size: u64) -> Option<u64> {
    use std::hash::Hasher;
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(p).ok()?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    let mut buf = vec![0u8; 256 * 1024];
    let n = f.read(&mut buf).ok()?;
    h.write(&buf[..n]);
    if size > buf.len() as u64 * 2 {
        f.seek(SeekFrom::Start(size / 2)).ok()?;
        let n = f.read(&mut buf).ok()?;
        h.write(&buf[..n]);
        f.seek(SeekFrom::End(-(buf.len() as i64))).ok()?;
        let n = f.read(&mut buf).ok()?;
        h.write(&buf[..n]);
    }
    h.write_u64(size);
    Some(h.finish())
}

/// Groups of identical files in your personal folders (same size + same content samples).
#[tauri::command]
pub async fn find_duplicates() -> Vec<Vec<FileInfo>> {
    tauri::async_runtime::spawn_blocking(|| {
        let h = home();
        let roots = [h.join("Downloads"), h.join("Desktop"), h.join("Documents"), h.join("Pictures"), h.join("Videos"), h.join("Music")];
        let mut by_size: HashMap<u64, Vec<FileInfo>> = HashMap::new();
        for r in roots {
            walk_files(&r, &mut |p, len| {
                if len >= 512 * 1024 {
                    let modified = std::fs::metadata(p).map(|m| mtime(&m)).unwrap_or(0);
                    by_size.entry(len).or_default().push(FileInfo { name: p.file_name().unwrap_or_default().to_string_lossy().to_string(), path: p.to_string_lossy().to_string(), size: len, modified });
                }
            });
        }
        let mut groups = vec![];
        for (size, files) in by_size {
            if files.len() < 2 {
                continue;
            }
            let mut by_hash: HashMap<u64, Vec<FileInfo>> = HashMap::new();
            for f in files {
                if let Some(hh) = quick_hash(Path::new(&f.path), size) {
                    by_hash.entry(hh).or_default().push(f);
                }
            }
            groups.extend(by_hash.into_values().filter(|g| g.len() > 1));
        }
        groups.sort_by(|a, b| (b[0].size * (b.len() as u64 - 1)).cmp(&(a[0].size * (a.len() as u64 - 1))));
        groups.truncate(80);
        groups
    })
    .await
    .unwrap_or_default()
}

// ---------------- quick folders + recent ----------------

#[derive(Serialize, Clone)]
pub struct Folder {
    pub name: String,
    pub path: String,
}

#[tauri::command]
pub fn quick_folders() -> Vec<Folder> {
    let h = home();
    let mut v = vec![
        ("Desktop", known_folder("{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}").unwrap_or(h.join("Desktop"))),
        ("Downloads", downloads_dir()),
        ("Documents", known_folder("{FDD39AD0-238F-46AF-ADB4-6C85480369C7}").unwrap_or(h.join("Documents"))),
        ("Pictures", known_folder("{33E28130-4E1E-4676-835A-98395C3BC3BB}").unwrap_or(h.join("Pictures"))),
        ("Music", h.join("Music")),
        ("Videos", h.join("Videos")),
        ("Home", h.clone()),
        ("AppData", std::env::var("APPDATA").map(PathBuf::from).unwrap_or(h.join(r"AppData\Roaming"))),
    ];
    if let Ok(a) = std::env::var("APPDATA") {
        let mc = PathBuf::from(a).join("PrismLauncher").join("instances");
        if mc.exists() {
            v.push(("Prism instances", mc));
        }
    }
    v.into_iter().filter(|(_, p)| p.exists()).map(|(n, p)| Folder { name: n.into(), path: p.to_string_lossy().to_string() }).collect()
}

#[tauri::command]
pub fn recent_files() -> Vec<FileInfo> {
    let dir = std::env::var("APPDATA").map(|a| PathBuf::from(a).join(r"Microsoft\Windows\Recent")).unwrap_or_default();
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut v: Vec<FileInfo> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.to_lowercase().ends_with(".lnk") {
                return None;
            }
            let stem = name[..name.len() - 4].to_string();
            // skip folders (no extension) — files only
            if !stem.contains('.') {
                return None;
            }
            let md = e.metadata().ok()?;
            Some(FileInfo { name: stem, path: e.path().to_string_lossy().to_string(), size: 0, modified: mtime(&md) })
        })
        .collect();
    v.sort_by(|a, b| b.modified.cmp(&a.modified));
    v.truncate(40);
    v
}

// ---------------- Downloads organizer ----------------

#[derive(Deserialize, Serialize, Clone, Default)]
pub struct OrganizerCfg {
    pub enabled: bool,
    pub clean_installers: bool,
}

#[derive(Serialize, Clone)]
pub struct Moved {
    pub name: String,
    pub folder: String,
    pub at: u64,
}

static ORG: OnceLock<Mutex<(OrganizerCfg, Vec<Moved>)>> = OnceLock::new();
static WATCHER: OnceLock<Mutex<Option<notify::RecommendedWatcher>>> = OnceLock::new();

fn org() -> &'static Mutex<(OrganizerCfg, Vec<Moved>)> {
    ORG.get_or_init(|| Mutex::new((OrganizerCfg::default(), vec![])))
}

pub fn category(ext: &str) -> Option<&'static str> {
    let e = ext.to_lowercase();
    Some(match e.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" | "heic" | "avif" | "ico" | "tif" | "tiff" | "psd" => "Images",
        "mp4" | "mkv" | "mov" | "avi" | "webm" | "wmv" | "m4v" | "flv" => "Videos",
        "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" | "opus" | "wma" => "Music",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "rtf" | "odt" | "csv" | "md" | "epub" => "Documents",
        "zip" | "rar" | "7z" | "tar" | "gz" | "xz" | "bz2" | "iso" => "Archives",
        "exe" | "msi" | "msix" | "msixbundle" | "appx" | "appxbundle" => "Installers",
        "jar" | "mrpack" | "mcpack" | "mcworld" | "litematic" | "schem" => "Minecraft",
        "ttf" | "otf" | "woff" | "woff2" => "Fonts",
        "py" | "js" | "ts" | "json" | "html" | "css" | "rs" | "java" | "c" | "cpp" | "cs" | "sh" | "ps1" | "bat" => "Code",
        "torrent" => "Torrents",
        _ => return None,
    })
}

fn is_partial(p: &Path) -> bool {
    let n = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    n.ends_with(".crdownload") || n.ends_with(".part") || n.ends_with(".tmp") || n.ends_with(".opdownload") || n.ends_with(".partial") || n.ends_with(".download") || n.ends_with(".!ut") || n.starts_with("~$") || n == "desktop.ini" || n.starts_with('.')
}

/// Move one loose file into its category folder, once it has finished downloading.
fn sort_file(p: &Path, wait: bool) -> Option<Moved> {
    let dl = downloads_dir();
    if p.parent()? != dl || is_partial(p) || !p.is_file() {
        return None;
    }
    let cat = category(&p.extension()?.to_string_lossy())?;
    if wait {
        // wait until the size stops changing and the file can be opened for writing
        let mut last = u64::MAX;
        for _ in 0..60 {
            std::thread::sleep(Duration::from_secs(2));
            let Ok(md) = std::fs::metadata(p) else { return None };
            if md.len() == last && std::fs::OpenOptions::new().write(true).open(p).is_ok() {
                break;
            }
            last = md.len();
        }
    }
    let dest_dir = dl.join(cat);
    std::fs::create_dir_all(&dest_dir).ok()?;
    let name = p.file_name()?.to_string_lossy().to_string();
    let mut dest = dest_dir.join(&name);
    let mut i = 1;
    while dest.exists() {
        let stem = p.file_stem()?.to_string_lossy();
        let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        dest = dest_dir.join(format!("{stem} ({i}){ext}"));
        i += 1;
    }
    std::fs::rename(p, &dest).ok()?;
    let m = Moved { name, folder: cat.into(), at: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs() };
    let mut o = org().lock().unwrap();
    o.1.insert(0, m.clone());
    o.1.truncate(50);
    Some(m)
}

/// Installers older than 30 days (loose or in Installers\) go to the Recycle Bin.
pub fn clean_old_installers() -> usize {
    let dl = downloads_dir();
    let cutoff = SystemTime::now() - Duration::from_secs(30 * 86400);
    let mut victims = vec![];
    for dir in [dl.clone(), dl.join("Installers")] {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| category(&x.to_string_lossy())) != Some("Installers") {
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            let t = md.created().or_else(|_| md.modified()).unwrap_or(SystemTime::now());
            if t < cutoff {
                victims.push(p);
            }
        }
    }
    let n = victims.len();
    if n > 0 {
        let _ = trash::delete_all(&victims);
    }
    n
}

#[tauri::command]
pub fn sort_downloads_now() -> usize {
    let Ok(rd) = std::fs::read_dir(downloads_dir()) else { return 0 };
    rd.flatten().filter_map(|e| sort_file(&e.path(), false)).count()
}

#[tauri::command]
pub fn clean_installers_now() -> usize {
    clean_old_installers()
}

#[tauri::command]
pub fn organizer_log() -> Vec<Moved> {
    org().lock().unwrap().1.clone()
}

#[tauri::command]
pub fn set_organizer(cfg: OrganizerCfg) {
    use notify::{EventKind, RecursiveMode, Watcher};
    let was = org().lock().unwrap().0.clone();
    org().lock().unwrap().0 = cfg.clone();
    let slot = WATCHER.get_or_init(|| Mutex::new(None));
    if cfg.enabled && slot.lock().unwrap().is_none() {
        let w = notify::recommended_watcher(|res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            if !matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))) {
                return;
            }
            for p in ev.paths {
                std::thread::spawn(move || {
                    if let Some(m) = sort_file(&p, true) {
                        let _ = m;
                    }
                });
            }
        });
        if let Ok(mut w) = w {
            if w.watch(&downloads_dir(), RecursiveMode::NonRecursive).is_ok() {
                *slot.lock().unwrap() = Some(w);
            }
        }
    } else if !cfg.enabled {
        *slot.lock().unwrap() = None;
    }
    // Installer cleanup: now, then every 6 hours.
    if cfg.clean_installers && !was.clean_installers {
        std::thread::spawn(|| loop {
            if !org().lock().unwrap().0.clean_installers {
                break;
            }
            clean_old_installers();
            std::thread::sleep(Duration::from_secs(6 * 3600));
        });
    }
}

// ---------------- small file helpers for the AI ----------------

#[derive(Serialize)]
pub struct DirItem {
    pub name: String,
    pub dir: bool,
    pub size: u64,
    pub modified: u64,
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirItem>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut v: Vec<DirItem> = rd
        .flatten()
        .filter_map(|e| {
            let md = e.metadata().ok()?;
            Some(DirItem { name: e.file_name().to_string_lossy().to_string(), dir: md.is_dir(), size: md.len(), modified: mtime(&md) })
        })
        .collect();
    v.sort_by(|a, b| b.dir.cmp(&a.dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(v)
}

#[tauri::command]
pub fn read_text(path: String, max: Option<usize>) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let max = max.unwrap_or(60_000);
    let s = String::from_utf8_lossy(&bytes[..bytes.len().min(max)]).to_string();
    Ok(if bytes.len() > max { format!("{s}\n…[truncated, {} bytes total]", bytes.len()) } else { s })
}

/// Writes a text file; returns the previous content (None if the file did not exist) for undo.
#[tauri::command]
pub fn write_text(path: String, content: String) -> Result<Option<String>, String> {
    let old = std::fs::read(&path).ok().map(|b| String::from_utf8_lossy(&b).to_string());
    if let Some(dir) = Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(old)
}

#[tauri::command]
pub fn move_path(from: String, to: String) -> Result<(), String> {
    if let Some(dir) = Path::new(&to).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}
