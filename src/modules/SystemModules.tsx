import { Activity, ArrowDown, ArrowUp, BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, Cpu, Gauge, HardDrive, LineChart, MemoryStick, MonitorCog, Plug, Zap } from "lucide-react";
import { Bar, Card, Graph, IconBtn, Ring, Segmented } from "../components/ui";
import { useLive } from "../lib/live";
import { useSettings, StatView } from "../lib/store";
import { fmtBytes, fmtRate, fmtTemp, fmtUptime } from "../lib/util";
import { api } from "../lib/api";
import { PowerRow } from "./Quick";
import { useEffect, useState } from "react";

function useView(key: string): [StatView, () => void] {
  const views = useSettings((s) => s.statViews);
  const set = useSettings((s) => s.set);
  const v = views[key] ?? "gauge";
  return [v, () => set({ statViews: { ...views, [key]: v === "gauge" ? "graph" : "gauge" } })];
}

const ViewToggle = ({ view, toggle }: { view: StatView; toggle: () => void }) => (
  <IconBtn title={view === "gauge" ? "Show graph" : "Show gauge"} onClick={toggle}>
    {view === "gauge" ? <LineChart size={15} /> : <Gauge size={15} />}
  </IconBtn>
);

const tempColor = (t: number | null | undefined) =>
  t == null ? "var(--accent)" : t >= 90 ? "#ff5d5d" : t >= 78 ? "#ffb547" : "var(--accent)";

export function CpuModule() {
  const s = useLive((l) => l.stats);
  const hist = useLive((l) => l.hist.cpu);
  const f = useSettings((x) => x.fahrenheit);
  const [view, toggle] = useView("cpu");
  return (
    <Card title="CPU" icon={<Cpu size={15} />} actions={<ViewToggle view={view} toggle={toggle} />}>
      {view === "gauge" ? (
        <div className="stat-gauge">
          <Ring value={s?.cpu ?? 0} label={`${Math.round(s?.cpu ?? 0)}%`} sub={`${((s?.cpu_mhz ?? 0) / 1000).toFixed(1)} GHz`} size={118} />
          <div className="stat-chips">
            <span className="chip" style={{ color: tempColor(s?.cpu_temp) }}>{fmtTemp(s?.cpu_temp, f)}</span>
          </div>
        </div>
      ) : (
        <div className="stat-graph">
          <div className="big-num">{Math.round(s?.cpu ?? 0)}<small>%</small></div>
          <div className="dim small">{fmtTemp(s?.cpu_temp, f)} · {((s?.cpu_mhz ?? 0) / 1000).toFixed(1)} GHz</div>
          <Graph data={hist} max={100} />
        </div>
      )}
    </Card>
  );
}

export function GpuModule() {
  const s = useLive((l) => l.stats);
  const hist = useLive((l) => l.hist.gpu);
  const f = useSettings((x) => x.fahrenheit);
  const [view, toggle] = useView("gpu");
  const g = s?.gpu;
  return (
    <Card title={g?.name ?? "GPU"} icon={<MonitorCog size={15} />} actions={<ViewToggle view={view} toggle={toggle} />}>
      {!g ? (
        <div className="empty small">GPU asleep or unavailable</div>
      ) : view === "gauge" ? (
        <div className="stat-gauge">
          <Ring value={g.load} label={`${Math.round(g.load)}%`} sub={g.vram_total ? `${fmtBytes(g.vram_used, 0)} VRAM` : ""} size={118} color="var(--accent-2)" />
          <div className="stat-chips">
            <span className="chip" style={{ color: tempColor(g.temp) }}>{fmtTemp(g.temp, f)}</span>
            {g.power_w != null && <span className="chip">{g.power_w.toFixed(0)} W</span>}
          </div>
        </div>
      ) : (
        <div className="stat-graph">
          <div className="big-num">{Math.round(g.load)}<small>%</small></div>
          <div className="dim small">{fmtTemp(g.temp, f)} · {fmtBytes(g.vram_used)} / {fmtBytes(g.vram_total)}</div>
          <Graph data={hist} max={100} color="var(--accent-2)" />
        </div>
      )}
    </Card>
  );
}

