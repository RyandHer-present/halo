// Spotlight-style search + command bar. No AI: understands simple commands like
// "volume 30", "mute", "wifi off", "sleep", "theme synthwave", plus apps, games, pages and the web.
import { AnimatePresence, motion } from "framer-motion";
import { Activity, ArrowUpCircle, Bluetooth, CornerDownLeft, FolderOpen, Gamepad2, Globe, ListTree, Lock, Monitor, Moon, Palette, Search, Settings, Sparkles, Trash2, Volume2, VolumeX, Wand2, Wifi, Workflow, Zap, LayoutGrid, Cpu, Home, Network } from "lucide-react";
import { useAi } from "../lib/ai";
import { runCommandToast } from "../lib/actions";
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { toast, useSettings, useUi } from "../lib/store";
import { THEMES } from "../lib/themes";
import { sfx } from "../lib/util";
import { launchApp, launchGame, useLibrary } from "../modules/Launcher";
import { AppIcon } from "./ui";

interface Item {
  id: string;
  group: string;
  title: string;
  sub?: string;
  icon: ReactNode;
  run: () => void;
  score: number;
}

const PAGES = [
  { id: "home", name: "Home", icon: <Home size={16} /> },
  { id: "ai", name: "Assistant", icon: <Sparkles size={16} /> },
  { id: "system", name: "System", icon: <Cpu size={16} /> },
  { id: "tasks", name: "Tasks — processes, services, startup, uninstall", icon: <ListTree size={16} /> },
  { id: "files", name: "Files — disk space, cleanup, downloads", icon: <FolderOpen size={16} /> },
  { id: "library", name: "Library", icon: <Gamepad2 size={16} /> },
  { id: "network", name: "Network & audio — Wi-Fi, speed test, devices", icon: <Network size={16} /> },
  { id: "display", name: "Display & input — resolution, mouse, keyboard", icon: <Monitor size={16} /> },
  { id: "automation", name: "Automation — schedules, alerts", icon: <Workflow size={16} /> },
  { id: "updates", name: "Updates — apps, drivers", icon: <ArrowUpCircle size={16} /> },
  { id: "settings", name: "Settings", icon: <Settings size={16} /> },
];

function score(text: string, q: string) {
  const t = text.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.split(/[\s\-_:]+/).some((w) => w.startsWith(q))) return 60;
  if (t.includes(q)) return 40;
  // initials, e.g. "vsc" -> Visual Studio Code
  const initials = t.split(/[\s\-_]+/).map((w) => w[0]).join("");
  if (initials.startsWith(q)) return 50;
  return 0;
}

function commands(q: string): Item[] {
  const out: Item[] = [];
  const m = q.match(/^(?:vol|volume|v)\s*(\d{1,3})%?$/);
  if (m) {
    const v = Math.min(100, +m[1]);
    out.push({ id: "vol", group: "Command", title: `Set volume to ${v}%`, icon: <Volume2 size={16} />, score: 200, run: () => { api.setVolume(v / 100); api.setMute(false); toast(`Volume ${v}%`); } });
  }
  const radio = q.match(/^(wifi|wi-fi|bluetooth|bt)\s+(on|off)$/);
  if (radio) {
    const kind = radio[1].startsWith("b") ? "bluetooth" : "wifi";
    const on = radio[2] === "on";
    out.push({ id: "radio", group: "Command", title: `Turn ${kind === "wifi" ? "Wi-Fi" : "Bluetooth"} ${radio[2]}`, icon: kind === "wifi" ? <Wifi size={16} /> : <Bluetooth size={16} />, score: 200, run: () => api.setRadio(kind, on).then(() => toast(`${kind === "wifi" ? "Wi-Fi" : "Bluetooth"} ${radio[2]}`)) });
  }
  const theme = q.match(/^theme\s+(.+)$/);
  if (theme) {
    THEMES.filter((t) => t.name.toLowerCase().includes(theme[1])).forEach((t) =>
      out.push({ id: "theme" + t.id, group: "Command", title: `Theme: ${t.name}`, icon: <Palette size={16} />, score: 190, run: () => useSettings.getState().set({ theme: t.id }) }));
  }
  const fixed: [string, string, ReactNode, () => void][] = [
    ["mute", "Mute sound", <VolumeX size={16} />, () => api.setMute(true)],
    ["unmute", "Unmute sound", <Volume2 size={16} />, () => api.setMute(false)],
    ["lock", "Lock PC", <Lock size={16} />, () => api.power("lock")],
    ["sleep", "Sleep", <Moon size={16} />, () => { api.hide(); setTimeout(() => api.power("sleep"), 400); }],
    ["turbo performance mode", "Power mode: Turbo", <Zap size={16} />, () => api.setPowerMode("performance").then(() => toast("Turbo mode"))],
    ["balanced power mode", "Power mode: Balanced", <Zap size={16} />, () => api.setPowerMode("balanced").then(() => toast("Balanced mode"))],
    ["saver battery efficiency mode", "Power mode: Saver", <Zap size={16} />, () => api.setPowerMode("efficiency").then(() => toast("Battery saver mode"))],
    ["play pause music", "Play / pause media", <Volume2 size={16} />, () => api.media("toggle")],
    ["next song skip track", "Next track", <Volume2 size={16} />, () => api.media("next")],
    ["edit layout widgets", "Edit home layout", <LayoutGrid size={16} />, () => useUi.getState().setUi({ page: "home", editing: true })],
    ["clean up junk temp files", "Clean temp files", <Wand2 size={16} />, () => runCommandToast("clean temp")],
    ["empty recycle bin trash", "Empty the Recycle Bin", <Trash2 size={16} />, () => runCommandToast("empty recycle bin")],
    ["sort downloads organize", "Sort Downloads", <FolderOpen size={16} />, () => runCommandToast("sort downloads")],
    ["fps overlay counter", "Toggle FPS overlay", <Activity size={16} />, () => runCommandToast("fps overlay")],
    ["speed test internet", "Run a speed test", <Network size={16} />, () => useUi.getState().setUi({ page: "network" })],
    ["task manager processes", "Task manager", <ListTree size={16} />, () => useUi.getState().setUi({ page: "tasks" })],
  ];
  for (const [keys, title, icon, run] of fixed) {
    const s = Math.max(score(keys, q), score(title, q));
    if (s) out.push({ id: keys, group: "Command", title, icon, run, score: s + 5 });
  }
  return out;
}

