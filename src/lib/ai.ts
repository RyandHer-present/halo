// Halo's assistant: Gemini (default) or Claude, with tools that control the PC.
// Full freedom (no confirmations); every action is logged and most can be undone.
// Deletes always go to the Recycle Bin.
import Anthropic from "@anthropic-ai/sdk";
import { create } from "zustand";
import { persist, createJSONStorage, StateStorage } from "zustand/middleware";
import { LazyStore } from "@tauri-apps/plugin-store";
import { api } from "./api";
import { useSettings, useUi, toast } from "./store";
import { THEMES } from "./themes";
import { launchByName, runCommand } from "./actions";
import { useLive } from "./live";

// ---------------- persisted state ----------------
const disk = new LazyStore("halo-ai.json");
// no writes until saved chats have loaded (an early write would wipe them)
let aiLoaded = false;
const storage: StateStorage = {
  getItem: async (k) => ((await disk.get<string>(k)) ?? null),
  setItem: async (k, v) => { if (!aiLoaded) return; await disk.set(k, v); await disk.save(); },
  removeItem: async (k) => { await disk.delete(k); await disk.save(); },
};

export interface ToolCall { name: string; args: Record<string, unknown>; result: string; ok: boolean; logId?: string }
export interface ChatMsg { id: string; role: "user" | "assistant"; text: string; time: number; tools?: ToolCall[]; image?: boolean; error?: boolean }
export interface Chat { id: string; title: string; created: number; messages: ChatMsg[] }
export interface UndoStep { kind: string; args: Record<string, unknown>; label: string }
export interface LogEntry { id: string; time: number; tool: string; summary: string; ok: boolean; undo?: UndoStep; undone?: boolean }

