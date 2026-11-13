// The two small extra windows: corner alert toasts and the in-game FPS counter.
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, FpsInfo, HaloToast, Stats } from "./lib/api";
import { useSettings } from "./lib/store";
import { themeById } from "./lib/themes";
import { hexToRgb } from "./lib/util";

function useAccentVar() {
  const s = useSettings();
  useEffect(() => {
    const a = s.accentSource === "custom" ? s.customAccent : themeById(s.theme).accent;
    document.documentElement.style.setProperty("--accent", a);
    document.documentElement.style.setProperty("--accent-rgb", hexToRgb(a).join(","));
  }, [s.theme, s.accentSource, s.customAccent]);
}

export function ToastWindow() {
  const [items, setItems] = useState<HaloToast[]>([]);
  const timers = useRef(new Map<number, number>());
  useAccentVar();
  const add = (t: HaloToast[]) => {
    setItems((xs) => [...xs, ...t].slice(-4));
    t.forEach((x) => timers.current.set(x.id, window.setTimeout(() => remove(x.id), 7000)));
  };
  const itemsRef = useRef(0);
  itemsRef.current = items.length;
  const remove = (id: number) => setItems((xs) => xs.filter((x) => x.id !== id));
  useEffect(() => {
    api.toastPending().then(add);
    const un = listen<HaloToast>("halo://toast", (e) => add([e.payload]));
    // never linger as an invisible window if nothing arrives
    const idle = window.setInterval(() => { if (!itemsRef.current) api.toastDone(); }, 9000);
    return () => { un.then((f) => f()); clearInterval(idle); };
  }, []);
  // close the window once everything has animated away
  const seen = useRef(false);
  useEffect(() => {
    if (items.length) seen.current = true;
    else if (seen.current) {
      const id = setTimeout(() => api.toastDone(), 600);
      return () => clearTimeout(id);
    }
  }, [items.length]);
  return (
    <div className="toasts-win">
      <AnimatePresence>
        {items.map((t) => (
          <motion.div key={t.id} layout className={`htoast ${t.kind}`} initial={{ opacity: 0, x: 60, scale: 0.9 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 80, scale: 0.95 }}
            transition={{ type: "spring", stiffness: 300, damping: 26 }} onClick={() => remove(t.id)}>
            <div className="htoast-icon">{t.kind === "warn" ? <AlertTriangle size={18} /> : t.kind === "ok" ? <CheckCircle2 size={18} /> : <Info size={18} />}</div>
            <div className="htoast-text"><b>{t.title}</b><span>{t.body}</span></div>
            <X size={14} className="htoast-x" />
            <motion.i className="htoast-timer" initial={{ scaleX: 1 }} animate={{ scaleX: 0 }} transition={{ duration: 7, ease: "linear" }} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function FpsWindow() {
  const [f, setF] = useState<FpsInfo | null>(null);
  const [s, setS] = useState<Stats | null>(null);
  const fahrenheit = useSettings((x) => x.fahrenheit);
  useAccentVar();
  useEffect(() => {
    const un = listen<FpsInfo>("halo://fps", (e) => setF(e.payload));
    let alive = true;
    const tick = () => api.stats().then((x) => { if (alive) setS(x); }).finally(() => { if (alive) setTimeout(tick, 1000); });
    tick();
    return () => { alive = false; un.then((x) => x()); };
  }, []);
  const T = (c: number | null | undefined) => (c == null ? "—" : fahrenheit ? `${Math.round(c * 9 / 5 + 32)}°` : `${Math.round(c)}°`);
  const hist = f?.history ?? [];
  const mx = Math.max(60, ...hist);
  const path = hist.map((v, i) => `${i === 0 ? "M" : "L"} ${(i / 59) * 100} ${30 - (v / mx) * 28}`).join(" ");
  const col = (v: number) => (v >= 55 ? "var(--accent)" : v >= 30 ? "#ffb547" : "#ff5d5d");
  return (
    <div className="fps-win">
      <div className="fps-top">
        <span className="fps-num" style={{ color: f?.fps ? col(f.fps) : undefined }}>{f?.fps ? Math.round(f.fps) : "—"}</span>
        <span className="fps-unit">FPS</span>
        <span className="fps-ft">{f?.frametime ? `${f.frametime.toFixed(1)} ms` : ""}{f?.low1 ? ` · 1% ${Math.round(f.low1)}` : ""}</span>
      </div>
      {hist.length > 1 ? <svg className="fps-graph" viewBox="0 0 100 30" preserveAspectRatio="none"><path d={path} /></svg> : <div className="fps-wait">Waiting for a game…</div>}
      <div className="fps-rows">
        <span>CPU</span><b>{s ? `${Math.round(s.cpu)}%` : "—"}</b><b>{T(s?.cpu_temp)}</b>
        <span>GPU</span><b>{s?.gpu ? `${Math.round(s.gpu.load)}%` : "—"}</b><b>{T(s?.gpu?.temp)}</b>
        <span>RAM</span><b>{s ? `${(s.ram_used / 1024 ** 3).toFixed(1)}G` : "—"}</b><b>{s?.gpu ? `${(s.gpu.vram_used / 1024 ** 3).toFixed(1)}G VRAM` : ""}</b>
      </div>
      {f?.app && <div className="fps-app">{f.app}</div>}
    </div>
  );
}
