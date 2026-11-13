import { AnimatePresence, motion } from "framer-motion";
import { Cpu, EyeOff, Gamepad2, Lock, MemoryStick, MonitorCog, Music, RefreshCw, Search, Signal, SignalLow, SignalMedium, Thermometer, Unlock, Wifi, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppIcon, Bar, Card, Empty, Graph, IconBtn, Ring, Segmented, Slider } from "../components/ui";
import { api, AppVolume, WifiNet } from "../lib/api";
import { useLive } from "../lib/live";
import { toast, useSettings, useUi } from "../lib/store";
import { fmtBytes, fmtTemp, fmtUptime, sfx, usePoll } from "../lib/util";
import { BatteryModule, DiskModule, NetModule } from "../modules/SystemModules";
import { DevicePicker, PowerRow, useAudio } from "../modules/Quick";
import { GameTile, PinnedApps, useLibrary } from "../modules/Launcher";
import { MediaModule } from "../modules/Media";
import { Devices, SpeedTest } from "./NetTools";
import { FpsCard } from "./FpsCard";

export function PageHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {sub && <p className="dim">{sub}</p>}
    </div>
  );
}

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const rise = { hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 240, damping: 24 } } };

// ---------- System ----------
export function SystemPage() {
  const s = useLive((l) => l.stats);
  const h = useLive((l) => l.hist);
  const f = useSettings((x) => x.fahrenheit);
  const ramPct = s ? (s.ram_used / s.ram_total) * 100 : 0;
  return (
    <div className="page">
      <PageHeader title="System" sub={s ? `${s.cpu_name} · up ${fmtUptime(s.uptime)} · ${s.processes} processes` : ""} />
      <motion.div className="page-grid sys" variants={stagger} initial="hidden" animate="show">
        <motion.div variants={rise} className="span-6">
          <Card title="Processor" icon={<Cpu size={15} />}>
            <div className="sys-top">
              <Ring value={s?.cpu ?? 0} size={150} stroke={12} label={`${Math.round(s?.cpu ?? 0)}%`} sub={`${((s?.cpu_mhz ?? 0) / 1000).toFixed(2)} GHz`} />
              <div className="sys-side">
                <div className="kv">
                  <span>Temperature</span><b>{fmtTemp(s?.cpu_temp, f)}</b>
                  <span>Threads</span><b>{s?.cores.length}</b>
                </div>
                <div className="cores">
                  {s?.cores.map((c, i) => (
                    <div key={i} className="core" title={`Thread ${i}: ${Math.round(c)}%`}>
                      <motion.div className="core-fill" animate={{ height: `${c}%` }} transition={{ type: "spring", stiffness: 120, damping: 20 }} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <Graph data={h.cpu} max={100} height={90} />
          </Card>
        </motion.div>
        <motion.div variants={rise} className="span-6">
          <Card title={s?.gpu?.name ?? "Graphics"} icon={<MonitorCog size={15} />}>
            {s?.gpu ? (
              <>
                <div className="sys-top">
                  <Ring value={s.gpu.load} size={150} stroke={12} color="var(--accent-2)" label={`${Math.round(s.gpu.load)}%`} sub={s.gpu.clock_mhz ? `${s.gpu.clock_mhz} MHz` : ""} />
                  <div className="sys-side">
                    <div className="kv">
                      <span>Temperature</span><b>{fmtTemp(s.gpu.temp, f)}</b>
                      <span>Power</span><b>{s.gpu.power_w != null ? `${s.gpu.power_w.toFixed(1)} W` : "—"}</b>
                      <span>Fan</span><b>{s.gpu.fan_pct != null ? `${s.gpu.fan_pct}%` : "Auto"}</b>
                      <span>VRAM</span><b>{fmtBytes(s.gpu.vram_used)} / {fmtBytes(s.gpu.vram_total, 0)}</b>
                    </div>
                    <Bar value={s.gpu.vram_used} max={s.gpu.vram_total || 1} color="var(--accent-2)" />
                  </div>
                </div>
                <Graph data={h.gpu} max={100} height={90} color="var(--accent-2)" />
              </>
            ) : <Empty>The NVIDIA GPU is asleep (normal on laptops when nothing uses it)</Empty>}
          </Card>
        </motion.div>
        <motion.div variants={rise} className="span-4">
          <Card title="Memory" icon={<MemoryStick size={15} />}>
            <div className="big-num">{Math.round(ramPct)}<small>%</small></div>
            <div className="dim small">{fmtBytes(s?.ram_used ?? 0)} used of {fmtBytes(s?.ram_total ?? 0, 0)}</div>
            <Graph data={h.ram} max={100} height={80} color="var(--accent-3)" />
          </Card>
        </motion.div>
        <motion.div variants={rise} className="span-4">
          <Card title="Temperatures" icon={<Thermometer size={15} />}>
            <div className="dim small">CPU {fmtTemp(s?.cpu_temp, f)} · GPU {fmtTemp(s?.gpu?.temp, f)}</div>
            <Graph data={h.cpuTemp} data2={h.gpuTemp} max={100} height={110} color="#ff9f6b" color2="var(--accent-2)" />
            {s?.cpu_temp == null && <div className="faint small">CPU temperature needs Halo to run as admin.</div>}
          </Card>
        </motion.div>
        <motion.div variants={rise} className="span-4"><NetModule /></motion.div>
        <motion.div variants={rise} className="span-6"><DiskModule /></motion.div>
        <motion.div variants={rise} className="span-6"><BatteryModule /></motion.div>
      </motion.div>
    </div>
  );
}

// ---------- Library ----------
export function LibraryPage() {
  const { games, load } = useLibrary();
  const hidden = useSettings((s) => s.hiddenGames);
  const set = useSettings((s) => s.set);
  const [tab, setTab] = useState<"all" | "steam" | "prism">("all");
  const [q, setQ] = useState("");
  const [manage, setManage] = useState(false);
  useEffect(load, [load]);
  const list = (games ?? []).filter((g) => (tab === "all" || g.source === tab) && g.name.toLowerCase().includes(q.toLowerCase()) && (manage || !hidden.includes(g.source + g.id)));
  return (
    <div className="page">
      <PageHeader title="Library" sub="Steam games and Prism Launcher instances, plus your pinned apps" />
      <div className="toolbar">
        <Segmented value={tab} onChange={setTab} options={[{ id: "all", label: "All" }, { id: "steam", label: "Steam" }, { id: "prism", label: "Minecraft" }]} />
        <div className="search-field small"><Search size={15} /><input placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <button className={`pill ${manage ? "accent-pill" : ""}`} onClick={() => setManage(!manage)}><EyeOff size={14} /> {manage ? "Done" : "Hide games"}</button>
      </div>
      {games == null ? <Empty>Scanning…</Empty> : (
        <motion.div className="library" variants={stagger} initial="hidden" animate="show">
          {list.map((g) => {
            const key = g.source + g.id;
            const isHidden = hidden.includes(key);
            return (
              <motion.div key={key} variants={rise} className={`lib-item ${isHidden ? "is-hidden" : ""}`}>
                <GameTile g={g} big />
                {manage && (
                  <button className="hide-btn" onClick={() => set({ hiddenGames: isHidden ? hidden.filter((h) => h !== key) : [...hidden, key] })}>
                    {isHidden ? "Show" : "Hide"}
                  </button>
                )}
              </motion.div>
            );
          })}
          {list.length === 0 && <Empty><Gamepad2 size={28} /> Nothing here</Empty>}
        </motion.div>
      )}
      <div className="page-grid">
        <div className="span-6"><h2 className="section">Pinned apps</h2><Card><PinnedApps size={52} /></Card></div>
        <div className="span-6"><h2 className="section">In-game overlay</h2><FpsCard /></div>
      </div>
    </div>
  );
}

// ---------- Network & audio ----------
function WifiList() {
  const [nets, setNets] = useState<WifiNet[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState<{ ssid: string; value: string } | null>(null);
  const refresh = () => {
    setBusy(true);
    api.wifi().then(setNets).catch(() => setNets([])).finally(() => setBusy(false));
  };
  useEffect(refresh, []);
  const connect = async (n: WifiNet, password?: string) => {
    sfx("click");
    try {
      await api.connectWifi(n.ssid, password);
      toast(`Connecting to ${n.ssid}…`);
      setPw(null);
      setTimeout(refresh, 4000);
    } catch (e) {
      toast(`Couldn't connect: ${e}`, "warn");
    }
  };
  return (
    <Card title="Wi-Fi networks" icon={<Wifi size={15} />} actions={<IconBtn onClick={refresh} title="Rescan"><RefreshCw size={14} className={busy ? "spin" : ""} /></IconBtn>}>
      <div className="wifi-list">
        {nets?.map((n) => {
          const S = n.signal > 66 ? Signal : n.signal > 33 ? SignalMedium : SignalLow;
          return (
            <div key={n.ssid} className={`wifi ${n.connected ? "on" : ""}`}>
              <S size={16} />
              <div className="wifi-name">
                <b>{n.ssid}</b>
                <span className="faint small">{n.connected ? "Connected" : n.known ? "Saved" : n.secure ? "Secured" : "Open"} · {n.signal}%</span>
              </div>
              {n.secure ? <Lock size={13} className="faint" /> : <Unlock size={13} className="faint" />}
              {n.connected ? (
                <button className="pill" onClick={() => { api.disconnectWifi(); setTimeout(refresh, 1500); }}>Disconnect</button>
              ) : n.known || !n.secure ? (
                <button className="pill accent-pill" onClick={() => connect(n)}>Connect</button>
              ) : (
                <button className="pill" onClick={() => setPw({ ssid: n.ssid, value: "" })}>Connect</button>
              )}
              <AnimatePresence>
                {pw?.ssid === n.ssid && (
                  <motion.form className="wifi-pw" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                    onSubmit={(e) => { e.preventDefault(); connect(n, pw.value); }}>
                    <input className="input" type="password" autoFocus placeholder="Password" value={pw.value} onChange={(e) => setPw({ ...pw, value: e.target.value })} />
                    <button className="pill accent-pill" type="submit">Join</button>
                    <IconBtn onClick={() => setPw(null)}><X size={14} /></IconBtn>
                  </motion.form>
                )}
              </AnimatePresence>
            </div>
          );
        })}
        {nets?.length === 0 && <Empty>No networks found (is Wi-Fi off?)</Empty>}
        {nets == null && <Empty>Scanning…</Empty>}
      </div>
    </Card>
  );
}

function Mixer() {
  const polled = usePoll(api.appVolumes, 2000);
  const [apps, setApps] = useState<AppVolume[]>([]);
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => { if (polled && drag == null) setApps(polled); }, [polled, drag]);
  return (
    <div className="mixer">
      {apps.map((a) => (
        <div key={a.pid} className="mix-row">
          <MixIcon pid={a.pid} name={a.name} />
          <span className="mix-name ellipsis">{a.name}</span>
          <Slider value={a.muted ? 0 : a.volume}
            onChange={(v) => { setDrag(a.pid); setApps((xs) => xs.map((x) => (x.pid === a.pid ? { ...x, volume: v, muted: false } : x))); api.setAppVolume(a.pid, v, false); }}
            onCommit={(v) => { setDrag(null); api.setAppVolume(a.pid, v, false); }} />
        </div>
      ))}
      {apps.length === 0 && <Empty>No apps are playing sound</Empty>}
    </div>
  );
}
function MixIcon({ pid, name }: { pid: number; name: string }) {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => { api.exePath?.(pid).then(setPath).catch(() => {}); }, [pid]);
  return path ? <AppIcon path={path} size={26} fallback={name} /> : <div className="appicon-fallback" style={{ width: 26, height: 26, fontSize: 12 }}>{pid === 0 ? <Music size={13} /> : name[0]}</div>;
}

export function NetworkPage() {
  const { audio, setAudio, setVol, commit } = useAudio();
  return (
    <div className="page">
      <PageHeader title="Network & audio" sub="Wi-Fi, output devices, and per-app volume" />
      <motion.div className="page-grid" variants={stagger} initial="hidden" animate="show">
        <motion.div variants={rise} className="span-6"><WifiList /></motion.div>
        <motion.div variants={rise} className="span-6 col">
          <Card title="Sound" icon={<Music size={15} />}>
            <div className="quick">
              <Slider value={audio?.muted ? 0 : audio?.volume ?? 0} onChange={setVol} onCommit={commit} />
              {audio && <DevicePicker audio={audio} onPick={() => api.audio().then(setAudio)} />}
              <h3 className="sub-head">Volume mixer</h3>
              <Mixer />
            </div>
          </Card>
          <MediaModule />
          <Card title="Power"><PowerRow /></Card>
        </motion.div>
        <motion.div variants={rise} className="span-6"><SpeedTest /></motion.div>
        <motion.div variants={rise} className="span-6"><Devices /></motion.div>
      </motion.div>
    </div>
  );
}

export function useSearchIndex() {
  const { games, apps, load } = useLibrary();
  useEffect(load, [load]);
  return useMemo(() => ({ games: games ?? [], apps: apps ?? [] }), [games, apps]);
}

export function useVisible() {
  return useUi((s) => s.visible);
}
