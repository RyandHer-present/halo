//! Notification feed: reads a copy of Windows' own notification database (read-only).

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Clone)]
pub struct Notif {
    pub id: i64,
    pub app: String,
    pub aumid: String,
    pub title: String,
    pub body: String,
    pub time: i64, // unix seconds
}

static CACHE: Mutex<Option<(std::time::SystemTime, Vec<Notif>)>> = Mutex::new(None);

fn db_dir() -> PathBuf {
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join(r"Microsoft\Windows\Notifications")
}

fn xml_texts(xml: &str) -> Vec<String> {
    let mut out = vec![];
    let mut rest = xml;
    while let Some(i) = rest.find("<text") {
        rest = &rest[i + 5..];
        let Some(gt) = rest.find('>') else { break };
        if rest[..gt].ends_with('/') {
            rest = &rest[gt + 1..];
            continue;
        }
        let body = &rest[gt + 1..];
        let Some(end) = body.find("</text>") else { break };
        let t = body[..end]
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&#39;", "'");
        let t = t.trim().to_string();
        if !t.is_empty() {
            out.push(t);
        }
        rest = &body[end..];
    }
    out
}

/// "Microsoft.WindowsStore_8wekyb3d8bbwe!App" -> "Windows Store", "com.squirrel.Discord.Discord" -> "Discord"
fn app_name(aumid: &str) -> String {
    let base = aumid.split('!').next().unwrap_or(aumid);
    let base = base.split('_').next().unwrap_or(base);
    if base.contains('\\') || base.contains(':') {
        // an exe path
        return crate::icons::pretty_exe_name(base);
    }
    let last = base.rsplit('.').next().unwrap_or(base);
    let mut s = String::new();
    let chars: Vec<char> = last.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if i > 0 && c.is_uppercase() && chars[i - 1].is_lowercase() {
            s.push(' ');
        }
        s.push(*c);
    }
    match s.as_str() {
        "Windows Store" => "Microsoft Store".into(),
        "Chrome" => "Google Chrome".into(),
        _ => s,
    }
}

#[tauri::command]
pub async fn get_notifications() -> Result<Vec<Notif>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = db_dir();
        let db = dir.join("wpndatabase.db");
        let wal = dir.join("wpndatabase.db-wal");
        let stamp = std::fs::metadata(&wal).or_else(|_| std::fs::metadata(&db)).and_then(|m| m.modified()).map_err(|e| e.to_string())?;
        if let Some((t, v)) = CACHE.lock().unwrap().as_ref() {
            if *t == stamp {
                return Ok(v.clone());
            }
        }
        // Copy db + WAL so we never lock Windows' live file.
        let tmp = std::env::temp_dir().join("halo-notifs");
        let _ = std::fs::create_dir_all(&tmp);
        for f in ["wpndatabase.db", "wpndatabase.db-wal", "wpndatabase.db-shm"] {
            let _ = std::fs::remove_file(tmp.join(f));
            let _ = std::fs::copy(dir.join(f), tmp.join(f));
        }
        let con = rusqlite::Connection::open(tmp.join("wpndatabase.db")).map_err(|e| e.to_string())?;
        let mut st = con
            .prepare(
                "SELECT n.Id, n.Payload, n.ArrivalTime, h.PrimaryId FROM Notification n \
                 JOIN NotificationHandler h ON n.HandlerId = h.RecordId \
                 WHERE n.Type = 'toast' ORDER BY n.ArrivalTime DESC LIMIT 80",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| {
                let id: i64 = r.get(0)?;
                let payload: Vec<u8> = r.get::<_, Vec<u8>>(1).or_else(|_| r.get::<_, String>(1).map(|s| s.into_bytes()))?;
                let at: i64 = r.get(2)?;
                let aumid: String = r.get(3)?;
                Ok((id, payload, at, aumid))
            })
            .map_err(|e| e.to_string())?;
        let mut out = vec![];
        for row in rows.flatten() {
            let (id, payload, at, aumid) = row;
            let xml = String::from_utf8_lossy(&payload);
            let texts = xml_texts(&xml);
            if texts.is_empty() {
                continue;
            }
            out.push(Notif {
                id,
                app: app_name(&aumid),
                title: texts[0].clone(),
                body: texts[1..].join("\n"),
                time: at / 10_000_000 - 11_644_473_600,
                aumid,
            });
        }
        *CACHE.lock().unwrap() = Some((stamp, out.clone()));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn open_aumid(aumid: String) -> Result<(), String> {
    crate::launcher::shell_open(&format!("shell:AppsFolder\\{aumid}"), "")
}