export function CommandBar() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const { games, apps } = useLibrary();
  const visible = useUi((s) => s.visible);
  const setUi = useUi((s) => s.setUi);

  // Start typing anywhere to search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        input.current?.focus();
      }
      if ((e.ctrlKey && e.key === "k") || e.key === "/") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { if (!visible) { setQ(""); setOpen(false); } }, [visible]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const items: Item[] = [...commands(query)];
    PAGES.forEach((p) => { const s = score(p.name, query); if (s) items.push({ id: "p" + p.id, group: "Go to", title: p.name, icon: p.icon, score: s, run: () => setUi({ page: p.id }) }); });
    (games ?? []).forEach((g) => { const s = score(g.name, query); if (s) items.push({ id: "g" + g.source + g.id, group: "Games", title: g.name, sub: g.subtitle, icon: <Gamepad2 size={16} />, score: s + 3, run: () => launchGame(g) }); });
    (apps ?? []).forEach((a) => { const s = score(a.name, query); if (s) items.push({ id: "a" + a.path, group: "Apps", title: a.name, icon: <AppIcon path={a.path} size={20} fallback={a.name} />, score: s + 2, run: () => launchApp(a) }); });
    THEMES.forEach((t) => { if (!query.startsWith("theme") && score(t.name, query) >= 60) items.push({ id: "t" + t.id, group: "Themes", title: `Theme: ${t.name}`, icon: <Palette size={16} />, score: 20, run: () => useSettings.getState().set({ theme: t.id }) }); });
    items.sort((a, b) => b.score - a.score);
    const top = items.slice(0, 8);
    top.push({ id: "ai", group: "Assistant", title: `Ask: “${q.trim()}”`, icon: <Sparkles size={16} />, score: 0, run: () => { setUi({ page: "ai" }); useAi.setState({ pending: q.trim() }); } });
    top.push({ id: "web", group: "Web", title: `Search the web for “${q.trim()}”`, icon: <Globe size={16} />, score: 0, run: () => { api.launchPath(`https://www.google.com/search?q=${encodeURIComponent(q.trim())}`); api.hide(); } });
    return top;
  }, [q, games, apps, setUi]);

  useEffect(() => setSel(0), [q]);

  const run = (it: Item) => {
    sfx("click");
    it.run();
    setQ("");
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div className="cmd">
      <div className={`cmd-field ${open && q ? "open" : ""}`}>
        <Search size={17} />
        <input ref={input} value={q} placeholder="Search apps, games, settings — or try “volume 40”"
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            if (e.key === "Enter" && results[sel]) run(results[sel]);
            if (e.key === "Escape") { e.stopPropagation(); setQ(""); input.current?.blur(); }
          }} />
        <span className="kbd small">Ctrl K</span>
      </div>
      <AnimatePresence>
        {open && results.length > 0 && (
          <motion.div className="cmd-results" initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }} transition={{ type: "spring", stiffness: 500, damping: 34 }}>
            {results.map((r, i) => (
              <div key={r.id}>
                {(i === 0 || results[i - 1].group !== r.group) && <div className="cmd-group">{r.group}</div>}
                <button className={`cmd-item ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); run(r); }}>
                  {i === sel && <motion.span layoutId="cmdsel" className="cmd-sel" transition={{ type: "spring", stiffness: 600, damping: 40 }} />}
                  <span className="cmd-icon">{r.icon}</span>
                  <span className="cmd-title">{r.title}</span>
                  {r.sub && <span className="cmd-sub">{r.sub}</span>}
                  {i === sel && <CornerDownLeft size={14} className="faint" />}
                </button>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
