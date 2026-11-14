//! Speed test (Cloudflare), LAN device scan, and HTTP helpers.

use serde::Serialize;
use std::net::Ipv4Addr;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub fn client() -> reqwest::Client {
    reqwest::Client::builder().user_agent("Halo-Dashboard").timeout(Duration::from_secs(60)).build().unwrap()
}

#[derive(Serialize, Clone)]
pub struct SpeedProgress {
    pub phase: String, // "ping" | "down" | "up" | "done"
    pub mbps: f64,
    pub ping: f64,
    pub jitter: f64,
    pub progress: f64,
}

#[derive(Serialize, Clone, Default)]
pub struct SpeedResult {
    pub ping: f64,
    pub jitter: f64,
    pub down: f64,
    pub up: f64,
    pub server: String,
}

#[tauri::command]
pub async fn speed_test(app: AppHandle) -> Result<SpeedResult, String> {
    let c = client();
    let emit = |phase: &str, mbps: f64, ping: f64, jitter: f64, progress: f64| {
        let _ = app.emit("halo://speed", SpeedProgress { phase: phase.into(), mbps, ping, jitter, progress });
    };
    // ping: small requests
    let mut pings = vec![];
    let mut server = String::new();
    for i in 0..8 {
        let t = Instant::now();
        let r = c.get("https://speed.cloudflare.com/__down?bytes=0").send().await.map_err(|e| e.to_string())?;
        if server.is_empty() {
            server = r.headers().get("cf-meta-colo").and_then(|v| v.to_str().ok()).unwrap_or("Cloudflare").to_string();
        }
        let _ = r.bytes().await;
        if i > 0 {
            pings.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let p = pings.iter().cloned().fold(f64::MAX, f64::min);
        emit("ping", 0.0, if p == f64::MAX { 0.0 } else { p }, 0.0, i as f64 / 8.0);
    }
    pings.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let ping = pings[pings.len() / 2];
    let jitter = pings.windows(2).map(|w| (w[1] - w[0]).abs()).sum::<f64>() / (pings.len().max(2) - 1) as f64;

    // download: parallel streams for ~10 s
    let down = {
        let total = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let start = Instant::now();
        let dur = Duration::from_secs(10);
        let mut tasks = vec![];
        for _ in 0..4 {
            let c = c.clone();
            let total = total.clone();
            tasks.push(tauri::async_runtime::spawn(async move {
                while start.elapsed() < dur {
                    let Ok(mut r) = c.get("https://speed.cloudflare.com/__down?bytes=50000000").send().await else { break };
                    while let Ok(Some(chunk)) = r.chunk().await {
                        total.fetch_add(chunk.len() as u64, std::sync::atomic::Ordering::Relaxed);
                        if start.elapsed() >= dur {
                            break;
                        }
                    }
                }
            }));
        }
        while start.elapsed() < dur {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let mbps = total.load(std::sync::atomic::Ordering::Relaxed) as f64 * 8.0 / start.elapsed().as_secs_f64() / 1e6;
            emit("down", mbps, ping, jitter, start.elapsed().as_secs_f64() / dur.as_secs_f64());
        }
        for t in tasks {
            let _ = t.await;
        }
        total.load(std::sync::atomic::Ordering::Relaxed) as f64 * 8.0 / start.elapsed().as_secs_f64() / 1e6
    };

    // upload: repeated 4 MB posts on 3 streams for ~8 s
    let up = {
        let total = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let start = Instant::now();
        let dur = Duration::from_secs(8);
        let body = vec![b'0'; 4_000_000];
        let mut tasks = vec![];
        for _ in 0..3 {
            let c = c.clone();
            let total = total.clone();
            let body = body.clone();
            tasks.push(tauri::async_runtime::spawn(async move {
                while start.elapsed() < dur {
                    if c.post("https://speed.cloudflare.com/__up").body(body.clone()).send().await.is_err() {
                        break;
                    }
                    total.fetch_add(body.len() as u64, std::sync::atomic::Ordering::Relaxed);
                }
            }));
        }
        while start.elapsed() < dur {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let mbps = total.load(std::sync::atomic::Ordering::Relaxed) as f64 * 8.0 / start.elapsed().as_secs_f64() / 1e6;
            emit("up", mbps, ping, jitter, start.elapsed().as_secs_f64() / dur.as_secs_f64());
        }
        for t in tasks {
            let _ = t.await;
        }
        total.load(std::sync::atomic::Ordering::Relaxed) as f64 * 8.0 / start.elapsed().as_secs_f64().max(0.1) / 1e6
    };
    emit("done", down, ping, jitter, 1.0);
    Ok(SpeedResult { ping, jitter, down, up, server })
}

// ---------------- LAN devices ----------------

#[derive(Serialize, Clone)]
pub struct Device {
    pub ip: String,
    pub mac: String,
    pub name: String,
    pub latency: Option<u32>,
    pub me: bool,
    pub gateway: bool,
}

fn local_ip() -> Option<Ipv4Addr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    match s.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(v) => Some(v),
        _ => None,
    }
}

fn ping(ip: Ipv4Addr, timeout_ms: u32) -> Option<u32> {
    use windows::Win32::NetworkManagement::IpHelper::*;
    unsafe {
        let h = IcmpCreateFile().ok()?;
        let data = [0u8; 8];
        let mut reply = vec![0u8; std::mem::size_of::<ICMP_ECHO_REPLY>() + 8 + 16];
        let n = IcmpSendEcho(h, u32::from_le_bytes(ip.octets()), data.as_ptr() as *const _, data.len() as u16, None, reply.as_mut_ptr() as *mut _, reply.len() as u32, timeout_ms);
        let _ = IcmpCloseHandle(h);
        if n == 0 {
            return None;
        }
        let r = &*(reply.as_ptr() as *const ICMP_ECHO_REPLY);
        if r.Status == 0 { Some(r.RoundTripTime) } else { None }
    }
}