interface AiState {
  chats: Chat[];
  currentId: string | null;
  memory: string[];
  log: LogEntry[];
  // live (not persisted)
  busy: boolean;
  live: string; // streaming text of the current reply
  liveTools: ToolCall[];
  status: string;
  pending: string | null; // prompt handed over from the command bar
  set: (p: Partial<AiState>) => void;
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const useAi = create<AiState>()(
  persist(
    (set) => ({
      chats: [],
      currentId: null,
      memory: [],
      log: [],
      busy: false,
      live: "",
      liveTools: [],
      status: "",
      pending: null,
      set: (p) => set(p),
    }),
    {
      name: "ai",
      version: 1,
      storage: createJSONStorage(() => storage),
      onRehydrateStorage: () => (_state, error) => { if (!error) aiLoaded = true; },
      partialize: (s) => ({ chats: s.chats.slice(0, 60), currentId: s.currentId, memory: s.memory, log: s.log.slice(0, 200) }) as any,
    },
  ),
);

function updateChat(id: string, f: (c: Chat) => Chat) {
  useAi.setState((s) => ({ chats: s.chats.map((c) => (c.id === id ? f(c) : c)) }));
}

export function newChat(): string {
  const c: Chat = { id: uid(), title: "New chat", created: Date.now(), messages: [] };
  useAi.setState((s) => ({ chats: [c, ...s.chats], currentId: c.id }));
  return c.id;
}

function logAction(tool: string, summary: string, ok: boolean, undo?: UndoStep): string {
  const e: LogEntry = { id: uid(), time: Date.now(), tool, summary, ok, undo };
  useAi.setState((s) => ({ log: [e, ...s.log].slice(0, 200) }));
  return e.id;
}

// ---------------- tools ----------------
type Param = { type: "string" | "number" | "integer" | "boolean" | "array"; description?: string; enum?: string[]; items?: { type: string } };
interface ToolResult { text: string; image?: string; undo?: UndoStep; summary?: string }
interface Tool {
  name: string;
  description: string;
  params: Record<string, Param>;
  required?: string[];
  run: (a: any) => Promise<ToolResult | string>;
}

const pct = (v: number) => Math.round(v * 100);
const fmtGB = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

async function statusText() {
  const s = useLive.getState().stats ?? (await api.stats());
  const [audio, radios, mode, media] = await Promise.all([api.audio().catch(() => null), api.radios().catch(() => null), api.powerMode().catch(() => ""), api.nowPlaying().catch(() => null)]);
  return JSON.stringify({
    cpu: `${Math.round(s.cpu)}% @ ${(s.cpu_mhz / 1000).toFixed(1)} GHz`, cpu_temp_c: s.cpu_temp,
    gpu: s.gpu ? { name: s.gpu.name, load: s.gpu.load, temp_c: s.gpu.temp, vram: `${fmtGB(s.gpu.vram_used)} / ${fmtGB(s.gpu.vram_total)}` } : "asleep",
    ram: `${fmtGB(s.ram_used)} / ${fmtGB(s.ram_total)}`,
    disks: s.disks.map((d) => `${d.mount} ${fmtGB(d.free)} free of ${fmtGB(d.total)}`),
    network: `down ${(s.net_down / 1e6).toFixed(2)} MB/s, up ${(s.net_up / 1e6).toFixed(2)} MB/s`,
    battery: s.battery ? `${s.battery.percent}% ${s.battery.charging ? "charging" : s.battery.plugged ? "plugged in" : "on battery"}` : "no battery / AC",
    uptime_hours: +(s.uptime / 3600).toFixed(1), processes: s.processes,
    volume: audio ? `${pct(audio.volume)}%${audio.muted ? " (muted)" : ""}` : null,
    output_device: audio?.devices.find((d) => d.default)?.name,
    wifi: radios?.wifi, bluetooth: radios?.bluetooth, power_mode: mode,
    now_playing: media?.active ? `${media.title} — ${media.artist} (${media.playing ? "playing" : "paused"}, ${media.app})` : "nothing",
    theme: useSettings.getState().theme,
  });
}

const TOOLS: Tool[] = [
  {
    name: "get_system_status",
    description: "Current CPU/GPU/RAM/disk/network/battery, temperatures, volume, output device, Wi-Fi/Bluetooth, power mode, now playing.",
    params: {},
    run: async () => statusText(),
  },
  {
    name: "list_processes",
    description: "Running processes with CPU %, memory and PID, sorted.",
    params: { sort: { type: "string", enum: ["cpu", "memory"] }, limit: { type: "integer", description: "default 25" } },
    run: async ({ sort = "cpu", limit = 25 }) => {
      const ps = await api.processes();
      ps.sort((a, b) => (sort === "memory" ? b.mem - a.mem : b.cpu - a.cpu));
      return ps.slice(0, limit).map((p) => `${p.pid}\t${p.name}\t${p.cpu.toFixed(1)}% CPU\t${(p.mem / 1e6).toFixed(0)} MB${p.window ? `\twindow: ${p.window}` : ""}`).join("\n");
    },
  },
  {
    name: "end_process",
    description: "Force-close a process by PID or by name (e.g. 'chrome' ends every chrome.exe).",
    params: { pid: { type: "integer" }, name: { type: "string" } },
    run: async ({ pid, name }) => {
      let exe: string | null = null;
      if (pid) {
        exe = await api.exePath(pid).catch(() => null);
        await api.killProcess(pid, true);
      } else if (name) {
        const ps = await api.processes();
        const hit = ps.find((p) => p.name.toLowerCase().replace(/\.exe$/, "") === String(name).toLowerCase().replace(/\.exe$/, ""));
        exe = hit?.exe ?? null;
        await api.killByName(name);
      } else throw new Error("give pid or name");
      return { text: "ended", summary: `Ended ${name ?? `PID ${pid}`}`, undo: exe ? { kind: "launch", args: { path: exe }, label: "Reopen it" } : undefined };
    },
  },
  {
    name: "set_volume",
    description: "Set the master volume 0-100 (also unmutes).",
    params: { level: { type: "integer" } },
    required: ["level"],
    run: async ({ level }) => {
      const a = await api.audio();
      await api.setVolume(Math.max(0, Math.min(100, level)) / 100);
      await api.setMute(false);
      return { text: `volume ${level}%`, summary: `Volume ${pct(a.volume)}% → ${level}%`, undo: { kind: "volume", args: { v: a.volume, muted: a.muted }, label: `Back to ${pct(a.volume)}%` } };
    },
  },
  {
    name: "set_mute",
    description: "Mute or unmute the master volume.",
    params: { muted: { type: "boolean" } },
    required: ["muted"],
    run: async ({ muted }) => {
      await api.setMute(!!muted);
      return { text: "ok", summary: muted ? "Muted" : "Unmuted", undo: { kind: "mute", args: { muted: !muted }, label: muted ? "Unmute" : "Mute" } };
    },
  },
  {
    name: "set_audio_output",
    description: "Switch the default speaker/headphone device. Call with no name to list devices.",
    params: { name: { type: "string", description: "part of the device name" } },
    run: async ({ name }) => {
      const a = await api.audio();
      if (!name) return a.devices.map((d) => `${d.name}${d.default ? " (current)" : ""}`).join("\n");
      const d = a.devices.find((x) => x.name.toLowerCase().includes(String(name).toLowerCase()));
      if (!d) throw new Error(`no device matching ${name}; devices: ${a.devices.map((x) => x.name).join(", ")}`);
      const prev = a.devices.find((x) => x.default);
      await api.setAudioDevice(d.id);
      return { text: `now using ${d.name}`, summary: `Audio → ${d.name}`, undo: prev ? { kind: "audio_device", args: { id: prev.id }, label: `Back to ${prev.name}` } : undefined };
    },
  },
  {
    name: "media_control",
    description: "Control whatever media is playing.",
    params: { action: { type: "string", enum: ["play_pause", "next", "previous"] } },
    required: ["action"],
    run: async ({ action }) => {
      await api.media(action === "next" ? "next" : action === "previous" ? "prev" : "toggle");
      return { text: "ok", summary: `Media: ${action}` };
    },
  },
  {
    name: "set_radio",
    description: "Turn Wi-Fi or Bluetooth on/off.",
    params: { radio: { type: "string", enum: ["wifi", "bluetooth"] }, on: { type: "boolean" } },
    required: ["radio", "on"],
    run: async ({ radio, on }) => {
      await api.setRadio(radio, !!on);
      return { text: "ok", summary: `${radio === "wifi" ? "Wi-Fi" : "Bluetooth"} ${on ? "on" : "off"}`, undo: { kind: "radio", args: { radio, on: !on }, label: `Turn ${on ? "off" : "on"}` } };
    },
  },
  {
    name: "wifi",
    description: "List nearby Wi-Fi networks, or connect/disconnect.",
    params: { action: { type: "string", enum: ["list", "connect", "disconnect"] }, ssid: { type: "string" }, password: { type: "string" } },
    required: ["action"],
    run: async ({ action, ssid, password }) => {
      if (action === "list") return (await api.wifi()).map((n) => `${n.ssid} ${n.signal}%${n.connected ? " (connected)" : n.known ? " (saved)" : ""}${n.secure ? "" : " open"}`).join("\n");
      if (action === "disconnect") { await api.disconnectWifi(); return { text: "disconnected", summary: "Disconnected Wi-Fi" }; }
      await api.connectWifi(ssid, password);
      return { text: `connecting to ${ssid}`, summary: `Joined ${ssid}` };
    },
  },
  {
    name: "power",
    description: "Lock, sleep, hibernate, shut down, restart, or sign out of the PC. Runs right away.",
    params: { action: { type: "string", enum: ["lock", "sleep", "hibernate", "shutdown", "restart", "signout"] } },
    required: ["action"],
    run: async ({ action }) => {
      logAction("power", `Power: ${action}`, true);
      setTimeout(() => { if (action !== "lock") api.hide(); api.power(action); }, 1500);
      return `${action} in 1.5 s`;
    },
  },
  {
    name: "set_power_mode",
    description: "Windows power mode.",
    params: { mode: { type: "string", enum: ["efficiency", "balanced", "performance"] } },
    required: ["mode"],
    run: async ({ mode }) => {
      const prev = await api.powerMode();
      await api.setPowerMode(mode);
      return { text: "ok", summary: `Power mode ${prev} → ${mode}`, undo: { kind: "power_mode", args: { mode: prev }, label: `Back to ${prev}` } };
    },
  },
  {
    name: "launch",
    description: "Open an installed app or game (Steam, Minecraft Prism instances) by name.",
    params: { name: { type: "string" } },
    required: ["name"],
    run: async ({ name }) => {
      const r = await launchByName(name);
      return { text: r, summary: r };
    },
  },
  {
    name: "open",
    description: "Open a URL, file, folder, or ms-settings: page with its default handler.",
    params: { target: { type: "string" } },
    required: ["target"],
    run: async ({ target }) => {
      await api.launchPath(target);
      return { text: "opened", summary: `Opened ${target}` };
    },
  },
  {
    name: "run_powershell",
    description: "Run any PowerShell command/script as administrator and get its output. Use for anything the other tools can't do. Prefer reversible commands; for deleting files use delete_files instead.",
    params: { script: { type: "string" }, timeout_seconds: { type: "integer" } },
    required: ["script"],
    run: async ({ script, timeout_seconds }) => {
      const out = await api.powershell(script, timeout_seconds);
      return { text: out, summary: `PowerShell: ${String(script).slice(0, 80)}` };
    },
  },
  {
    name: "list_folder",
    description: "List a folder's contents. Use %USERPROFILE%-style paths expanded, e.g. C:\\Users\\<name>\\Downloads.",
    params: { path: { type: "string" } },
    required: ["path"],
    run: async ({ path }) => {
      const items = await api.listDir(path);
      return items.slice(0, 300).map((i) => `${i.dir ? "[dir] " : ""}${i.name}${i.dir ? "" : `  ${(i.size / 1e6).toFixed(2)} MB`}`).join("\n") || "(empty)";
    },
  },
  {
    name: "read_file",
    description: "Read a text file.",
    params: { path: { type: "string" } },
    required: ["path"],
    run: async ({ path }) => api.readText(path),
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file (undoable).",
    params: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    run: async ({ path, content }) => {
      const old = await api.writeText(path, content);
      return { text: "written", summary: `Wrote ${path}`, undo: { kind: "restore_file", args: { path, old }, label: old == null ? "Delete it" : "Restore old version" } };
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file/folder (undoable).",
    params: { from: { type: "string" }, to: { type: "string" } },
    required: ["from", "to"],
    run: async ({ from, to }) => {
      await api.movePath(from, to);
      return { text: "moved", summary: `Moved ${from} → ${to}`, undo: { kind: "move", args: { from: to, to: from }, label: "Move back" } };
    },
  },
  {
    name: "delete_files",
    description: "Send files/folders to the Recycle Bin (undoable).",
    params: { paths: { type: "array", items: { type: "string" } } },
    required: ["paths"],
    run: async ({ paths }) => {
      await api.trash(paths);
      return { text: `moved ${paths.length} item(s) to the Recycle Bin`, summary: `Recycled ${paths.length === 1 ? paths[0] : `${paths.length} items`}`, undo: { kind: "restore", args: { paths }, label: "Restore" } };
    },
  },
  {
    name: "take_screenshot",
    description: "Look at the user's screen (Halo itself is hidden from the capture).",
    params: {},
    run: async () => ({ text: "Screenshot attached.", image: await api.screenshot(), summary: "Looked at the screen" }),
  },
  {
    name: "remember",
    description: "Save a lasting fact or preference about the user for future chats.",
    params: { fact: { type: "string" } },
    required: ["fact"],
    run: async ({ fact }) => {
      useAi.setState((s) => ({ memory: [...s.memory, String(fact)] }));
      return { text: "saved", summary: `Remembered: ${fact}`, undo: { kind: "forget", args: { fact }, label: "Forget" } };
    },
  },
  {
    name: "forget",
    description: "Remove a saved memory (matching text).",
    params: { text: { type: "string" } },
    required: ["text"],
    run: async ({ text }) => {
      const before = useAi.getState().memory;
      const gone = before.filter((m) => m.toLowerCase().includes(String(text).toLowerCase()));
      useAi.setState({ memory: before.filter((m) => !gone.includes(m)) });
      return { text: `forgot ${gone.length}`, summary: `Forgot ${gone.length} memory`, undo: gone.length ? { kind: "remember_all", args: { facts: gone }, label: "Bring back" } : undefined };
    },
  },
  {
    name: "set_theme",
    description: `Change Halo's look. Themes: ${THEMES.map((t) => t.name).join(", ")}.`,
    params: { theme: { type: "string" } },
    required: ["theme"],
    run: async ({ theme }) => {
      const t = THEMES.find((x) => x.name.toLowerCase() === String(theme).toLowerCase()) ?? THEMES.find((x) => x.name.toLowerCase().includes(String(theme).toLowerCase()));
      if (!t) throw new Error("unknown theme");
      const prev = useSettings.getState().theme;
      useSettings.getState().set({ theme: t.id });
      return { text: "ok", summary: `Theme → ${t.name}`, undo: { kind: "theme", args: { id: prev }, label: "Previous theme" } };
    },
  },
  {
    name: "display",
    description: "List displays (resolution, refresh rates, scaling, HDR) or change them.",
    params: {
      action: { type: "string", enum: ["list", "set_mode", "set_scale", "set_hdr"] },
      width: { type: "integer" }, height: { type: "integer" }, hz: { type: "integer" },
      scale: { type: "integer", description: "percent, e.g. 125" }, on: { type: "boolean" },
    },
    required: ["action"],
    run: async ({ action, width, height, hz, scale, on }) => {
      const ds = await api.displays();
      const d = ds.find((x) => x.primary) ?? ds[0];
      if (action === "list") return JSON.stringify(ds.map((x) => ({ name: x.name, current: x.current, scale: x.scale, scales: x.scales, hdr: x.hdr_supported ? x.hdr_on : "unsupported", refresh_rates: [...new Set(x.modes.filter((m) => m.width === x.current.width && m.height === x.current.height).map((m) => m.hz))], resolutions: [...new Set(x.modes.map((m) => `${m.width}x${m.height}`))].slice(0, 12) })));
      if (action === "set_mode") {
        const c = d.current;
        await api.setDisplayMode(d.device, width ?? c.width, height ?? c.height, hz ?? c.hz);
        return { text: "ok", summary: `Display → ${width ?? c.width}×${height ?? c.height} @ ${hz ?? c.hz} Hz`, undo: { kind: "display_mode", args: { device: d.device, ...c }, label: "Previous mode" } };
      }
      if (action === "set_scale") {
        await api.setScale(d.device, scale);
        return { text: "ok", summary: `Scaling → ${scale}%`, undo: d.scale ? { kind: "scale", args: { device: d.device, scale: d.scale }, label: `Back to ${d.scale}%` } : undefined };
      }
      await api.setHdr(d.device, !!on);
      return { text: "ok", summary: `HDR ${on ? "on" : "off"}`, undo: { kind: "hdr", args: { device: d.device, on: !on }, label: "Undo" } };
    },
  },
  {
    name: "disk_cleanup",
    description: "Scan junk (temp files, caches, recycle bin, update leftovers) or clean chosen categories: temp, wintemp, recycle, browser, updates, delivery, thumbs, dumps, logs.",
    params: { action: { type: "string", enum: ["scan", "clean"] }, categories: { type: "array", items: { type: "string" } } },
    required: ["action"],
    run: async ({ action, categories }) => {
      if (action === "scan") return (await api.cleanupScan()).map((c) => `${c.id}: ${c.name} — ${(c.size / 1e6).toFixed(0)} MB`).join("\n");
      const freed = await api.cleanupRun(categories ?? ["temp", "wintemp"]);
      return { text: `freed ${(freed / 1e9).toFixed(2)} GB`, summary: `Cleaned ${(categories ?? ["temp"]).join(", ")} (${(freed / 1e9).toFixed(2)} GB)` };
    },
  },
  {
    name: "organize_downloads",
    description: "Sort loose files in Downloads into folders, or recycle installers older than 30 days.",
    params: { action: { type: "string", enum: ["sort", "clean_installers"] } },
    required: ["action"],
    run: async ({ action }) => {
      const n = action === "sort" ? await api.sortDownloads() : await api.cleanInstallers();
      return { text: `${n} files`, summary: action === "sort" ? `Sorted ${n} downloads` : `Recycled ${n} old installers` };
    },
  },
  {
    name: "services",
    description: "List Windows services (optionally filtered) or start/stop/restart one, or change its startup type.",
    params: { action: { type: "string", enum: ["list", "start", "stop", "restart", "auto", "demand", "disabled"] }, name: { type: "string", description: "service name or filter text" } },
    required: ["action"],
    run: async ({ action, name }) => {
      const all = await api.services();
      if (action === "list") {
        const f = String(name ?? "").toLowerCase();
        return all.filter((s) => !f || s.name.toLowerCase().includes(f) || s.display.toLowerCase().includes(f)).slice(0, 80).map((s) => `${s.name} — ${s.display} [${s.state}, ${s.start_mode}]`).join("\n");
      }
      const s = all.find((x) => x.name.toLowerCase() === String(name).toLowerCase() || x.display.toLowerCase() === String(name).toLowerCase());
      if (!s) throw new Error("no such service");
      await api.serviceAction(s.name, action);
      const undo: UndoStep | undefined =
        action === "start" ? { kind: "service", args: { name: s.name, action: "stop" }, label: "Stop it" } :
        action === "stop" ? { kind: "service", args: { name: s.name, action: "start" }, label: "Start it" } :
        ["auto", "demand", "disabled"].includes(action) ? { kind: "service", args: { name: s.name, action: s.start_mode.toLowerCase() === "manual" ? "demand" : s.start_mode.toLowerCase() }, label: `Back to ${s.start_mode}` } : undefined;
      return { text: "ok", summary: `Service ${s.display}: ${action}`, undo };
    },
  },
  {
    name: "startup_apps",
    description: "List apps that start with Windows, or enable/disable one.",
    params: { action: { type: "string", enum: ["list", "enable", "disable"] }, name: { type: "string" } },
    required: ["action"],
    run: async ({ action, name }) => {
      const items = await api.startup();
      if (action === "list") return items.map((i) => `${i.name} — ${i.enabled ? "on" : "off"} (${i.location})`).join("\n");
      const it = items.find((i) => i.name.toLowerCase().includes(String(name).toLowerCase()));
      if (!it) throw new Error("not found");
      await api.setStartup(it.id, action === "enable");
      return { text: "ok", summary: `Startup: ${it.name} ${action}d`, undo: { kind: "startup", args: { id: it.id, enabled: action !== "enable" }, label: "Undo" } };
    },
  },
  {
    name: "apps",
    description: "Search for, install, or update apps with winget. 'updates' lists available updates.",
    params: { action: { type: "string", enum: ["search", "install", "updates", "upgrade", "upgrade_all"] }, query: { type: "string", description: "search text or winget package id" } },
    required: ["action"],
    run: async ({ action, query }) => {
      if (action === "search") return (await api.wingetSearch(query)).slice(0, 15).map((a) => `${a.name} — ${a.id} ${a.version}`).join("\n") || "no results";
      if (action === "updates") return (await api.wingetUpdates()).map((a) => `${a.name} (${a.id}) ${a.version} → ${a.available}`).join("\n") || "everything is up to date";
      if (action === "install") return { text: await api.wingetInstall(query), summary: `Installed ${query}` };
      return { text: await api.wingetUpgrade(action === "upgrade_all" ? "--all" : query), summary: action === "upgrade_all" ? "Updated all apps" : `Updated ${query}` };
    },
  },
  {
    name: "add_todo",
    description: "Add an item to the user's Halo to-do list.",
    params: { text: { type: "string" } },
    required: ["text"],
    run: async ({ text }) => {
      const id = uid();
      const s = useSettings.getState();
      s.set({ todos: [{ id, text, done: false }, ...s.todos] });
      return { text: "added", summary: `To-do: ${text}`, undo: { kind: "todo_remove", args: { id }, label: "Remove" } };
    },
  },
  {
    name: "add_event",
    description: "Add an event to Halo's calendar.",
    params: { date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM or empty" }, title: { type: "string" } },
    required: ["date", "title"],
    run: async ({ date, time, title }) => {
      const id = uid();
      const s = useSettings.getState();
      s.set({ events: [...s.events, { id, date, time: time ?? "", title }] });
      return { text: "added", summary: `Event: ${title} on ${date}`, undo: { kind: "event_remove", args: { id }, label: "Remove" } };
    },
  },
  {
    name: "create_schedule",
    description: "Schedule something to run later or repeatedly. kind 'command' runs a Halo command (e.g. 'volume 20', 'mode saver', 'clean temp', 'launch spotify', 'ps: <powershell>'); kind 'ai' runs a prompt through you.",
    params: {
      name: { type: "string" },
      when: { type: "string", enum: ["daily", "once", "interval", "startup"] },
      time: { type: "string", description: "HH:MM for daily, YYYY-MM-DDTHH:MM for once" },
      days: { type: "array", items: { type: "integer" }, description: "0=Sun..6=Sat; empty = every day" },
      minutes: { type: "integer", description: "for interval" },
      kind: { type: "string", enum: ["command", "ai"] },
      action: { type: "string" },
    },
    required: ["name", "when", "kind", "action"],
    run: async (a) => {
      const id = uid();
      const s = useSettings.getState();
      s.set({ schedules: [...s.schedules, { id, name: a.name, enabled: true, when: a.when, time: a.time ?? "08:00", days: a.days ?? [], minutes: a.minutes ?? 60, kind: a.kind, action: a.action, lastRun: Date.now() }] });
      return { text: "scheduled", summary: `Scheduled “${a.name}”`, undo: { kind: "schedule_remove", args: { id }, label: "Remove" } };
    },
  },
  {
    name: "halo_command",
    description: "Run a Halo quick command (same as the command bar), e.g. 'fps overlay' to toggle the in-game FPS counter.",
    params: { command: { type: "string" } },
    required: ["command"],
    run: async ({ command }) => {
      const r = await runCommand(command);
      return { text: r, summary: r };
    },
  },
  {
    name: "notifications",
    description: "Read the user's recent Windows notifications.",
    params: { limit: { type: "integer" } },
    run: async ({ limit = 15 }) => (await api.notifications()).slice(0, limit).map((n) => `${new Date(n.time * 1000).toLocaleString()} · ${n.app}: ${n.title}${n.body ? ` — ${n.body}` : ""}`).join("\n") || "none",
  },
  {
    name: "show_page",
    description: "Switch Halo to one of its pages.",
    params: { page: { type: "string", enum: ["home", "ai", "system", "tasks", "files", "library", "network", "display", "automation", "updates", "settings"] } },
    required: ["page"],
    run: async ({ page }) => { useUi.getState().setUi({ page }); return "ok"; },
  },
];

// ---------------- undo ----------------
async function runUndo(u: UndoStep) {
  const a = u.args as any;
  switch (u.kind) {
    case "volume": await api.setVolume(a.v); await api.setMute(a.muted); break;
    case "mute": await api.setMute(a.muted); break;
    case "audio_device": await api.setAudioDevice(a.id); break;
    case "radio": await api.setRadio(a.radio, a.on); break;
    case "power_mode": await api.setPowerMode(a.mode); break;
    case "launch": await api.launchPath(a.path); break;
    case "restore_file": if (a.old == null) await api.trash([a.path]); else await api.writeText(a.path, a.old); break;
    case "move": await api.movePath(a.from, a.to); break;
    case "restore": { const n = await api.restore(a.paths); if (!n) throw new Error("Not in the Recycle Bin any more"); break; }
    case "forget": useAi.setState((s) => ({ memory: s.memory.filter((m) => m !== a.fact) })); break;
    case "remember_all": useAi.setState((s) => ({ memory: [...s.memory, ...a.facts] })); break;
    case "theme": useSettings.getState().set({ theme: a.id }); break;
    case "display_mode": await api.setDisplayMode(a.device, a.width, a.height, a.hz); break;
    case "scale": await api.setScale(a.device, a.scale); break;
    case "hdr": await api.setHdr(a.device, a.on); break;
    case "service": await api.serviceAction(a.name, a.action); break;
    case "startup": await api.setStartup(a.id, a.enabled); break;
    case "todo_remove": { const s = useSettings.getState(); s.set({ todos: s.todos.filter((t) => t.id !== a.id) }); break; }
    case "event_remove": { const s = useSettings.getState(); s.set({ events: s.events.filter((t) => t.id !== a.id) }); break; }
    case "schedule_remove": { const s = useSettings.getState(); s.set({ schedules: s.schedules.filter((t) => t.id !== a.id) }); break; }
    default: throw new Error("can't undo that");
  }
}

export async function undo(logId: string) {
  const e = useAi.getState().log.find((l) => l.id === logId);
  if (!e?.undo || e.undone) return;
  try {
    await runUndo(e.undo);
    useAi.setState((s) => ({ log: s.log.map((l) => (l.id === logId ? { ...l, undone: true } : l)) }));
    toast(`Undid: ${e.summary}`);
  } catch (err) {
    toast(`Couldn't undo: ${err instanceof Error ? err.message : err}`, "warn");
  }
}

async function execTool(name: string, args: any): Promise<{ call: ToolCall; image?: string }> {
  const t = TOOLS.find((x) => x.name === name);
  useAi.setState({ status: friendly(name) });
  if (!t) return { call: { name, args, result: `unknown tool ${name}`, ok: false } };
  try {
    const r = await t.run(args ?? {});
    const res: ToolResult = typeof r === "string" ? { text: r } : r;
    const logId = name === "power" || name.startsWith("get_") || name === "list_processes" || name === "list_folder" || name === "read_file" || name === "notifications" || name === "show_page" || (!res.summary && !res.undo)
      ? undefined
      : logAction(name, res.summary ?? name, true, res.undo);
    return { call: { name, args, result: res.text, ok: true, logId }, image: res.image };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { call: { name, args, result: `Error: ${msg}`, ok: false } };
  }
}

const friendly = (n: string) =>
  ({ take_screenshot: "Looking at your screen…", run_powershell: "Running PowerShell…", get_system_status: "Checking your PC…", list_processes: "Looking at processes…", disk_cleanup: "Cleaning up…", apps: "Talking to winget…", launch: "Opening…" } as Record<string, string>)[n] ?? "Working…";

// ---------------- prompt ----------------
let homeDir = "";
api.quickFolders().then((f) => { homeDir = f.find((x) => x.name === "Home")?.path ?? ""; }).catch(() => {});
function systemPrompt() {
  const mem = useAi.getState().memory;
  const now = new Date();
  return `You are Halo, the assistant built into the user's PC dashboard on their Windows 11 laptop (Intel i5-12500H, RTX 4060 laptop GPU, 1920x1080 at 150% scaling). You are running as administrator and have full control of the PC through your tools.

How to work:
- Just do what the user asks with your tools. Don't ask for confirmation, and don't explain how they could do it themselves when you can do it.
- Every action is logged in Halo with an Undo button, and deletes go to the Recycle Bin, so act confidently.
- Use run_powershell for anything the other tools don't cover. Check results and fix problems yourself.
- Keep replies short and friendly — usually one or two sentences, plain text, no markdown tables. Replies may be read aloud.
- Use take_screenshot when the question is about what's on screen.
- When the user tells you a lasting preference or fact about themselves, save it with remember.

Now: ${now.toLocaleString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}. User folder: ${homeDir || "C:\\Users\\<user>"}. Downloads is in that folder.
${mem.length ? `\nThings you remember about the user:\n${mem.map((m) => `- ${m}`).join("\n")}` : ""}`;
}

// ---------------- providers ----------------
type Turn = { role: "user" | "assistant"; text: string; image?: string };

function gemType(p: Param): any {
  const t = { string: "STRING", number: "NUMBER", integer: "INTEGER", boolean: "BOOLEAN", array: "ARRAY" }[p.type];
  const o: any = { type: t };
  if (p.description) o.description = p.description;
  if (p.enum) o.enum = p.enum;
  if (p.items) o.items = { type: ({ string: "STRING", integer: "INTEGER", number: "NUMBER" } as any)[p.items.type] ?? "STRING" };
  return o;
}

// ---- resilient Gemini calls: timeout, then fall back through other working models ----
let workingModel: { name: string; at: number } | null = null;
let modelCache: { key: string; list: string[]; at: number } | null = null;

/** Ping the top-ranked models in parallel with a tiny request; keep the ones that answer, best first. */
async function probeModels(key: string): Promise<string[]> {
  const ranked = rankModels(await listGeminiModels(key)).slice(0, 12);
  const ok = await Promise.all(ranked.map(async (m) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10_000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 8 } }),
      });
      return r.ok;
    } catch { return false; } finally { clearTimeout(t); }
  }));
  return ranked.filter((_, i) => ok[i]);
}

