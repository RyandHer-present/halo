import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpCircle, Cpu, FolderOpen, Gamepad2, Home, ListTree, Monitor, Network, Settings, Sparkles, Workflow, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./lib/api";
import { useLive, useLivePollers } from "./lib/live";
import { useSettings, useUi } from "./lib/store";
import { FONTS, themeById } from "./lib/themes";
import { dominantColor, hexToRgb, rgbToHex, sfx, useMotion } from "./lib/util";
import { CommandBar } from "./components/CommandBar";
import { HomePage } from "./pages/Home";
import { LibraryPage, NetworkPage, SystemPage } from "./pages/Pages";
import { SettingsPage } from "./pages/Settings";
import { AiPage } from "./pages/Assistant";
import { TasksPage } from "./pages/Tasks";
import { FilesPage } from "./pages/Files";
import { DisplayPage } from "./pages/Display";
import { AutomationPage } from "./pages/Automation";
import { UpdatesPage } from "./pages/Updates";
import { useScheduleRunner } from "./lib/schedules";
import { finishVoice, startRecording } from "./lib/ai";

const NAV = [
  { id: "home", label: "Home", icon: Home },
  { id: "ai", label: "Assistant", icon: Sparkles },
  { id: "system", label: "System", icon: Cpu },
  { id: "tasks", label: "Tasks", icon: ListTree },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "library", label: "Library", icon: Gamepad2 },
  { id: "network", label: "Network & audio", icon: Network },
  { id: "display", label: "Display & input", icon: Monitor },
  { id: "automation", label: "Automation", icon: Workflow },
  { id: "updates", label: "Updates", icon: ArrowUpCircle },
  { id: "settings", label: "Settings", icon: Settings },
];

const PAGES: Record<string, () => React.ReactElement> = {
  home: HomePage, ai: AiPage, system: SystemPage, tasks: TasksPage, files: FilesPage, library: LibraryPage,
  network: NetworkPage, display: DisplayPage, automation: AutomationPage, updates: UpdatesPage, settings: SettingsPage,
};

