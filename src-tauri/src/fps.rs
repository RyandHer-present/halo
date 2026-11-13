//! FPS overlay: runs Intel's PresentMon (downloaded on first use) and reports FPS + frame time
//! for whatever app is in the foreground, shown in a small click-through window.

use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const PM_URL: &str = "https://github.com/GameTechDev/PresentMon/releases/download/v2.6.0/PresentMon-2.6.0-x64.exe";

#[derive(Serialize, Clone, Default)]
pub struct Fps {
    pub app: String,
    pub fps: f32,
    pub frametime: f32,
    pub low1: f32,
    pub history: Vec<f32>,
}

static CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);
static FG_PID: AtomicU32 = AtomicU32::new(0);
static FRAMES: OnceLock<Mutex<VecDeque<(Instant, u32, String, f32)>>> = OnceLock::new();

fn frames() -> &'static Mutex<VecDeque<(Instant, u32, String, f32)>> {
    FRAMES.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn pm_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("Halo").join("PresentMon.exe")
}

fn foreground_pid() -> u32 {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let h = GetForegroundWindow();
        let mut pid = 0;
        GetWindowThreadProcessId(h, Some(&mut pid));
        pid
    }
}

pub fn is_running() -> bool {
    CHILD.lock().unwrap().is_some()
}

#[tauri::command]
pub fn fps_running() -> bool {
    is_running()
}

#[tauri::command]
pub async fn fps_toggle(app: AppHandle) -> Result<bool, String> {
    if is_running() {
        stop(&app);
        return Ok(false);
    }
    start(&app).await?;
    Ok(true)
}

pub fn stop(app: &AppHandle) {
    if let Some(mut c) = CHILD.lock().unwrap().take() {
        let _ = c.kill();
    }
    let _ = std::process::Command::new(pm_path()).args(["--terminate_existing_session", "--session_name", "HaloFPS"]).creation_flags(0x0800_0000).status();
    if let Some(w) = app.get_webview_window("fps") {
        let _ = w.destroy();
    }
}

pub async fn start(app: &AppHandle) -> Result<(), String> {
    let pm = pm_path();
    if !pm.exists() {
        std::fs::create_dir_all(pm.parent().unwrap()).map_err(|e| e.to_string())?;
        crate::net::download(app, PM_URL, &pm, "presentmon").await?;
    }
    let mut child = std::process::Command::new(&pm)
        .args(["--output_stdout", "--no_console_stats", "--stop_existing_session", "--session_name", "HaloFPS", "--v1_metrics"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| format!("couldn't start PresentMon: {e}"))?;
    let out = child.stdout.take().unwrap();
    *CHILD.lock().unwrap() = Some(child);

    // reader: parse CSV lines
    std::thread::spawn(move || {
        let mut cols: Option<(usize, usize, usize)> = None; // app, pid, frametime
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            let f: Vec<&str> = line.split(',').collect();
            if cols.is_none() {
                let idx = |n: &str| f.iter().position(|c| c.trim() == n);
                if let (Some(a), Some(p)) = (idx("Application"), idx("ProcessID")) {
                    let t = idx("MsBetweenPresents").or_else(|| idx("FrameTime")).or_else(|| idx("MsBetweenAppStart")).or_else(|| idx("MsBetweenDisplayChange"));
                    if let Some(t) = t {
                        cols = Some((a, p, t));
                    }
                }
                continue;
            }
            let (a, p, t) = cols.unwrap();
            let (Some(app), Some(pid), Some(ft)) = (f.get(a), f.get(p).and_then(|x| x.trim().parse::<u32>().ok()), f.get(t).and_then(|x| x.trim().parse::<f32>().ok())) else { continue };
            if pid != FG_PID.load(Ordering::Relaxed) || ft <= 0.0 {
                continue;
            }
            let mut q = frames().lock().unwrap();
            q.push_back((Instant::now(), pid, app.to_string(), ft));
            while q.front().map_or(false, |x| x.0.elapsed() > Duration::from_secs(3)) {
                q.pop_front();
            }
        }
    });

    // overlay window
    let app2 = app.clone();
    std::thread::spawn(move || {
        if app2.get_webview_window("fps").is_some() {
            return;
        }
        if let Ok(w) = WebviewWindowBuilder::new(&app2, "fps", WebviewUrl::App("index.html#fps".into()))
            .title("Halo FPS")
            .inner_size(250.0, 150.0)
            .position(14.0, 14.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .resizable(false)
            .build()
        {
            let _ = w.set_ignore_cursor_events(true);
        }
    });

    // ticker: foreground pid + aggregate twice a second
    let app3 = app.clone();
    std::thread::spawn(move || {
        let mut hist: VecDeque<f32> = VecDeque::new();
        while is_running() {
            let fg = foreground_pid();
            if fg != FG_PID.swap(fg, Ordering::Relaxed) {
                frames().lock().unwrap().clear();
                hist.clear();
            }
            let snap: Vec<(Instant, String, f32)> = frames().lock().unwrap().iter().map(|x| (x.0, x.2.clone(), x.3)).collect();
            let last1: Vec<f32> = snap.iter().filter(|x| x.0.elapsed() <= Duration::from_secs(1)).map(|x| x.2).collect();
            let mut fps = Fps::default();
            if !last1.is_empty() {
                let avg = last1.iter().sum::<f32>() / last1.len() as f32;
                fps.fps = 1000.0 / avg;
                fps.frametime = avg;
                let mut all: Vec<f32> = snap.iter().map(|x| x.2).collect();
                all.sort_by(|a, b| b.partial_cmp(a).unwrap());
                let n = (all.len() / 100).max(1);
                fps.low1 = 1000.0 / (all[..n].iter().sum::<f32>() / n as f32);
                fps.app = snap.last().map(|x| x.1.trim_end_matches(".exe").to_string()).unwrap_or_default();
                hist.push_back(fps.fps);
                if hist.len() > 60 {
                    hist.pop_front();
                }
            }
            fps.history = hist.iter().cloned().collect();
            let _ = app3.emit_to("fps", "halo://fps", fps);
            std::thread::sleep(Duration::from_millis(500));
        }
    });
    Ok(())
}
