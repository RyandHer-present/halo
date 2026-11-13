//! Helpers for the AI assistant: screenshots (Halo hidden from them) and running PowerShell.

use base64::Engine;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::WindowsAndMessaging::*;

fn halo_hwnds(app: &AppHandle) -> Vec<HWND> {
    app.webview_windows().values().filter_map(|w| w.hwnd().ok().map(|h| HWND(h.0 as _))).collect()
}

/// Screenshot of the primary screen as a PNG data URL (max 1600 px wide). Halo's own windows are
/// excluded so the assistant sees what's behind it.
#[tauri::command]
pub async fn screenshot(app: AppHandle) -> Result<String, String> {
    let hwnds: Vec<isize> = halo_hwnds(&app).iter().map(|h| h.0 as isize).collect();
    tauri::async_runtime::spawn_blocking(move || unsafe {
        for h in &hwnds {
            let _ = SetWindowDisplayAffinity(HWND(*h as _), WDA_EXCLUDEFROMCAPTURE);
        }
        std::thread::sleep(Duration::from_millis(120));
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        let _ = BitBlt(mem, 0, 0, w, h, Some(screen), 0, 0, SRCCOPY | CAPTUREBLT);
        for hh in &hwnds {
            let _ = SetWindowDisplayAffinity(HWND(*hh as _), WDA_NONE);
        }
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h;
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        let mut px = vec![0u8; (w * h * 4) as usize];
        GetDIBits(mem, bmp, 0, h as u32, Some(px.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);

        // downscale (box filter) to <= 1600 wide, BGRA -> RGB
        let scale = ((w as f32) / 1600.0).max(1.0);
        let (ow, oh) = ((w as f32 / scale) as usize, (h as f32 / scale) as usize);
        let mut rgb = vec![0u8; ow * oh * 3];
        for y in 0..oh {
            for x in 0..ow {
                let (sx0, sy0) = ((x as f32 * scale) as usize, (y as f32 * scale) as usize);
                let (sx1, sy1) = ((((x + 1) as f32 * scale) as usize).min(w as usize).max(sx0 + 1), (((y + 1) as f32 * scale) as usize).min(h as usize).max(sy0 + 1));
                let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
                for yy in sy0..sy1 {
                    for xx in sx0..sx1 {
                        let i = (yy * w as usize + xx) * 4;
                        b += px[i] as u32;
                        g += px[i + 1] as u32;
                        r += px[i + 2] as u32;
                        n += 1;
                    }
                }
                let o = (y * ow + x) * 3;
                rgb[o] = (r / n) as u8;
                rgb[o + 1] = (g / n) as u8;
                rgb[o + 2] = (b / n) as u8;
            }
        }
        let mut out = vec![];
        {
            let mut enc = png::Encoder::new(&mut out, ow as u32, oh as u32);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            enc.set_compression(png::Compression::Fast);
            let mut wr = enc.write_header().map_err(|e| e.to_string())?;
            wr.write_image_data(&rgb).map_err(|e| e.to_string())?;
        }
        Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(out)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run a PowerShell script (elevated, since Halo is) and return combined output.
#[tauri::command]
pub async fn run_powershell(script: String, timeout_secs: Option<u64>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &format!("[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; {script}")])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut so = child.stdout.take().unwrap();
        let mut se = child.stderr.take().unwrap();
        let t1 = std::thread::spawn(move || {
            let mut b = vec![];
            let _ = so.read_to_end(&mut b);
            b
        });
        let t2 = std::thread::spawn(move || {
            let mut b = vec![];
            let _ = se.read_to_end(&mut b);
            b
        });
        let limit = Duration::from_secs(timeout_secs.unwrap_or(90));
        let start = Instant::now();
        let mut timed_out = false;
        loop {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                break;
            }
            if start.elapsed() > limit {
                let _ = child.kill();
                timed_out = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        let out = String::from_utf8_lossy(&t1.join().unwrap_or_default()).to_string();
        let err = String::from_utf8_lossy(&t2.join().unwrap_or_default()).to_string();
        let mut s = out.trim_end().to_string();
        if !err.trim().is_empty() {
            s.push_str(&format!("\n[stderr]\n{}", err.trim_end()));
        }
        if timed_out {
            s.push_str("\n[timed out and was stopped]");
        }
        s.push_str(&format!("\n[exit code {code}]"));
        if s.len() > 20_000 {
            let cut = s.char_indices().nth(20_000).map(|(i, _)| i).unwrap_or(s.len());
            s = format!("{}\n…[output truncated]", &s[..cut]);
        }
        Ok(s)
    })
    .await
    .map_err(|e| e.to_string())?
}
