import { motion } from "framer-motion";
import { ArrowDown, ArrowUp, Gauge, Laptop, RefreshCw, Router, Smartphone, Tv, Wifi, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Card, Empty, IconBtn } from "../components/ui";
import { api, LanDevice, SpeedProgress, SpeedResult } from "../lib/api";
import { toast } from "../lib/store";
import { sfx } from "../lib/util";

let lastResult: SpeedResult | null = null;

function Dial({ value, max, label }: { value: number; max: number; label: string }) {
  const arc = 0.75;
  const r = 80, c = 2 * Math.PI * r;
  const pct = Math.min(1, Math.log10(1 + value) / Math.log10(1 + max));
  return (
    <div className="dial">
      <svg viewBox="0 0 200 200">
        <defs>
          <linearGradient id="dialg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="var(--accent-3)" /><stop offset="1" stopColor="var(--accent)" /></linearGradient>
        </defs>
        <g transform="rotate(135 100 100)">
          <circle cx="100" cy="100" r={r} fill="none" stroke="var(--track)" strokeWidth="14" strokeDasharray={`${c * arc} ${c}`} strokeLinecap="round" />
          <motion.circle cx="100" cy="100" r={r} fill="none" stroke="url(#dialg)" strokeWidth="14" strokeLinecap="round" strokeDasharray={`${c * arc} ${c}`}
            animate={{ strokeDashoffset: c * arc * (1 - pct) }} transition={{ type: "spring", stiffness: 70, damping: 16 }}
            style={{ filter: "drop-shadow(0 0 calc(var(--glow) * 10px) var(--accent))" }} />
        </g>
      </svg>
      <div className="dial-label">
        <div className="dial-num">{value >= 100 ? value.toFixed(0) : value.toFixed(1)}</div>
        <div className="faint small">{label}</div>
      </div>
    </div>
  );
}

export function SpeedTest() {
  const [p, setP] = useState<SpeedProgress | null>(null);
  const [res, setRes] = useState<SpeedResult | null>(lastResult);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    const un = listen<SpeedProgress>("halo://speed", (e) => setP(e.payload));
    return () => { un.then((f) => f()); };
  }, []);
  const run = async () => {
    sfx("launch");
    setRunning(true);
    setRes(null);
    setP(null);
    try {
      const r = await api.speedTest();
      lastResult = r;
      setRes(r);
      sfx("toggle");
    } catch (e) {
      toast(`Speed test failed: ${e}`, "warn");
    }
    setRunning(false);
  };
  const phase = running ? p?.phase ?? "ping" : "done";
  const live = running ? p?.mbps ?? 0 : res?.down ?? 0;
  return (
    <Card title="Speed test" icon={<Gauge size={15} />}>
      <div className="speed">
        <Dial value={live} max={1000} label={running ? (phase === "ping" ? "measuring ping…" : phase === "down" ? "Mbps download" : "Mbps upload") : res ? "Mbps download" : "Mbps"} />
        <div className="speed-side">
          <div className="speed-stat"><ArrowDown size={15} className="accent" /><span>Download</span><b>{res ? `${res.down.toFixed(1)}` : running && phase === "down" ? live.toFixed(1) : "—"}</b><small>Mbps</small></div>
          <div className="speed-stat"><ArrowUp size={15} className="accent-2" /><span>Upload</span><b>{res ? `${res.up.toFixed(1)}` : running && phase === "up" ? live.toFixed(1) : "—"}</b><small>Mbps</small></div>
          <div className="speed-stat"><Zap size={15} className="accent-3" /><span>Ping</span><b>{res ? res.ping.toFixed(0) : p?.ping ? p.ping.toFixed(0) : "—"}</b><small>ms</small></div>
          <div className="speed-stat"><Wifi size={15} /><span>Jitter</span><b>{res ? res.jitter.toFixed(1) : "—"}</b><small>ms</small></div>
          <button className="pill accent-pill" disabled={running} onClick={run}>{running ? <><RefreshCw size={13} className="spin" /> Testing…</> : res ? "Test again" : "Start test"}</button>
          {res && <div className="faint small">{res.server && res.server !== "Cloudflare" ? `Cloudflare · ${res.server}` : "Tested with Cloudflare"}</div>}
        </div>
      </div>
      {running && <div className="bar" style={{ height: 4, marginTop: 12 }}><motion.div className="bar-fill" style={{ background: "var(--accent)" }} animate={{ width: `${((phase === "ping" ? 0 : phase === "down" ? 1 : 2) + (p?.progress ?? 0)) / 3 * 100}%` }} /></div>}
    </Card>
  );
}

const devIcon = (d: LanDevice) => {
  const n = d.name.toLowerCase();
  if (d.gateway) return <Router size={18} />;
  if (d.me) return <Laptop size={18} />;
  if (/iphone|android|pixel|galaxy|phone/.test(n)) return <Smartphone size={18} />;
  if (/tv|roku|chromecast|vizio|onn|fire/.test(n)) return <Tv size={18} />;
  return <Wifi size={18} />;
};

let lastDevices: LanDevice[] | null = null;

export function Devices() {
  const [list, setList] = useState<LanDevice[] | null | "idle">(lastDevices ?? "idle");
  const scan = () => { setList(null); api.scanLan().then((l) => { lastDevices = l; setList(l); }).catch((e) => { toast(`${e}`, "warn"); setList([]); }); };
  return (
    <Card title={Array.isArray(list) ? `${list.length} devices on your network` : "Devices on your network"} icon={<Router size={15} />} actions={<IconBtn title="Scan" onClick={scan}><RefreshCw size={14} /></IconBtn>}>
      {list === "idle" ? <Empty><button className="pill accent-pill" onClick={scan}>Scan network</button><span className="faint small">Finds phones, TVs, consoles and other PCs on your Wi-Fi</span></Empty>
        : list == null ? <div className="scan-wait"><div className="scan-orb" /><b>Scanning your network…</b></div> : (
          <div className="dev-grid">
            {list.map((d) => (
              <motion.div key={d.ip} className={`dev ${d.me ? "me" : ""} ${d.gateway ? "gw" : ""}`} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
                <div className="dev-icon">{devIcon(d)}</div>
                <div className="col-flex" style={{ minWidth: 0 }}>
                  <b className="ellipsis">{d.gateway ? "Router" : d.name || "Unknown device"}</b>
                  <span className="faint small">{d.ip}{d.latency != null && !d.me ? ` · ${d.latency} ms` : ""}</span>
                  {d.mac && <span className="faint small mono">{d.mac}</span>}
                </div>
              </motion.div>
            ))}
          </div>
        )}
    </Card>
  );
}
