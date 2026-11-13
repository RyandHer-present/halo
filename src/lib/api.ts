import { invoke } from "@tauri-apps/api/core";

export interface Gpu {
  name: string;
  load: number;
  temp: number | null;
  vram_used: number;
  vram_total: number;
  power_w: number | null;
  fan_pct: number | null;
  clock_mhz: number | null;
}
export interface Disk { name: string; mount: string; total: number; free: number }
export interface Battery { percent: number; charging: boolean; plugged: boolean; minutes_left: number | null }
export interface Stats {
  cpu_name: string;
  cpu: number;
  cores: number[];
  cpu_mhz: number;
  cpu_temp: number | null;
  ram_used: number;
  ram_total: number;
  disks: Disk[];
  net_down: number;
  net_up: number;
  net_today_down: number;
  net_today_up: number;
  gpu: Gpu | null;
  battery: Battery | null;
  uptime: number;
  processes: number;
}
export interface NowPlaying {
  active: boolean;
  title: string;
  artist: string;
  album: string;
  app: string;
  playing: boolean;
  position: number;
  duration: number;
  art: string | null;
  art_key: string;
}
export interface AudioDevice { id: string; name: string; default: boolean }
export interface AudioState { volume: number; muted: boolean; devices: AudioDevice[] }
export interface AppVolume { pid: number; name: string; volume: number; muted: boolean }
export interface Game { id: string; name: string; source: "steam" | "prism"; art: string | null; subtitle: string; last_played: number }
export interface StartApp { name: string; path: string }
export interface Radios { wifi: boolean | null; bluetooth: boolean | null }
export interface WifiNet { ssid: string; signal: number; secure: boolean; known: boolean; connected: boolean }

export const api = {
  hide: () => invoke("hide_window"),
  quit: () => invoke("quit_app"),
  stats: () => invoke<Stats>("get_stats"),
  nowPlaying: () => invoke<NowPlaying>("now_playing"),
  media: (cmd: "toggle" | "next" | "prev" | "seek", value?: number) => invoke("media_cmd", { cmd, value }),
  audio: () => invoke<AudioState>("get_audio"),
  setVolume: (volume: number) => invoke("set_volume", { volume }),
  setMute: (muted: boolean) => invoke("set_mute", { muted }),
  setAudioDevice: (id: string) => invoke("set_audio_device", { id }),
  appVolumes: () => invoke<AppVolume[]>("get_app_volumes"),
  setAppVolume: (pid: number, volume?: number, muted?: boolean) => invoke("set_app_volume", { pid, volume, muted }),
  exePath: (pid: number) => invoke<string | null>("get_exe_path", { pid }),
  icon: (path: string) => invoke<string | null>("get_icon", { path }),
  games: () => invoke<Game[]>("get_games"),
  launchGame: (source: string, id: string) => invoke("launch_game", { source, id }),
  startApps: () => invoke<StartApp[]>("get_start_apps"),
  launchPath: (path: string, args?: string) => invoke("launch_path", { path, args }),
  readImage: (path: string) => invoke<string | null>("read_image", { path }),
  power: (action: string) => invoke("power_action", { action }),
  powerMode: () => invoke<string>("get_power_mode"),
  setPowerMode: (mode: string) => invoke("set_power_mode", { mode }),
  radios: () => invoke<Radios>("get_radios"),
  setRadio: (kind: "wifi" | "bluetooth", on: boolean) => invoke("set_radio", { kind, on }),
  wifi: () => invoke<WifiNet[]>("get_wifi"),
  connectWifi: (ssid: string, password?: string) => invoke("connect_wifi", { ssid, password }),
  disconnectWifi: () => invoke("disconnect_wifi"),
  windowsAccent: () => invoke<string | null>("get_windows_accent"),
  wallpaper: () => invoke<string | null>("get_wallpaper"),
  isAdmin: () => invoke<boolean>("is_admin"),
  setAutostart: (enabled: boolean) => invoke("set_autostart", { enabled }),
  getAutostart: () => invoke<boolean>("get_autostart"),
  // ---- tasks ----
  processes: () => invoke<Proc[]>("get_processes"),
  killProcess: (pid: number, tree?: boolean) => invoke("kill_process", { pid, tree }),
  killByName: (name: string) => invoke<string>("kill_by_name", { name }),
  setPriority: (pid: number, level: string) => invoke("set_priority", { pid, level }),
  openLocation: (path: string) => invoke("open_location", { path }),
  services: () => invoke<Service[]>("get_services"),
  serviceAction: (name: string, action: string) => invoke<string>("service_action", { name, action }),
  startup: () => invoke<StartupItem[]>("get_startup"),
  setStartup: (id: string, enabled: boolean) => invoke("set_startup", { id, enabled }),
  programs: () => invoke<Program[]>("get_programs"),
  uninstall: (id: string, uninstall: string) => invoke("uninstall_program", { id, uninstall }),
  // ---- alerts ----
  setAlerts: (cfg: AlertCfg) => invoke("set_alerts", { cfg }),
  toastPending: () => invoke<HaloToast[]>("toast_pending"),
  toastDone: () => invoke("toast_done"),
  testToast: () => invoke("test_toast"),
  // ---- files ----
  scanFolder: (path: string, fresh?: boolean) => invoke<FsEntry[]>("scan_folder", { path, fresh }),
  cancelScan: () => invoke("cancel_scan"),
  trash: (paths: string[]) => invoke("trash_paths", { paths }),
  restore: (paths: string[]) => invoke<number>("restore_paths", { paths }),
  cleanupScan: () => invoke<CleanCat[]>("cleanup_scan"),
  cleanupRun: (ids: string[]) => invoke<number>("cleanup_run", { ids }),
  bigFiles: (path?: string, minMb?: number) => invoke<FileInfo[]>("big_files", { path, minMb }),
  duplicates: () => invoke<FileInfo[][]>("find_duplicates"),
  quickFolders: () => invoke<{ name: string; path: string }[]>("quick_folders"),
  recentFiles: () => invoke<FileInfo[]>("recent_files"),
  sortDownloads: () => invoke<number>("sort_downloads_now"),
  cleanInstallers: () => invoke<number>("clean_installers_now"),
  organizerLog: () => invoke<Moved[]>("organizer_log"),
  setOrganizer: (cfg: { enabled: boolean; clean_installers: boolean }) => invoke("set_organizer", { cfg }),
  listDir: (path: string) => invoke<DirItem[]>("list_dir", { path }),
  readText: (path: string, max?: number) => invoke<string>("read_text", { path, max }),
  writeText: (path: string, content: string) => invoke<string | null>("write_text", { path, content }),
  movePath: (from: string, to: string) => invoke("move_path", { from, to }),
  exists: (path: string) => invoke<boolean>("path_exists", { path }),
  // ---- display ----
  displays: () => invoke<DisplayInfo[]>("get_displays"),
  setDisplayMode: (device: string, width: number, height: number, hz: number) => invoke("set_display_mode", { device, width, height, hz }),
  setHdr: (device: string, on: boolean) => invoke("set_hdr", { device, on }),
  setScale: (device: string, scale: number) => invoke("set_scale", { device, scale }),
  input: () => invoke<InputSettings>("get_input"),
  setInput: (key: string, value: number) => invoke("set_input", { key, value }),
  defaultApps: () => invoke<DefaultApp[]>("get_default_apps"),
  changeDefaultApp: (kind: string) => invoke("change_default_app", { kind }),
  // ---- network ----
  speedTest: () => invoke<SpeedResult>("speed_test"),
  scanLan: () => invoke<LanDevice[]>("scan_lan"),
  publicIp: () => invoke<any>("public_ip"),
  // ---- updates ----
  wingetUpdates: () => invoke<AppUpdate[]>("winget_updates"),
  wingetUpgrade: (id: string) => invoke<string>("winget_upgrade", { id }),
  wingetSearch: (query: string) => invoke<AppUpdate[]>("winget_search", { query }),
  wingetInstall: (id: string) => invoke<string>("winget_install", { id }),
  windowsUpdates: () => invoke<WinUpdate[]>("windows_updates"),
  installWindowsUpdates: (ids: string[]) => invoke<string>("install_windows_updates", { ids }),
  checkHaloUpdate: () => invoke<HaloUpdate>("check_halo_update"),
  installHaloUpdate: (url: string) => invoke("install_halo_update", { url }),
  // ---- notifications, AI helpers, fps ----
  notifications: () => invoke<Notif[]>("get_notifications"),
  openAumid: (aumid: string) => invoke("open_aumid", { aumid }),
  screenshot: () => invoke<string>("screenshot"),
  powershell: (script: string, timeoutSecs?: number) => invoke<string>("run_powershell", { script, timeoutSecs }),
  fpsToggle: () => invoke<boolean>("fps_toggle"),
  fpsRunning: () => invoke<boolean>("fps_running"),
};

