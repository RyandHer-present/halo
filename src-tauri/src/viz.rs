//! Real audio visualizer: WASAPI loopback capture of whatever is playing, FFT -> log bands,
//! emitted to the UI as `halo://viz` at ~40 fps. Only runs while the UI asks for it.

use rustfft::{num_complex::Complex, FftPlanner};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;

pub struct VizState(pub std::sync::Mutex<Option<Arc<AtomicBool>>>);

const FFT: usize = 2048;
const BANDS: usize = 48;

#[tauri::command]
pub fn viz_start(app: AppHandle, state: tauri::State<VizState>) {
    let mut g = state.0.lock().unwrap();
    if g.is_some() {
        return;
    }
    let run = Arc::new(AtomicBool::new(true));
    *g = Some(run.clone());
    std::thread::spawn(move || {
        while run.load(Ordering::Relaxed) {
            if let Err(e) = capture(&app, &run) {
                eprintln!("viz: {e}");
            }
            // device changed / error: retry shortly
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

#[tauri::command]
pub fn viz_stop(state: tauri::State<VizState>) {
    if let Some(r) = state.0.lock().unwrap().take() {
        r.store(false, Ordering::Relaxed);
    }
}

fn capture(app: &AppHandle, run: &AtomicBool) -> windows::core::Result<()> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let dev = en.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let client: IAudioClient = dev.Activate(CLSCTX_ALL, None)?;
        let fmt = client.GetMixFormat()?;
        let channels = (*fmt).nChannels as usize;
        let rate = (*fmt).nSamplesPerSec as f32;
        let bits = (*fmt).wBitsPerSample;
        client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, fmt, None)?;
        CoTaskMemFree(Some(fmt as *const _));
        let cap: IAudioCaptureClient = client.GetService()?;
        client.Start()?;

        let mut ring = vec![0f32; FFT];
        let mut pos = 0usize;
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT);
        let window: Vec<f32> = (0..FFT).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT as f32).cos()).collect();
        let mut smooth = vec![0f32; BANDS];
        let mut peak_norm = 1e-3f32;
        let mut last_emit = Instant::now();
        let mut last_audio = Instant::now();

        // band edges, log-spaced 35 Hz .. 16 kHz
        let edges: Vec<usize> = (0..=BANDS)
            .map(|b| {
                let f = 35.0 * (16000.0f32 / 35.0).powf(b as f32 / BANDS as f32);
                ((f / rate) * FFT as f32).round().max(1.0) as usize
            })
            .collect();

        while run.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(10));
            loop {
                let n = cap.GetNextPacketSize()?;
                if n == 0 {
                    break;
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                for f in 0..frames as usize {
                    let mut s = 0f32;
                    if !silent && bits == 32 {
                        let p = data as *const f32;
                        for c in 0..channels {
                            s += *p.add(f * channels + c);
                        }
                        s /= channels as f32;
                    } else if !silent && bits == 16 {
                        let p = data as *const i16;
                        for c in 0..channels {
                            s += *p.add(f * channels + c) as f32 / 32768.0;
                        }
                        s /= channels as f32;
                    }
                    ring[pos] = s;
                    pos = (pos + 1) % FFT;
                }
                cap.ReleaseBuffer(frames)?;
                if frames > 0 && !silent {
                    last_audio = Instant::now();
                }
            }

            if last_emit.elapsed() < Duration::from_millis(25) {
                continue;
            }
            last_emit = Instant::now();

            let mut out = vec![0f32; BANDS];
            if last_audio.elapsed() < Duration::from_millis(300) {
                let mut buf: Vec<Complex<f32>> = (0..FFT)
                    .map(|i| Complex::new(ring[(pos + i) % FFT] * window[i], 0.0))
                    .collect();
                fft.process(&mut buf);
                let mut frame_max = 0f32;
                for b in 0..BANDS {
                    let (lo, hi) = (edges[b], edges[b + 1].max(edges[b] + 1));
                    let mut m = 0f32;
                    for k in lo..hi.min(FFT / 2) {
                        m = m.max(buf[k].norm());
                    }
                    // gentle tilt so highs aren't invisible
                    let v = m * (1.0 + b as f32 / BANDS as f32 * 2.5);
                    out[b] = v;
                    frame_max = frame_max.max(v);
                }
                // auto-gain
                peak_norm = (peak_norm * 0.995).max(frame_max).max(1e-3);
                for v in out.iter_mut() {
                    *v = (*v / peak_norm).powf(0.7).min(1.0);
                }
            }
            for b in 0..BANDS {
                // fast attack, slow release
                smooth[b] = if out[b] > smooth[b] { smooth[b] * 0.4 + out[b] * 0.6 } else { smooth[b] * 0.82 + out[b] * 0.18 };
            }
            let _ = app.emit("halo://viz", &smooth);
        }
        let _ = client.Stop();
        Ok(())
    }
}
