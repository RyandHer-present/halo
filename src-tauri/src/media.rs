//! Now-playing info + controls via Windows' Global System Media Transport Controls
//! (works with Spotify, browsers/YouTube, Apple Music, etc.).

use base64::Engine;
use serde::Serialize;
use std::sync::Mutex;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::{DataReader, IRandomAccessStreamWithContentType};

#[derive(Serialize, Clone, Default)]
pub struct NowPlaying {
    pub active: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub app: String,
    pub playing: bool,
    pub position: f64, // seconds
    pub duration: f64,
    pub art: Option<String>, // data: URL
    pub art_key: String,
}

#[derive(Default)]
pub struct MediaCache {
    pub art_key: String,
    pub art: Option<String>,
}
pub struct MediaState(pub Mutex<MediaCache>);

fn session() -> windows::core::Result<Session> {
    let mgr = Manager::RequestAsync()?.join()?;
    mgr.GetCurrentSession()
}

fn read_art(stream: IRandomAccessStreamWithContentType) -> windows::core::Result<String> {
    let size = stream.Size()? as u32;
    let mime = stream.ContentType().map(|s| s.to_string()).unwrap_or_else(|_| "image/png".into());
    let reader = DataReader::CreateDataReader(&stream)?;
    reader.LoadAsync(size)?.join()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf)?;
    let mime = if mime.is_empty() { "image/png".to_string() } else { mime };
    Ok(format!("data:{};base64,{}", mime, base64::engine::general_purpose::STANDARD.encode(buf)))
}

fn now_playing_inner(cache: &mut MediaCache) -> windows::core::Result<NowPlaying> {
    let s = session()?;
    let props = s.TryGetMediaPropertiesAsync()?.join()?;
    let info = s.GetPlaybackInfo()?;
    let tl = s.GetTimelineProperties()?;
    let title = props.Title()?.to_string();
    let artist = props.Artist()?.to_string();
    let album = props.AlbumTitle().map(|a| a.to_string()).unwrap_or_default();
    let playing = info.PlaybackStatus()? == Status::Playing;

    // TimeSpan is in 100ns ticks. Position is only updated by the app occasionally, so
    // extrapolate from LastUpdatedTime while playing.
    let mut position = tl.Position()?.Duration as f64 / 1e7;
    let duration = (tl.EndTime()?.Duration - tl.StartTime()?.Duration) as f64 / 1e7;
    if playing {
        if let Ok(last) = tl.LastUpdatedTime() {
            // DateTime: 100ns ticks since 1601-01-01
            let now_ft = unsafe { windows::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime() };
            let now_ticks = ((now_ft.dwHighDateTime as i64) << 32) | now_ft.dwLowDateTime as i64;
            let elapsed = (now_ticks - last.UniversalTime) as f64 / 1e7;
            if elapsed > 0.0 && elapsed < 3600.0 {
                position += elapsed;
            }
        }
    }
    if duration > 0.0 {
        position = position.min(duration);
    }

    let key = format!("{}|{}|{}", title, artist, album);
    if key != cache.art_key {
        cache.art_key = key.clone();
        cache.art = props
            .Thumbnail()
            .ok()
            .and_then(|t| t.OpenReadAsync().ok())
            .and_then(|op| op.join().ok())
            .and_then(|st| read_art(st).ok());
    }

    let app = s
        .SourceAppUserModelId()
        .map(|a| a.to_string())
        .unwrap_or_default();
    let app = pretty_app(&app);

    Ok(NowPlaying {
        active: true,
        title,
        artist,
        album,
        app,
        playing,
        position,
        duration,
        art: cache.art.clone(),
        art_key: key,
    })
}

fn pretty_app(id: &str) -> String {
    let l = id.to_lowercase();
    for (k, v) in [
        ("spotify", "Spotify"),
        ("chrome", "Chrome"),
        ("msedge", "Edge"),
        ("firefox", "Firefox"),
        ("opera", "Opera"),
        ("brave", "Brave"),
        ("zunemusic", "Media Player"),
        ("applemusic", "Apple Music"),
        ("vlc", "VLC"),
        ("discord", "Discord"),
    ] {
        if l.contains(k) {
            return v.into();
        }
    }
    id.split(['!', '\\', '.']).filter(|s| !s.is_empty()).last().unwrap_or("").to_string()
}

#[tauri::command]
pub async fn now_playing(state: tauri::State<'_, MediaState>) -> Result<NowPlaying, String> {
    let mut cache = state.0.lock().unwrap();
    Ok(now_playing_inner(&mut cache).unwrap_or_default())
}

#[tauri::command]
pub async fn media_cmd(cmd: String, value: Option<f64>) -> Result<(), String> {
    let s = session().map_err(|e| e.to_string())?;
    let r = match cmd.as_str() {
        "toggle" => s.TryTogglePlayPauseAsync().and_then(|o| o.join()),
        "next" => s.TrySkipNextAsync().and_then(|o| o.join()),
        "prev" => s.TrySkipPreviousAsync().and_then(|o| o.join()),
        "seek" => s
            .TryChangePlaybackPositionAsync((value.unwrap_or(0.0) * 1e7) as i64)
            .and_then(|o| o.join()),
        _ => return Err("unknown command".into()),
    };
    r.map(|_| ()).map_err(|e| e.to_string())
}