async function fallbackModels(key: string, first: string): Promise<string[]> {
  if (modelCache?.key !== key || Date.now() - modelCache.at > 3 * 3600_000 || !modelCache.list.length) {
    useAi.setState({ status: "Finding the fastest Gemini model…" } as any);
    try { modelCache = { key, list: await probeModels(key), at: Date.now() }; } catch { modelCache = null; }
  }
  const good = modelCache?.list ?? [];
  const recent = workingModel && Date.now() - workingModel.at < 30 * 60_000 ? [workingModel.name] : [];
  const pref = good.includes(first) ? [first] : [];
  const list = [...new Set([...recent, ...pref, ...good])];
  return (list.length ? list : [first]).slice(0, 4);
}

/** POST to Gemini, trying the next model when one is overloaded, out of quota, retired or hangs. */
async function gemCall(key: string, first: string, body: any, timeoutMs = 40_000): Promise<{ j: any; model: string }> {
  let lastErr = "Gemini didn't answer";
  for (const model of await fallbackModels(key, first)) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        workingModel = { name: model, at: Date.now() };
        const st = useSettings.getState();
        if (st.ai.geminiModel !== model) st.set({ ai: { ...st.ai, geminiModel: model } });
        return { j, model };
      }
      lastErr = j?.error?.message ?? `Gemini error ${r.status}`;
      // a bad request or bad key won't get better on another model
      if (![404, 429, 500, 503, 504].includes(r.status)) throw new Error(lastErr);
    } catch (e: any) {
      if (e?.name !== "AbortError" && !(e instanceof TypeError)) throw e;
      lastErr = e?.name === "AbortError" ? `${model} took too long to answer` : "Couldn't reach Gemini — check your internet";
    } finally {
      clearTimeout(t);
    }
    if (workingModel?.name === model) workingModel = null;
    if (modelCache) modelCache.list = modelCache.list.filter((x) => x !== model);
    useAi.setState({ status: `${model} is busy — trying another model…` } as any);
  }
  throw new Error(`${lastErr}. Try again in a minute.`);
}

