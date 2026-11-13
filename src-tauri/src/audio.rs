#![allow(non_snake_case, dead_code)]
//! Master volume, output device switching (via the undocumented-but-stable IPolicyConfig),
//! and per-app volume via audio sessions.

use serde::Serialize;
use std::ffi::c_void;
use windows::core::{interface, IUnknown, IUnknown_Vtbl, Interface, GUID, HRESULT, PCWSTR, PWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eConsole, eMultimedia, eCommunications, eRender, ERole, IAudioSessionControl2, IAudioSessionManager2,
    IMMDevice, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, AudioSessionStateExpired,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};

#[interface("f8679f50-850a-41cf-9c72-430f290290c8")]
unsafe trait IPolicyConfig: IUnknown {
    fn GetMixFormat(&self, a: PCWSTR, b: *mut c_void) -> HRESULT;
    fn GetDeviceFormat(&self, a: PCWSTR, b: i32, c: *mut c_void) -> HRESULT;
    fn ResetDeviceFormat(&self, a: PCWSTR) -> HRESULT;
    fn SetDeviceFormat(&self, a: PCWSTR, b: *mut c_void, c: *mut c_void) -> HRESULT;
    fn GetProcessingPeriod(&self, a: PCWSTR, b: i32, c: *mut i64, d: *mut i64) -> HRESULT;
    fn SetProcessingPeriod(&self, a: PCWSTR, b: *mut i64) -> HRESULT;
    fn GetShareMode(&self, a: PCWSTR, b: *mut c_void) -> HRESULT;
    fn SetShareMode(&self, a: PCWSTR, b: *mut c_void) -> HRESULT;
    fn GetPropertyValue(&self, a: PCWSTR, b: *const c_void, c: *mut c_void) -> HRESULT;
    fn SetPropertyValue(&self, a: PCWSTR, b: *const c_void, c: *mut c_void) -> HRESULT;
    fn SetDefaultEndpoint(&self, id: PCWSTR, role: ERole) -> HRESULT;
    fn SetEndpointVisibility(&self, a: PCWSTR, b: i32) -> HRESULT;
}
const CLSID_POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

#[derive(Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub default: bool,
}

#[derive(Serialize)]
pub struct AudioState {
    pub volume: f32, // 0..1
    pub muted: bool,
    pub devices: Vec<AudioDevice>,
}

#[derive(Serialize)]
pub struct AppVolume {
    pub pid: u32,
    pub name: String,
    pub volume: f32,
    pub muted: bool,
}

fn com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn enumerator() -> windows::core::Result<IMMDeviceEnumerator> {
    com();
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

fn default_device() -> windows::core::Result<IMMDevice> {
    unsafe { enumerator()?.GetDefaultAudioEndpoint(eRender, eConsole) }
}

fn endpoint() -> windows::core::Result<IAudioEndpointVolume> {
    unsafe { default_device()?.Activate(CLSCTX_ALL, None) }
}

fn pwstr_take(p: PWSTR) -> String {
    unsafe {
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as *const c_void));
        s
    }
}

fn device_name(d: &IMMDevice) -> String {
    unsafe {
        d.OpenPropertyStore(STGM_READ)
            .and_then(|ps| ps.GetValue(&PKEY_Device_FriendlyName))
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "Unknown device".into())
    }
}

fn audio_state() -> windows::core::Result<AudioState> {
    let ep = endpoint()?;
    let volume = unsafe { ep.GetMasterVolumeLevelScalar()? };
    let muted = unsafe { ep.GetMute()?.as_bool() };
    let en = enumerator()?;
    let default_id = unsafe { pwstr_take(en.GetDefaultAudioEndpoint(eRender, eConsole)?.GetId()?) };
    let coll = unsafe { en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)? };
    let mut devices = vec![];
    for i in 0..unsafe { coll.GetCount()? } {
        let d = unsafe { coll.Item(i)? };
        let id = unsafe { pwstr_take(d.GetId()?) };
        devices.push(AudioDevice { default: id == default_id, name: device_name(&d), id });
    }
    Ok(AudioState { volume, muted, devices })
}

#[tauri::command]
pub async fn get_audio() -> Result<AudioState, String> {
    audio_state().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_volume(volume: f32) -> Result<(), String> {
    let ep = endpoint().map_err(|e| e.to_string())?;
    unsafe { ep.SetMasterVolumeLevelScalar(volume.clamp(0.0, 1.0), std::ptr::null()) }
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_mute(muted: bool) -> Result<(), String> {
    let ep = endpoint().map_err(|e| e.to_string())?;
    unsafe { ep.SetMute(muted, std::ptr::null()) }.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_audio_device(id: String) -> Result<(), String> {
    com();
    let pc: IPolicyConfig =
        unsafe { CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL) }.map_err(|e| e.to_string())?;
    let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
    for role in [eConsole, eMultimedia, eCommunications] {
        unsafe { pc.SetDefaultEndpoint(PCWSTR(wide.as_ptr()), role) }
            .ok()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn process_name(pid: u32) -> String {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return "System sounds".into();
    }
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return format!("App {pid}");
        };
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return format!("App {pid}");
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        crate::icons::pretty_exe_name(&path)
    }
}

pub fn exe_path(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

fn sessions() -> windows::core::Result<Vec<(u32, ISimpleAudioVolume)>> {
    let dev = default_device()?;
    let mgr: IAudioSessionManager2 = unsafe { dev.Activate(CLSCTX_ALL, None)? };
    let en = unsafe { mgr.GetSessionEnumerator()? };
    let mut out = vec![];
    for i in 0..unsafe { en.GetCount()? } {
        let ctl = unsafe { en.GetSession(i)? };
        if unsafe { ctl.GetState()? } == AudioSessionStateExpired {
            continue;
        }
        let ctl2: IAudioSessionControl2 = ctl.cast()?;
        let pid = unsafe { ctl2.GetProcessId().unwrap_or(0) };
        let vol: ISimpleAudioVolume = ctl.cast()?;
        out.push((pid, vol));
    }
    Ok(out)
}

#[tauri::command]
pub async fn get_app_volumes() -> Result<Vec<AppVolume>, String> {
    let mut out: Vec<AppVolume> = vec![];
    for (pid, v) in sessions().map_err(|e| e.to_string())? {
        let name = process_name(pid);
        if out.iter().any(|a| a.pid == pid) {
            continue;
        }
        out.push(AppVolume {
            pid,
            name,
            volume: unsafe { v.GetMasterVolume().unwrap_or(1.0) },
            muted: unsafe { v.GetMute().map(|b| b.as_bool()).unwrap_or(false) },
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub async fn set_app_volume(pid: u32, volume: Option<f32>, muted: Option<bool>) -> Result<(), String> {
    for (p, v) in sessions().map_err(|e| e.to_string())? {
        if p != pid {
            continue;
        }
        unsafe {
            if let Some(vol) = volume {
                v.SetMasterVolume(vol.clamp(0.0, 1.0), std::ptr::null()).map_err(|e| e.to_string())?;
            }
            if let Some(m) = muted {
                v.SetMute(m, std::ptr::null()).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn get_exe_path(pid: u32) -> Option<String> {
    exe_path(pid)
}
