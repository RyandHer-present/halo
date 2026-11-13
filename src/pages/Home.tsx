import { AnimatePresence, motion } from "framer-motion";
import { Check, LayoutDashboard, Plus, RotateCcw, X } from "lucide-react";
import ReactGridLayout, { useContainerWidth, verticalCompactor, type LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_LAYOUT, MODULE_NAMES, useSettings, useUi } from "../lib/store";
import { sfx, useMotion } from "../lib/util";
import { BatteryModule, CpuModule, DiskModule, GpuModule, NetModule, RamModule, UptimeModule } from "../modules/SystemModules";
import { MediaModule } from "../modules/Media";
import { QuickModule } from "../modules/Quick";
import { LauncherModule } from "../modules/Launcher";
import { ClockModule, TodoModule, WeatherModule } from "../modules/Info";
import { NotifsModule } from "../modules/Notifs";
import { AssistantModule } from "./Assistant";

const MODULES: Record<string, () => ReactNode> = {
  clock: () => <ClockModule />,
  weather: () => <WeatherModule />,
  cpu: () => <CpuModule />,
  gpu: () => <GpuModule />,
  ram: () => <RamModule />,
  media: () => <MediaModule />,
  quick: () => <QuickModule />,
  net: () => <NetModule />,
  battery: () => <BatteryModule />,
  launcher: () => <LauncherModule />,
  todo: () => <TodoModule />,
  disk: () => <DiskModule />,
  uptime: () => <UptimeModule />,
  notifs: () => <NotifsModule />,
  ai: () => <AssistantModule />,
};
const SIZES: Record<string, [number, number]> = { uptime: [3, 4], notifs: [4, 7], ai: [5, 7] };

export function HomePage() {
  const layout = useSettings((s) => s.layout);
  const set = useSettings((s) => s.set);
  const editing = useUi((s) => s.editing);
  const setUi = useUi((s) => s.setUi);
  const { width, containerRef, mounted } = useContainerWidth();
  const { stagger, on, lots } = useMotion();
  const [adding, setAdding] = useState(false);

  const missing = Object.keys(MODULES).filter((k) => !layout.some((l) => l.i === k));
  // 14 rows exactly fill the screen below the top bar; scales up on bigger displays.
  const [vh, setVh] = useState(window.innerHeight);
  useEffect(() => {
    const r = () => setVh(window.innerHeight);
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, []);
  const rowH = Math.max(24, Math.min(64, (vh - 112 - 13 * 16) / 14));
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("topbar-slot")), []);

  const bar = (
      <div className="home-bar">
        <AnimatePresence>
          {editing && (
            <motion.div className="edit-tools" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}>
              <button className="pill" onClick={() => { sfx("click"); setAdding(!adding); }}><Plus size={14} /> Add widget</button>
              <button className="pill" onClick={() => { sfx("click"); set({ layout: DEFAULT_LAYOUT }); }}><RotateCcw size={14} /> Reset</button>
            </motion.div>
          )}
        </AnimatePresence>
        <button className={`pill ${editing ? "accent-pill" : ""}`} onClick={() => { sfx("toggle"); setUi({ editing: !editing }); setAdding(false); }}>
          {editing ? <><Check size={14} /> Done</> : <><LayoutDashboard size={14} /> Edit layout</>}
        </button>
      </div>
  );

  return (
    <div className="home" ref={containerRef}>
      {slot && createPortal(bar, slot)}
      <AnimatePresence>
        {editing && adding && (
          <motion.div className="add-menu" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
            {missing.length === 0 ? <span className="faint small">Every widget is already on your home screen</span> : missing.map((k) => (
              <button key={k} className="pill" onClick={() => {
                sfx("toggle");
                const [w, h] = SIZES[k] ?? [3, 4];
                set({ layout: [...layout, { i: k, x: 0, y: 999, w, h, minW: 2, minH: 2 }] });
              }}><Plus size={13} /> {MODULE_NAMES[k]}</button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      {mounted && (
        <ReactGridLayout
          className={`grid ${editing ? "editing" : ""}`}
          width={width}
          layout={layout}
          gridConfig={{ cols: 12, rowHeight: rowH, margin: [16, 16], containerPadding: [0, 0] }}
          dragConfig={{ enabled: editing, handle: ".card", cancel: "button, input, textarea, .slider, .progress, .no-drag" }}
          resizeConfig={{ enabled: editing, handles: ["se"] }}
          compactor={verticalCompactor}
          onLayoutChange={(l) => set({ layout: l.map((x) => ({ ...x })) as LayoutItem[] })}
        >
          {layout.map((item, idx) => (
            <div key={item.i} className="grid-item">
              <motion.div className="grid-inner"
                initial={on ? { opacity: 0, y: lots ? 30 : 10, scale: lots ? 0.94 : 1, filter: lots ? "blur(8px)" : "none" } : false}
                animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                transition={{ type: "spring", stiffness: 220, damping: 24, delay: idx * stagger }}>
                {MODULES[item.i]?.() ?? null}
                {editing && (
                  <button className="remove-widget" onClick={() => { sfx("close"); set({ layout: layout.filter((l) => l.i !== item.i) }); }}>
                    <X size={13} />
                  </button>
                )}
              </motion.div>
            </div>
          ))}
        </ReactGridLayout>
      )}
    </div>
  );
}