function rankModels(ms: string[]) {
  const score = (n: string) => {
    const v = parseFloat(n.match(/gemini-(d+(?:.d+)?)/)?.[1] ?? "0");
    return v * 10 + (n.includes("flash") ? 3 : 0) - (n.includes("lite") ? 2 : 0) - (/preview|exp/.test(n) ? 1 : 0) - (/latest/.test(n) ? 30 : 0);
  };
  return ms.filter((n) => !/(robotics|transcribe|computer-use|nano|customtools|omni|banana)/.test(n)).sort((a, b) => score(b) - score(a));
}

async function gemini(history: Turn[], onCall: (c: ToolCall) => void): Promise<string> {
  const { geminiKey, geminiModel } = useSettings.getState().ai;
  if (!geminiKey) throw new Error("Add a Gemini API key in the assistant's setup first.");
  const model = geminiModel || (await pickGeminiModel(geminiKey));
  const decls = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    ...(Object.keys(t.params).length ? { parameters: { type: "OBJECT", properties: Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k, gemType(v)])), required: t.required ?? [] } } : {}),
  }));
  const contents: any[] = history.map((h) => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [...(h.image ? [{ inlineData: { mimeType: "image/png", data: h.image.split(",")[1] } }] : []), { text: h.text || "(image)" }],
  }));
  for (let i = 0; i < 20; i++) {
    const { j } = await gemCall(geminiKey, model, { systemInstruction: { parts: [{ text: systemPrompt() }] }, contents, tools: [{ functionDeclarations: decls }] });
    const cand = j.candidates?.[0];
    const parts: any[] = cand?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
    if (!calls.length) {
      if (!text && cand?.finishReason && cand.finishReason !== "STOP") throw new Error(`Gemini stopped: ${cand.finishReason}`);
      return text;
    }
    if (text) useAi.setState({ live: text });
    contents.push(cand.content);
    const responses: any[] = [];
    const images: string[] = [];
    for (const p of calls) {
      const { call, image } = await execTool(p.functionCall.name, p.functionCall.args);
      onCall(call);
      responses.push({ functionResponse: { name: call.name, response: { result: call.result } } });
      if (image) images.push(image);
    }
    contents.push({ role: "user", parts: [...responses, ...images.map((im) => ({ inlineData: { mimeType: "image/png", data: im.split(",")[1] } }))] });
  }
  return "I stopped after a lot of steps — tell me if you want me to keep going.";
}