export interface Proc { pid: number; parent: number | null; name: string; exe: string | null; cpu: number; mem: number; disk_read: number; disk_write: number; start: number; window: string | null }
export interface Service { name: string; display: string; state: string; start_mode: string; pid: number; description: string }
export interface StartupItem { id: string; name: string; command: string; path: string | null; enabled: boolean; location: string }
export interface Program { id: string; name: string; publisher: string; version: string; size: number; installed: string; icon: string | null; uninstall: string; kind: "win32" | "store" }
export interface AlertCfg { cpu_temp: number | null; gpu_temp: number | null; disk_free_pct: number | null; hog_cpu: number | null; net_down: boolean }
export interface HaloToast { id: number; title: string; body: string; kind: string }
export interface FsEntry { name: string; path: string; size: number; files: number; dir: boolean }
export interface CleanCat { id: string; name: string; desc: string; size: number; files: number }
export interface FileInfo { name: string; path: string; size: number; modified: number }
export interface Moved { name: string; folder: string; at: number }
export interface DirItem { name: string; dir: boolean; size: number; modified: number }
export interface Mode { width: number; height: number; hz: number }
export interface DisplayInfo { device: string; name: string; current: Mode; modes: Mode[]; scale: number | null; scales: number[]; hdr_supported: boolean; hdr_on: boolean; primary: boolean }
export interface InputSettings { mouse_speed: number; precision: boolean; swap_buttons: boolean; scroll_lines: number; double_click_ms: number; key_delay: number; key_speed: number; caret_blink_ms: number }
export interface DefaultApp { kind: string; label: string; app: string }
export interface SpeedResult { ping: number; jitter: number; down: number; up: number; server: string }
export interface SpeedProgress { phase: "ping" | "down" | "up" | "done"; mbps: number; ping: number; jitter: number; progress: number }
export interface LanDevice { ip: string; mac: string; name: string; latency: number | null; me: boolean; gateway: boolean }
export interface AppUpdate { name: string; id: string; version: string; available: string; source: string }
export interface WinUpdate { id: string; title: string; kind: string; size: number }
export interface HaloUpdate { current: string; latest: string | null; notes: string; url: string | null }
export interface Notif { id: number; app: string; aumid: string; title: string; body: string; time: number }
export interface FpsInfo { app: string; fps: number; frametime: number; low1: number; history: number[] }
