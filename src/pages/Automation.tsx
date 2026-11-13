import { AnimatePresence, motion } from "framer-motion";
import { Bell, Bot, CalendarClock, Play, Plus, TerminalSquare, Trash2 } from "lucide-react";
import { ReactNode, useState } from "react";
import { Card, Empty, IconBtn, Segmented, Slider, Switch } from "../components/ui";
import { api, AlertCfg } from "../lib/api";
import { COMMAND_HELP } from "../lib/actions";
import { nextRun, runSchedule } from "../lib/schedules";
import { Schedule, toast, useSettings } from "../lib/store";
import { sfx } from "../lib/util";
import { PageHeader } from "./Pages";

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];

const blank = (): Schedule => ({ id: Math.random().toString(36).slice(2), name: "", enabled: true, when: "daily", time: "08:00", days: [], minutes: 60, kind: "command", action: "", lastRun: Date.now() });

function describe(s: Schedule) {
  if (s.when === "startup") return "When Halo starts";
  if (s.when === "interval") return `Every ${s.minutes >= 60 && s.minutes % 60 === 0 ? `${s.minutes / 60} hour${s.minutes > 60 ? "s" : ""}` : `${s.minutes} min`}`;
  if (s.when === "once") return `Once, ${new Date(s.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  const [h, m] = s.time.split(":").map(Number);
  const t = new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (!s.days.length || s.days.length === 7) return `Every day at ${t}`;
  if (s.days.join() === "1,2,3,4,5") return `Weekdays at ${t}`;
  if (s.days.join() === "0,6") return `Weekends at ${t}`;
  return `${s.days.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ")} at ${t}`;
}

function Editor({ init, onDone }: { init: Schedule; onDone: () => void }) {
  const [s, setS] = useState(init);
  const set = useSettings((x) => x.set);
  const save = () => {
    if (!s.action.trim()) return toast("Add something for it to do", "warn");
    const all = useSettings.getState().schedules;
    const named = { ...s, name: s.name.trim() || s.action.slice(0, 40) };
    set({ schedules: all.some((x) => x.id === s.id) ? all.map((x) => (x.id === s.id ? named : x)) : [...all, named] });
    sfx("toggle");
    toast("Schedule saved");
    onDone();
  };
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  return (
    <motion.div className="sched-editor" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
      <div className="editor-grid">
        <label className="field"><span>Name</span><input className="input no-drag" value={s.name} placeholder="e.g. Night mode" onKeyDown={stop} onChange={(e) => setS({ ...s, name: e.target.value })} /></label>
        <label className="field"><span>When</span>
          <Segmented value={s.when} onChange={(w) => setS({ ...s, when: w, time: w === "once" ? new Date(Date.now() + 3600_000).toISOString().slice(0, 16) : w === "daily" ? "08:00" : s.time })}
            options={[{ id: "daily", label: "Daily" }, { id: "once", label: "Once" }, { id: "interval", label: "Repeat" }, { id: "startup", label: "At startup" }]} />
        </label>
        {s.when === "daily" && (
          <>
            <label className="field"><span>Time</span><input className="input no-drag" type="time" value={s.time} onKeyDown={stop} onChange={(e) => setS({ ...s, time: e.target.value })} /></label>
            <div className="field"><span>Days <span className="faint">(none = every day)</span></span>
              <div className="day-pick">{DAYS.map((d, i) => (
                <button key={i} className={s.days.includes(i) ? "on" : ""} onClick={() => setS({ ...s, days: s.days.includes(i) ? s.days.filter((x) => x !== i) : [...s.days, i].sort() })}>{d}</button>
              ))}</div>
            </div>
          </>
        )}
        {s.when === "once" && <label className="field"><span>Date & time</span><input className="input no-drag" type="datetime-local" value={s.time} onKeyDown={stop} onChange={(e) => setS({ ...s, time: e.target.value })} /></label>}
        {s.when === "interval" && <label className="field"><span>Every (minutes)</span><input className="input no-drag" type="number" min={1} value={s.minutes} onKeyDown={stop} onChange={(e) => setS({ ...s, minutes: Math.max(1, +e.target.value) })} /></label>}
        <label className="field span2"><span>Do this</span>
          <Segmented value={s.kind} onChange={(k) => setS({ ...s, kind: k })} options={[{ id: "command", label: <><TerminalSquare size={12} /> Halo command</> }, { id: "ai", label: <><Bot size={12} /> Ask the assistant</> }]} />
        </label>
        <label className="field span2">
          <textarea className="input no-drag ta" rows={2} value={s.action} onKeyDown={stop} onChange={(e) => setS({ ...s, action: e.target.value })}
            placeholder={s.kind === "ai" ? "e.g. If any app is using over 2 GB of RAM, close it, then clean temp files" : "e.g. volume 20"} />
        </label>
        {s.kind === "command" && <div className="faint small span2 cmd-help">{COMMAND_HELP.join("  ·  ")}</div>}
      </div>
      <div className="btn-row">
        <button className="pill accent-pill" onClick={save}>Save</button>
        <button className="pill" onClick={onDone}>Cancel</button>
      </div>
    </motion.div>
  );
}

function Schedules() {
  const list = useSettings((s) => s.schedules);
  const set = useSettings((s) => s.set);
  const [editing, setEditing] = useState<Schedule | null>(null);
  return (
    <Card title="Schedules" icon={<CalendarClock size={15} />} actions={!editing && <button className="pill accent-pill" onClick={() => setEditing(blank())}><Plus size={14} /> New</button>}>
      <AnimatePresence>{editing && <Editor key={editing.id} init={editing} onDone={() => setEditing(null)} />}</AnimatePresence>
      <div className="sched-list">
        {list.length === 0 && !editing && <Empty>Run anything on a schedule — a Halo command or a request to the assistant.</Empty>}
        {list.map((s) => {
          const nx = nextRun(s);
          return (
            <div key={s.id} className={`sched ${s.enabled ? "" : "off"}`}>
              <div className="sched-icon">{s.kind === "ai" ? <Bot size={16} /> : <TerminalSquare size={16} />}</div>
              <div className="col-flex grow" onClick={() => setEditing(s)} style={{ cursor: "pointer", minWidth: 0 }}>
                <b className="ellipsis">{s.name}</b>
                <span className="faint small ellipsis">{describe(s)} · {s.action}</span>
                {nx && <span className="accent small">Next: {nx.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>}
              </div>
              <IconBtn title="Run now" onClick={() => { sfx("launch"); runSchedule(s).then(() => toast(`Ran ${s.name}`)); }}><Play size={14} /></IconBtn>
              <IconBtn title="Delete" onClick={() => set({ schedules: list.filter((x) => x.id !== s.id) })}><Trash2 size={14} /></IconBtn>
              <Switch on={s.enabled} onChange={(v) => set({ schedules: list.map((x) => (x.id === s.id ? { ...x, enabled: v, lastRun: v ? Date.now() : x.lastRun } : x)) })} />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const Row = ({ label, sub, children }: { label: string; sub?: string; children: ReactNode }) => (
  <div className="set-row">
    <div><div className="set-label">{label}</div>{sub && <div className="faint small">{sub}</div>}</div>
    <div className="set-ctl">{children}</div>
  </div>
);

function Alerts() {
  const a = useSettings((s) => s.alerts);
  const f = useSettings((s) => s.fahrenheit);
  const set = useSettings((s) => s.set);
  const upd = (p: Partial<AlertCfg>) => set({ alerts: { ...a, ...p } });
  const T = (c: number) => (f ? `${Math.round(c * 9 / 5 + 32)}°F` : `${c}°C`);
  const Thr = ({ k, label, sub, min, max, def, fmt }: { k: "cpu_temp" | "gpu_temp" | "disk_free_pct" | "hog_cpu"; label: string; sub: string; min: number; max: number; def: number; fmt: (v: number) => string }) => {
    const v = a[k];
    return (
      <div className="alert-row">
        <Row label={label} sub={v != null ? `${sub} ${fmt(v)}` : "Off"}>
          <Switch on={v != null} onChange={(on) => upd({ [k]: on ? def : null })} />
        </Row>
        {v != null && <div className="alert-slider"><Slider value={v} min={min} max={max} label={fmt(v)} onChange={(x) => upd({ [k]: Math.round(x) })} /></div>}
      </div>
    );
  };
  return (
    <Card title="Alerts" icon={<Bell size={15} />} actions={<button className="pill" onClick={() => api.testToast()}>Test alert</button>}>
      <div className="faint small" style={{ marginBottom: 6 }}>Glass pop-ups in the corner of your screen — even when Halo is closed. Each alert waits 15 minutes before repeating.</div>
      <Thr k="cpu_temp" label="CPU too hot" sub="Above" min={70} max={105} def={95} fmt={T} />
      <Thr k="gpu_temp" label="GPU too hot" sub="Above" min={65} max={95} def={87} fmt={T} />
      <Thr k="disk_free_pct" label="Disk almost full" sub="Less than" min={2} max={30} def={8} fmt={(v) => `${v}% free`} />
      <Thr k="hog_cpu" label="App hogging the CPU" sub="One app over" min={30} max={100} def={70} fmt={(v) => `${v}% for a minute`} />
      <Row label="Internet down" sub="Tells you when it drops and when it's back"><Switch on={a.net_down} onChange={(v) => upd({ net_down: v })} /></Row>
    </Card>
  );
}

export function AutomationPage() {
  return (
    <div className="page">
      <PageHeader title="Automation" sub="Schedules and alerts that run in the background" />
      <div className="page-grid">
        <div className="span-6"><Schedules /></div>
        <div className="span-6"><Alerts /></div>
      </div>
    </div>
  );
}