async function claude(history: Turn[], onCall: (c: ToolCall) => void): Promise<string> {
  const { claudeKey, claudeModel } = useSettings.getState().ai;
  if (!claudeKey) throw new Error("Add a Claude API key in the assistant's setup first.");
  const client = new Anthropic({ apiKey: claudeKey, dangerouslyAllowBrowser: true });
  const tools: Anthropic.Tool[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { type: "object", properties: Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k, v as any])), required: t.required ?? [] },
  }));
  const messages: Anthropic.MessageParam[] = history.map((h) => ({
    role: h.role,
    content: h.image
      ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: h.image.split(",")[1] } }, { type: "text", text: h.text || "What's on my screen?" }]
      : h.text,
  }));
  let finalText = "";
  for (let i = 0; i < 20; i++) {
    const stream = client.messages.stream({
      model: claudeModel || "claude-opus-5-5",
      max_tokens: 16000,
      thinking: { type: "adaptive" } as any,
      system: systemPrompt(),
      tools,
      messages,
    });
    let turnText = "";
    stream.on("text", (d) => { turnText += d; useAi.setState({ live: finalText + turnText }); });
    const msg = await stream.finalMessage();
    const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    finalText += text;
    if (msg.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: msg.content }); continue; }
    if (msg.stop_reason !== "tool_use") return finalText;
    messages.push({ role: "assistant", content: msg.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of msg.content) {
      if (b.type !== "tool_use") continue;
      const { call, image } = await execTool(b.name, b.input);
      onCall(call);
      results.push({
        type: "tool_result",
        tool_use_id: b.id,
        is_error: !call.ok,
        content: image ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: image.split(",")[1] } }, { type: "text", text: call.result }] : call.result,
      });
    }
    messages.push({ role: "user", content: results });
    if (finalText) finalText += "\n\n";
  }
  return finalText || "I stopped after a lot of steps.";
}

