//! Extract crisp icons for any file/exe/shortcut as PNG data URLs (cached).

use base64::Engine;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
use windows::Win32::UI::Controls::{IImageList, ILD_TRANSPARENT};
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_SYSICONINDEX, SHIL_EXTRALARGE, SHIL_JUMBO};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

pub fn pretty_exe_name(path: &str) -> String {
    let stem = std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let mut c = stem.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => stem,
    }
}

fn hicon_rgba(icon: HICON) -> Option<(u32, u32, Vec<u8>)> {
    unsafe {
        let mut info = ICONINFO::default();
        GetIconInfo(icon, &mut info).ok()?;
        let color = info.hbmColor;
        let mut bm = BITMAP::default();
        GetObjectW(HGDIOBJ(color.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _));
        let (w, h) = (bm.bmWidth as u32, bm.bmHeight as u32);
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let dc = CreateCompatibleDC(None);
        let lines = GetDIBits(dc, color, 0, h, Some(buf.as_mut_ptr() as *mut _), &mut bmi, DIB_RGB_COLORS);
        let _ = DeleteDC(dc);
        let _ = DeleteObject(HGDIOBJ(color.0));
        let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));
        if lines == 0 || w == 0 {
            return None;
        }
        // BGRA -> RGBA; if there's no alpha at all, make it opaque.
        let has_alpha = buf.chunks(4).any(|p| p[3] != 0);
        for p in buf.chunks_mut(4) {
            p.swap(0, 2);
            if !has_alpha {
                p[3] = 255;
            }
        }
        Some((w, h, buf))
    }
}

fn icon_from_list(index: i32, size: i32) -> Option<(u32, u32, Vec<u8>)> {
    unsafe {
        let list: IImageList = SHGetImageList(size).ok()?;
        let icon = list.GetIcon(index, ILD_TRANSPARENT.0).ok()?;
        let r = hicon_rgba(icon);
        let _ = DestroyIcon(icon);
        r
    }
}

fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Option<String> {
    let mut out = vec![];
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().ok()?;
        wr.write_image_data(rgba).ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(out)))
}

pub fn icon_for(path: &str) -> Option<String> {
    let cache = CACHE.get_or_init(Default::default);
    if let Some(v) = cache.lock().unwrap().get(path) {
        return v.clone();
    }
    let result = (|| unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_APARTMENTTHREADED);
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut sfi = SHFILEINFOW::default();
        let r = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut sfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX,
        );
        if r == 0 {
            return None;
        }
        // Jumbo (256px) looks best, but apps with only small icons get a tiny icon in the corner;
        // detect that and fall back to 48px.
        if let Some((w, h, px)) = icon_from_list(sfi.iIcon, SHIL_JUMBO as i32) {
            let mut outside = false;
            'scan: for y in 0..h {
                for x in 0..w {
                    if (x >= 64 || y >= 64) && px[((y * w + x) * 4 + 3) as usize] != 0 {
                        outside = true;
                        break 'scan;
                    }
                }
            }
            if outside {
                return encode_png(w, h, &px);
            }
        }
        let (w, h, px) = icon_from_list(sfi.iIcon, SHIL_EXTRALARGE as i32)?;
        encode_png(w, h, &px)
    })();
    cache.lock().unwrap().insert(path.to_string(), result.clone());
    result
}

#[tauri::command]
pub async fn get_icon(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || icon_for(&path)).await.ok().flatten()
}
