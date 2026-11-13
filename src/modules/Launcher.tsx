import { AnimatePresence, motion } from "framer-motion";
import { Gamepad2, LayoutGrid, Pickaxe, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppIcon, Card, Empty, IconBtn, Segmented } from "../components/ui";
import { api, Game, StartApp } from "../lib/api";
import { toast, useSettings } from "../lib/store";
import { sfx, useMotion } from "../lib/util";
import { create } from "zustand";

// ---------- shared caches ----------
interface LibStore {
  games: Game[] | null;
  apps: StartApp[] | null;
  art: Record<string, string | null>;
  load: () => void;
}
export const useLibrary = create<LibStore>((set, get) => ({
  games: null,
  apps: null,
  art: {},
  load: () => {
    if (get().games) return;
    api.games().then((games) => {
      set({ games });
      games.forEach((g) => {
        if (g.art) api.readImage(g.art).then((src) => set((s) => ({ art: { ...s.art, [g.source + g.id]: src } })));
      });
    });
    api.startApps().then((apps) => set({ apps }));
  },
}));

export const launchGame = async (g: Game) => {
  sfx("launch");
  try {
    await api.launchGame(g.source, g.id);
    toast(`Launching ${g.name}`);
    setTimeout(() => api.hide(), 350);
  } catch (e) {
    toast(`${e}`, "warn");
  }
};
export const launchApp = async (a: StartApp) => {
  sfx("launch");
  try {
    await api.launchPath(a.path);
    setTimeout(() => api.hide(), 350);
  } catch (e) {
    toast(`${e}`, "warn");
  }
};

export function GameTile({ g, big }: { g: Game; big?: boolean }) {
  const art = useLibrary((s) => s.art[g.source + g.id]);
  const { lots } = useMotion();
  const prism = g.source === "prism";
  return (
    <motion.button className={`game ${prism ? "prism" : ""} ${big ? "big" : ""}`} title={`${g.name}\n${g.subtitle}`}
      whileHover={lots ? { y: -6, scale: 1.04, rotateX: 4 } : { scale: 1.02 }} whileTap={{ scale: 0.96 }}
      onMouseEnter={() => sfx("hover")} onClick={() => launchGame(g)}>
      {prism ? (
        <div className="game-prism">
          <div className="game-prism-bg" style={art ? { backgroundImage: `url(${art})` } : undefined} />
          {art ? <img src={art} className="game-prism-icon" draggable={false} /> : <Pickaxe size={34} />}
        </div>
      ) : art ? (
        <img src={art} className="game-art" draggable={false} />
      ) : (
        <div className="game-noart"><Gamepad2 size={28} /></div>
      )}
      <div className="game-meta">
        <div className="game-name">{g.name}</div>
        <div className="game-sub">{g.subtitle}</div>
      </div>
      <span className="game-shine" />
    </motion.button>
  );
}

export function AppPicker({ onClose }: { onClose: () => void }) {
  const apps = useLibrary((s) => s.apps);
  const pinned = useSettings((s) => s.pinnedApps);
  const set = useSettings((s) => s.set);
  const [q, setQ] = useState("");
  const list = useMemo(() => (apps ?? []).filter((a) => a.name.toLowerCase().includes(q.toLowerCase())).slice(0, 80), [apps, q]);
  return (
    <motion.div className="modal-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className="modal" initial={{ y: 30, scale: 0.96 }} animate={{ y: 0, scale: 1 }} exit={{ y: 20, opacity: 0 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Pin apps</b>
          <IconBtn onClick={onClose}><X size={16} /></IconBtn>
        </div>
        <div className="search-field">
          <Search size={16} />
          <input autoFocus placeholder="Search installed apps…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="app-list">
          {list.map((a) => {
            const on = pinned.some((p) => p.path === a.path);
            return (
              <button key={a.path} className={`app-row ${on ? "on" : ""}`} onClick={() => {
                sfx("toggle");
                set({ pinnedApps: on ? pinned.filter((p) => p.path !== a.path) : [...pinned, a] });
              }}>
                <AppIcon path={a.path} size={28} fallback={a.name} />
                <span className="ellipsis">{a.name}</span>
                <span className="app-row-check">{on ? "Pinned" : "Pin"}</span>
              </button>
            );
          })}
        </div>
      </motion.div>
    </motion.div>
  );
}

export function PinnedApps({ size = 46 }: { size?: number }) {
  const pinned = useSettings((s) => s.pinnedApps);
  const [picking, setPicking] = useState(false);
  return (
    <>
      <div className="apps-grid">
        {pinned.map((a) => (
          <motion.button key={a.path} className="app" whileHover={{ y: -3 }} whileTap={{ scale: 0.92 }} onMouseEnter={() => sfx("hover")} onClick={() => launchApp(a)} title={a.name}>
            <AppIcon path={a.path} size={size} fallback={a.name} />
            <span className="app-name">{a.name}</span>
          </motion.button>
        ))}
        <motion.button className="app add" whileHover={{ y: -3 }} onClick={() => { sfx("click"); setPicking(true); }}>
          <div className="app-add-icon" style={{ width: size, height: size }}><Plus size={20} /></div>
          <span className="app-name">Add</span>
        </motion.button>
      </div>
      <AnimatePresence>{picking && <AppPicker onClose={() => setPicking(false)} />}</AnimatePresence>
    </>
  );
}

export function LauncherModule() {
  const { games, load } = useLibrary();
  const hidden = useSettings((s) => s.hiddenGames);
  const [tab, setTab] = useState<"games" | "apps">("games");
  useEffect(load, [load]);
  const shown = (games ?? []).filter((g) => !hidden.includes(g.source + g.id));
  return (
    <Card title="Apps & games" icon={<LayoutGrid size={15} />}
      actions={<Segmented value={tab} onChange={setTab} options={[{ id: "games", label: "Games" }, { id: "apps", label: "Apps" }]} />}>
      {tab === "games" ? (
        games == null ? <Empty>Finding your games…</Empty> : shown.length === 0 ? <Empty>No Steam games or Prism instances found</Empty> : (
          <div className="games-row">
            {shown.map((g) => <GameTile key={g.source + g.id} g={g} />)}
          </div>
        )
      ) : (
        <PinnedApps />
      )}
    </Card>
  );
}