export async function listGeminiModels(key: string): Promise<string[]> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message ?? "bad key");
  return (j.models ?? [])
    .filter((m: any) => m.supportedGenerationMethods?.includes("generateContent") && /gemini/.test(m.name) && !/(image|tts|embedding|aqa|live|audio)/.test(m.name))
    .map((m: any) => String(m.name).replace("models/", ""));
}

async function pickGeminiModel(key: string) {
  try {
    const best = rankModels(await listGeminiModels(key))[0];
    if (best) {
      const s = useSettings.getState();
      s.set({ ai: { ...s.ai, geminiModel: best } });
      return best;
    }
  } catch { /* fall through */ }
  return "gemini-2.5-flash";
}

// ---------------- running a turn ----------------
function historyFor(chat: Chat): Turn[] {
  return chat.messages.filter((m) => !m.error).slice(-24).map((m) => ({
    role: m.role,
    text: m.role === "assistant" && m.tools?.length ? `${m.text}\n[actions taken: ${m.tools.map((t) => `${t.name}${t.ok ? "" : " (failed)"}`).join(", ")}]` : m.text,
  }));
}

/** Send a prompt. Returns the reply text. `headless` runs without a visible chat (schedules). */
export async function ask(prompt: string, opts: { image?: string; chatId?: string; headless?: boolean } = {}): Promise<string> {
  const st = useAi.getState();
  if (st.busy) throw new Error("The assistant is still working on something.");
  let chatId = opts.chatId ?? st.currentId ?? undefined;
  if (opts.headless) {
    const c: Chat = { id: uid(), title: `⏱ ${prompt.slice(0, 40)}`, created: Date.now(), messages: [] };
    useAi.setState((s) => ({ chats: [c, ...s.chats] }));
    chatId = c.id;
  } else if (!chatId || !st.chats.some((c) => c.id === chatId)) chatId = newChat();
  const id = chatId!;
  const userMsg: ChatMsg = { id: uid(), role: "user", text: prompt, time: Date.now(), image: !!opts.image };
  updateChat(id, (c) => ({ ...c, title: c.messages.length ? c.title : prompt.slice(0, 48) || "Screenshot", messages: [...c.messages, userMsg] }));
  useAi.setState({ busy: true, live: "", liveTools: [], status: "Thinking…" });
  const calls: ToolCall[] = [];
  const onCall = (c: ToolCall) => { calls.push(c); useAi.setState({ liveTools: [...calls], status: "Thinking…" }); };
  try {
    const chat = useAi.getState().chats.find((c) => c.id === id)!;
    const hist = historyFor(chat);
    if (opts.image) hist[hist.length - 1].image = opts.image;
    const provider = useSettings.getState().ai.provider;
    const text = (provider === "claude" ? await claude(hist, onCall) : await gemini(hist, onCall)).trim() || (calls.length ? "Done." : "…");
    updateChat(id, (c) => ({ ...c, messages: [...c.messages, { id: uid(), role: "assistant", text, time: Date.now(), tools: calls }] }));
    if (!opts.headless && useSettings.getState().ai.speak && useUi.getState().visible) speak(text);
    return text;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    updateChat(id, (c) => ({ ...c, messages: [...c.messages, { id: uid(), role: "assistant", text: msg, time: Date.now(), tools: calls, error: true }] }));
    throw e;
  } finally {
    useAi.setState({ busy: false, live: "", liveTools: [], status: "" });
  }
}