// rotate hue for secondary accents
function shiftHue(hex: string, deg: number) {
  let [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  h = (h + deg / 360 + 1) % 1;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) return hex;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  [r, g, b] = [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
  return rgbToHex(r * 255, g * 255, b * 255);
}

/** Works out the accent color from the chosen source. */
function useAccent() {
  const { accentSource, customAccent, theme } = useSettings();
  const art = useLive((l) => l.media?.art);
  const visible = useUi((s) => s.visible);
  const [accent, setAccent] = useState(themeById(theme).accent);
  useEffect(() => {
    let alive = true;
    const fallback = themeById(theme).accent;
    const done = (c: string | null | undefined) => { if (alive) setAccent(c || fallback); };
    if (accentSource === "theme") done(fallback);
    else if (accentSource === "custom") done(customAccent);
    else if (accentSource === "windows") api.windowsAccent().then(done);
    else if (accentSource === "wallpaper") api.wallpaper().then((w) => (w ? dominantColor(w).then(done) : done(null)));
    else if (accentSource === "album") { if (art) dominantColor(art).then(done); else done(null); }
    return () => { alive = false; };
  }, [accentSource, customAccent, theme, art, visible]);
  return accent;
}

function Decor({ kind }: { kind: string }) {
  if (kind === "aurora")
    return (
      <div className="decor aurora">
        <i className="blob b1" /><i className="blob b2" /><i className="blob b3" />
      </div>
    );
  if (kind === "synth")
    return (
      <div className="decor synth">
        <div className="synth-sun" />
        <div className="synth-grid" />
      </div>
    );
  if (kind === "hud") return <div className="decor hud-lines" />;
  if (kind === "grain") return <div className="decor grain" />;
  return null;
}

function Toast() {
  const t = useUi((s) => s.toast);
  const setUi = useUi((s) => s.setUi);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => setUi({ toast: null }), 2600);
    return () => clearTimeout(id);
  }, [t, setUi]);
  return (
    <div className="toast-wrap">
      <AnimatePresence>
        {t && (
          <motion.div key={t.id} className={`toast ${t.kind}`} initial={{ opacity: 0, y: 20, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.97 }}>
            {t.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  const settings = useSettings();
  const { page, setUi } = useUi();
  const theme = themeById(settings.theme);
  const accent = useAccent();
  const { on, lots, spring } = useMotion();
  const [shown, setShown] = useState(true); // drives the in/out animation
  const [openCount, setOpenCount] = useState(0); // remount content on each open so it animates in
  const hiding = useRef(false);
  useLivePollers();
  useScheduleRunner();

  // Keep the Rust side in sync with settings it acts on while Halo is hidden.
  const alerts = settings.alerts;
  const organizer = settings.organizer;
  useEffect(() => { const t = setTimeout(() => api.setAlerts(alerts), 1500); return () => clearTimeout(t); }, [alerts]);
  useEffect(() => { const t = setTimeout(() => api.setOrganizer(organizer), 1500); return () => clearTimeout(t); }, [organizer]);

  const hide = () => {
    if (hiding.current) return;
    hiding.current = true;
    sfx("close");
    setShown(false);
    setTimeout(() => {
      useUi.getState().setUi({ visible: false, editing: false });
      api.hide();
    }, on ? 260 : 0);
  };
  const hideRef = useRef(hide);
  hideRef.current = hide;

  // Show / hide coordination with the Rust side.
  useEffect(() => {
    const a = listen("halo://show", () => {
      const wasHidden = !useUi.getState().visible || hiding.current;
      hiding.current = false;
      useUi.getState().setUi({ visible: true });
      setShown(true);
      if (wasHidden) {
        setOpenCount((n) => n + 1);
        sfx("open");
      }
    });
    const b = listen("halo://hide", () => hideRef.current());
    const c = listen<string>("halo://page", (e) => useUi.getState().setUi({ page: e.payload }));
    // push-to-talk (Ctrl+Shift+Space held)
    const d = listen<boolean>("halo://ptt", (e) => {
      if (e.payload) startRecording().catch(() => {});
      else finishVoice();
    });
    const blur = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused && !useUi.getState().editing) setTimeout(() => { if (!document.hasFocus()) hideRef.current(); }, 150);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (useUi.getState().editing) useUi.getState().setUi({ editing: false });
        else hideRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      [a, b, c, d, blur].forEach((p) => p.then((f) => f()));
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Apply theme + accent + font as CSS variables.
  useEffect(() => {
    const root = document.documentElement;
    Object.entries(theme.vars).forEach(([k, v]) => root.style.setProperty(k, v));
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-2", shiftHue(accent, 45));
    root.style.setProperty("--accent-3", shiftHue(accent, -50));
    root.style.setProperty("--accent-rgb", hexToRgb(accent).join(","));
    root.style.setProperty("--dim", String(settings.dim));
    root.style.setProperty("--font", (FONTS.find((f) => f.id === settings.font) ?? FONTS[0]).stack);
    root.dataset.theme = theme.id;
    root.dataset.decor = theme.decor;
    root.dataset.motion = settings.motion;
    root.dataset.bento = theme.vars["--bento"] ? "1" : "0";
  }, [theme, accent, settings.dim, settings.font, settings.motion]);

  const greeting = (() => {
    const h = new Date().getHours();
    return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 22 ? "Good evening" : "Good night";
  })();

  const Page = PAGES[page] ?? HomePage;

  return (
    <div className="root" onMouseDown={(e) => { if (e.target === e.currentTarget) hide(); }}>
      <motion.div className="tint" initial={{ opacity: 0 }} animate={{ opacity: shown ? 1 : 0 }} transition={{ duration: on ? 0.3 : 0 }} />
      <Decor kind={theme.decor} />
      <motion.div className="shell" key={openCount}
        onMouseDown={(e) => { if (e.target === e.currentTarget) hide(); }}
        initial={on ? { opacity: 0, scale: lots ? 1.04 : 1.01, filter: lots ? "blur(10px)" : "blur(0px)" } : false}
        animate={shown ? { opacity: 1, scale: 1, filter: "blur(0px)" } : { opacity: 0, scale: lots ? 0.97 : 0.99, filter: lots ? "blur(8px)" : "blur(0px)" }}
        transition={shown ? spring : { duration: on ? 0.22 : 0, ease: "easeIn" }}>
        <nav className="sidebar">
          <div className="logo" title="Halo">
            <svg viewBox="0 0 40 40" width="30" height="30">
              <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="var(--accent)" /><stop offset="1" stopColor="var(--accent-2)" /></linearGradient></defs>
              <circle cx="20" cy="20" r="14" fill="none" stroke="url(#lg)" strokeWidth="4.5" />
              <circle cx="20" cy="20" r="5" fill="url(#lg)" opacity=".85" />
            </svg>
          </div>
          {NAV.map((n) => (
            <button key={n.id} className={`nav ${page === n.id ? "on" : ""}`} title={n.label}
              onMouseEnter={() => sfx("hover")} onClick={() => { sfx("click"); setUi({ page: n.id, editing: false }); }}>
              {page === n.id && <motion.span layoutId="navpill" className="nav-pill" transition={{ type: "spring", stiffness: 500, damping: 36 }} />}
              <n.icon size={20} />
              <span className="nav-label">{n.label}</span>
            </button>
          ))}
          <div className="grow" />
          <button className="nav" title="Close (Esc)" onClick={hide}><X size={20} /><span className="nav-label">Close</span></button>
        </nav>
        <main className="main">
          <header className="topbar">
            <div className="greet">
              <div className="greet-hi">{greeting}</div>
              <div className="faint small">Win + Shift + D to toggle · Esc to close</div>
            </div>
            <CommandBar />
            <div className="grow" />
            <div id="topbar-slot" className="topbar-slot" />
          </header>
          <div className="content">
            <AnimatePresence mode="wait">
              <motion.div key={page} className="page-wrap"
                initial={on ? { opacity: 0, y: lots ? 18 : 6 } : false} animate={{ opacity: 1, y: 0 }} exit={on ? { opacity: 0, y: lots ? -10 : 0 } : undefined}
                transition={{ duration: on ? 0.25 : 0 }}>
                <Page />
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </motion.div>
      <Toast />
    </div>
  );
}