export function RamModule() {
  const s = useLive((l) => l.stats);
  const hist = useLive((l) => l.hist.ram);
  const [view, toggle] = useView("ram");
  const pct = s ? (s.ram_used / s.ram_total) * 100 : 0;
  return (
    <Card title="Memory" icon={<MemoryStick size={15} />} actions={<ViewToggle view={view} toggle={toggle} />}>
      {view === "gauge" ? (
        <div className="stat-gauge">
          <Ring value={pct} label={`${Math.round(pct)}%`} sub={`${fmtBytes(s?.ram_used ?? 0)}`} size={118} color="var(--accent-3)" />
          <div className="stat-chips">
            <span className="chip">{fmtBytes(s?.ram_total ?? 0, 0)} total</span>
          </div>
        </div>
      ) : (
        <div className="stat-graph">
          <div className="big-num">{Math.round(pct)}<small>%</small></div>
          <div className="dim small">{fmtBytes(s?.ram_used ?? 0)} of {fmtBytes(s?.ram_total ?? 0, 0)}</div>
          <Graph data={hist} max={100} color="var(--accent-3)" />
        </div>
      )}
    </Card>
  );
}

export function NetModule() {
  const s = useLive((l) => l.stats);
  const down = useLive((l) => l.hist.down);
  const up = useLive((l) => l.hist.up);
  return (
    <Card title="Network" icon={<Activity size={15} />}>
      <div className="net">
        <div className="net-row">
          <div><ArrowDown size={14} className="accent" /> <b>{fmtRate(s?.net_down ?? 0)}</b></div>
          <div><ArrowUp size={14} className="accent-2" /> <b>{fmtRate(s?.net_up ?? 0)}</b></div>
        </div>
        <Graph data={down} data2={up} height={60} />
        <div className="dim small">Since Halo started: ↓ {fmtBytes(s?.net_today_down ?? 0)} · ↑ {fmtBytes(s?.net_today_up ?? 0)}</div>
      </div>
    </Card>
  );
}

export function DiskModule() {
  const s = useLive((l) => l.stats);
  return (
    <Card title="Storage" icon={<HardDrive size={15} />}>
      <div className="disks">
        {s?.disks.map((d) => {
          const used = d.total - d.free;
          const pct = (used / Math.max(1, d.total)) * 100;
          return (
            <div key={d.mount} className="disk">
              <div className="row-between">
                <b>{d.mount.replace(/\\$/, "")}</b>
                <span className="dim small">{fmtBytes(d.free, 0)} free</span>
              </div>
              <Bar value={pct} color={pct > 90 ? "#ff5d5d" : pct > 75 ? "#ffb547" : "var(--accent)"} />
              <div className="faint small">{d.name || "Local disk"} · {fmtBytes(d.total, 0)}</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function BatteryModule() {
  const s = useLive((l) => l.stats);
  const b = s?.battery;
  const [mode, setMode] = useState<string>("balanced");
  useEffect(() => { api.powerMode().then(setMode).catch(() => {}); }, []);
  const Icon = !b ? Plug : b.charging ? BatteryCharging : b.percent > 70 ? BatteryFull : b.percent > 30 ? BatteryMedium : BatteryLow;
  return (
    <Card title="Battery & power" icon={<Zap size={15} />}>
      <div className="battery">
        <div className="battery-top">
          <Icon size={26} className={b && b.percent < 20 && !b.plugged ? "warn" : "accent"} />
          <div>
            <div className="big-num sm">{b ? `${b.percent}%` : "AC"}</div>
            <div className="dim small">
              {!b ? "Plugged in" : b.charging ? "Charging" : b.plugged ? "Plugged in" : b.minutes_left ? `${Math.floor(b.minutes_left / 60)}h ${b.minutes_left % 60}m left` : "On battery"}
            </div>
          </div>
        </div>
        <Segmented value={mode} onChange={(m) => { setMode(m); api.setPowerMode(m); }}
          options={[{ id: "efficiency", label: "Saver" }, { id: "balanced", label: "Balanced" }, { id: "performance", label: "Turbo" }]} />
        <PowerRow />
      </div>
    </Card>
  );
}

export function UptimeModule() {
  const s = useLive((l) => l.stats);
  return (
    <Card title="System" icon={<MonitorCog size={15} />}>
      <div className="kv">
        <span>CPU</span><b>{s?.cpu_name.replace(/\(R\)|\(TM\)|CPU|12th Gen/g, "").trim()}</b>
        <span>GPU</span><b>{s?.gpu?.name ?? "—"}</b>
        <span>Memory</span><b>{fmtBytes(s?.ram_total ?? 0, 0)}</b>
        <span>Uptime</span><b>{fmtUptime(s?.uptime ?? 0)}</b>
        <span>Processes</span><b>{s?.processes ?? "—"}</b>
      </div>
    </Card>
  );
}