// ---------------- voice ----------------
export function speak(text: string) {
  try {
    speechSynthesis.cancel();
    const clean = text.replace(/[*_`#>\[\]]/g, "").replace(/https?:\/\/\S+/g, "a link").slice(0, 600);
    const u = new SpeechSynthesisUtterance(clean);
    const want = useSettings.getState().ai.voice;
    const voices = speechSynthesis.getVoices();
    const v = voices.find((x) => x.name === want) ?? voices.find((x) => /natural/i.test(x.name) && x.lang.startsWith("en")) ?? voices.find((x) => x.lang.startsWith("en"));
    if (v) u.voice = v;
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch { /* no speech */ }
}
export const stopSpeaking = () => { try { speechSynthesis.cancel(); } catch { /* */ } };

/** Speech → text with Gemini (works whichever provider answers). */
export async function transcribe(blob: Blob): Promise<string> {
  const { geminiKey, geminiModel } = useSettings.getState().ai;
  if (!geminiKey) throw new Error("Voice input needs a Gemini API key (free) — add one in the assistant setup.");
  const b64 = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
  const model = geminiModel || (await pickGeminiModel(geminiKey));
  const { j } = await gemCall(geminiKey, model, { contents: [{ role: "user", parts: [{ inlineData: { mimeType: blob.type || "audio/webm", data: b64 } }, { text: "Transcribe this speech exactly. Reply with only the transcript, nothing else. If there's no speech, reply with an empty string." }] }] }, 30_000);
  return (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim();
}

/** Push-to-talk recorder. */
let rec: MediaRecorder | null = null;
let chunks: Blob[] = [];
export const useVoice = create<{ recording: boolean; level: number }>(() => ({ recording: false, level: 0 }));
export async function startRecording() {
  if (rec) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  stopSpeaking();
  chunks = [];
  rec = new MediaRecorder(stream, { mimeType: "audio/webm" });
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start(100);
  // level meter
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  const tick = () => {
    if (!rec) { ctx.close(); return; }
    an.getByteTimeDomainData(buf);
    let m = 0;
    for (const v of buf) m = Math.max(m, Math.abs(v - 128));
    useVoice.setState({ level: m / 128 });
    requestAnimationFrame(tick);
  };
  tick();
  useVoice.setState({ recording: true });
}
export async function stopRecording(): Promise<Blob | null> {
  const r = rec;
  if (!r) return null;
  rec = null;
  useVoice.setState({ recording: false, level: 0 });
  return new Promise((res) => {
    r.onstop = () => {
      r.stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: "audio/webm" });
      res(blob.size > 2000 ? blob : null);
    };
    r.stop();
  });
}

/** Hold-to-talk: stop recording, transcribe, ask. */
export async function finishVoice() {
  const blob = await stopRecording();
  if (!blob) return;
  useAi.setState({ status: "Listening…", busy: false });
  try {
    const text = await transcribe(blob);
    if (!text) return toast("Didn't catch that", "warn");
    await ask(text);
  } catch (e) {
    toast(`${e instanceof Error ? e.message : e}`, "warn");
  }
}