fn arp_table() -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    if let Ok(out) = crate::system::run_hidden("arp", &["-a"]) {
        for line in out.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 && parts[0].parse::<Ipv4Addr>().is_ok() && parts[1].contains('-') && parts[1] != "ff-ff-ff-ff-ff-ff" {
                m.insert(parts[0].to_string(), parts[1].to_uppercase().replace('-', ":"));
            }
        }
    }
    m
}

fn gateway() -> Option<String> {
    let out = crate::system::run_hidden("powershell", &["-NoProfile", "-Command", "(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object RouteMetric | Select-Object -First 1).NextHop"]).ok()?;
    let g = out.trim().to_string();
    if g.parse::<Ipv4Addr>().is_ok() { Some(g) } else { None }
}

#[tauri::command]
pub async fn scan_lan() -> Result<Vec<Device>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let me = local_ip().ok_or("not connected to a network")?;
        let o = me.octets();
        let gw = gateway();
        let results = std::sync::Mutex::new(vec![]);
        let all: Vec<u8> = (1u8..=254).collect();
        std::thread::scope(|sc| {
            for chunk in all.chunks(32) {
                let results = &results;
                sc.spawn(move || {
                    for &last in chunk {
                        let ip = Ipv4Addr::new(o[0], o[1], o[2], last);
                        if let Some(rtt) = ping(ip, 600) {
                            results.lock().unwrap().push((ip, Some(rtt)));
                        }
                    }
                });
            }
        });
        let mut found = results.into_inner().unwrap();
        // devices that ignore ping still show up in the ARP cache
        let arp = arp_table();
        for ip in arp.keys() {
            if let Ok(a) = ip.parse::<Ipv4Addr>() {
                let ao = a.octets();
                if ao[0] == o[0] && ao[1] == o[1] && ao[2] == o[2] && ao[3] != 255 && !found.iter().any(|(f, _)| *f == a) {
                    found.push((a, None));
                }
            }
        }
        if !found.iter().any(|(f, _)| *f == me) {
            found.push((me, Some(0)));
        }
        let names = std::sync::Mutex::new(std::collections::HashMap::new());
        std::thread::scope(|sc| {
            for (ip, _) in &found {
                let names = &names;
                let ip = *ip;
                sc.spawn(move || {
                    if let Ok(n) = dns_lookup::lookup_addr(&std::net::IpAddr::V4(ip)) {
                        if n != ip.to_string() {
                            names.lock().unwrap().insert(ip, n);
                        }
                    }
                });
            }
        });
        let names = names.into_inner().unwrap();
        let host = std::env::var("COMPUTERNAME").unwrap_or_default();
        let mut out: Vec<Device> = found
            .into_iter()
            .map(|(ip, lat)| {
                let s = ip.to_string();
                Device {
                    mac: arp.get(&s).cloned().unwrap_or_default(),
                    name: if ip == me { format!("{host} (this PC)") } else { names.get(&ip).cloned().unwrap_or_default().trim_end_matches(".lan").trim_end_matches(".local").to_string() },
                    latency: lat,
                    me: ip == me,
                    gateway: gw.as_deref() == Some(s.as_str()),
                    ip: s,
                }
            })
            .collect();
        out.sort_by_key(|d| d.ip.parse::<Ipv4Addr>().map(|i| u32::from(i)).unwrap_or(0));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Public IP + ISP info for the network page.
#[tauri::command]
pub async fn public_ip() -> Result<serde_json::Value, String> {
    client().get("https://ipwho.is/").send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())
}

/// Download a URL to a file, emitting progress as "halo://download".
pub async fn download(app: &AppHandle, url: &str, dest: &std::path::Path, tag: &str) -> Result<(), String> {
    let mut r = client().get(url).timeout(Duration::from_secs(600)).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("download failed: {}", r.status()));
    }
    let total = r.content_length().unwrap_or(0);
    let tmp = dest.with_extension("part");
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut got = 0u64;
    use std::io::Write;
    while let Some(chunk) = r.chunk().await.map_err(|e| e.to_string())? {
        f.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        let _ = app.emit("halo://download", serde_json::json!({ "tag": tag, "got": got, "total": total }));
    }
    drop(f);
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

/// Text-to-speech request made from Rust, because voice APIs (Fish Audio) block browser
/// (CORS) requests from the webview. Returns the audio as base64.
#[tauri::command]
pub async fn tts_request(url: String, auth: String, body: serde_json::Value, extra_header: Option<(String, String)>) -> Result<String, String> {
    use base64::Engine;
    if !(url.starts_with("https://api.fish.audio/") || url.starts_with("https://api.groq.com/")) {
        return Err("voice service not allowed".into());
    }
    let mut req = client().post(&url).bearer_auth(auth).json(&body);
    if let Some((k, v)) = extra_header {
        req = req.header(k, v);
    }
    let r = req.send().await.map_err(|e| format!("Couldn't reach the voice service: {e}"))?;
    let status = r.status().as_u16();
    let bytes = r.bytes().await.map_err(|e| e.to_string())?;
    if status >= 400 {
        let text = String::from_utf8_lossy(&bytes).to_string();
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|j| {
                j.get("message").or(j.get("detail")).or(j.pointer("/error/message")).map(|m| match m {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(format!("{status}: {msg}"));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}
