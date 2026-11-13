import { AnimatePresence, motion } from "framer-motion";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, ListTodo, MapPin, Moon, Plus, Sun, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Card, IconBtn, Segmented } from "../components/ui";
import { useSettings, useUi } from "../lib/store";
import { sfx, useMotion } from "../lib/util";

// ---------- Clock + calendar ----------
function Digit({ d }: { d: string }) {
  const { on } = useMotion();
  return (
    <span className="digit">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={d} initial={on ? { y: "-60%", opacity: 0, filter: "blur(4px)" } : false}
          animate={{ y: 0, opacity: 1, filter: "blur(0px)" }} exit={on ? { y: "60%", opacity: 0, filter: "blur(4px)" } : undefined}
          transition={{ type: "spring", stiffness: 300, damping: 26 }}>
          {d}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function ClockModule() {
  const [now, setNow] = useState(new Date());
  const h24 = useSettings((s) => s.clock24h);
  const events = useSettings((s) => s.events);
  const set = useSettings((s) => s.set);
  const [view, setView] = useState(new Date());
  const [picked, setPicked] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  let h = now.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  if (!h24) h = h % 12 || 12;
  const hh = h24 ? String(h).padStart(2, "0") : String(h);
  const mm = String(now.getMinutes()).padStart(2, "0");

  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: first.getDay() + days }, (_, i) => (i < first.getDay() ? null : i - first.getDay() + 1));
  const today = ymd(now);
  const upcoming = events.filter((e) => e.date >= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).slice(0, 2);

  return (
    <Card title="" pad>
      <div className="clock drag-handle">
        <div className="clock-time">
          {hh.split("").map((d, i) => <Digit key={"h" + i} d={d} />)}
          <span className="colon">:</span>
          {mm.split("").map((d, i) => <Digit key={"m" + i} d={d} />)}
          {!h24 && <span className="ampm">{ampm}</span>}
        </div>
        <div className="clock-date">{now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div>
      </div>
      <div className="cal">
        <div className="cal-head">
          <IconBtn onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}><ChevronLeft size={14} /></IconBtn>
          <span>{view.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
          <IconBtn onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}><ChevronRight size={14} /></IconBtn>
        </div>
        <div className="cal-grid">
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <span key={i} className="cal-dow">{d}</span>)}
          {cells.map((d, i) => {
            if (!d) return <span key={i} />;
            const key = ymd(new Date(view.getFullYear(), view.getMonth(), d));
            const has = events.some((e) => e.date === key);
            return (
              <button key={i} className={`cal-day ${key === today ? "today" : ""} ${key === picked ? "picked" : ""}`} onClick={() => { sfx("click"); setPicked(key === picked ? null : key); }}>
                {d}
                {has && <i className="cal-dot" />}
              </button>
            );
          })}
        </div>
        <AnimatePresence>
          {picked && (
            <motion.div className="cal-add" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
              {events.filter((e) => e.date === picked).map((e) => (
                <div key={e.id} className="event"><span>{e.time} {e.title}</span>
                  <button onClick={() => set({ events: events.filter((x) => x.id !== e.id) })}><X size={12} /></button></div>
              ))}
              <form onSubmit={(ev) => {
                ev.preventDefault();
                if (!draft.trim()) return;
                const m = draft.match(/^(\d{1,2}(:\d{2})?\s*(am|pm)?)\s+(.*)$/i);
                set({ events: [...events, { id: crypto.randomUUID(), date: picked, time: m ? m[1] : "", title: m ? m[4] : draft }] });
                setDraft("");
                sfx("toggle");
              }}>
                <input className="input" placeholder="e.g. 7pm Dentist" value={draft} onChange={(e) => setDraft(e.target.value)} />
              </form>
            </motion.div>
          )}
        </AnimatePresence>
        {!picked && upcoming.length > 0 && (
          <div className="upcoming">
            {upcoming.map((e) => (
              <div key={e.id} className="event"><CalendarDays size={12} /> <b>{e.date === today ? "Today" : new Date(e.date + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</b> {e.time} {e.title}</div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------- Weather ----------
interface Wx {
  city: string;
  temp: number;
  feels: number;
  code: number;
  isDay: boolean;
  hi: number;
  lo: number;
  hourly: { t: string; temp: number; code: number }[];
  daily: { d: string; hi: number; lo: number; code: number }[];
}
let wxCache: { at: number; data: Wx } | null = null;

const wxIcon = (code: number, day = true) => {
  if (code === 0) return day ? Sun : Moon;
  if (code <= 2) return CloudSun;
  if (code === 3) return Cloud;
  if (code <= 48) return CloudFog;
  if (code <= 57) return CloudDrizzle;
  if (code <= 67 || (code >= 80 && code <= 82)) return CloudRain;
  if (code <= 77 || code === 85 || code === 86) return CloudSnow;
  return CloudLightning;
};
const wxText = (code: number) =>
  code === 0 ? "Clear" : code <= 2 ? "Partly cloudy" : code === 3 ? "Cloudy" : code <= 48 ? "Foggy" : code <= 57 ? "Drizzle"
    : code <= 67 ? "Rain" : code <= 77 ? "Snow" : code <= 82 ? "Showers" : code <= 86 ? "Snow showers" : "Thunderstorms";

async function fetchWeather(f: boolean): Promise<Wx> {
  if (wxCache && Date.now() - wxCache.at < 15 * 60_000) return wxCache.data;
  const loc = await (await fetch("https://ipwho.is/")).json();
  const unit = f ? "&temperature_unit=fahrenheit" : "";
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,apparent_temperature,weather_code,is_day&hourly=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=6${unit}`;
  const w = await (await fetch(u)).json();
  const nowIdx = Math.max(0, w.hourly.time.findIndex((t: string) => new Date(t) >= new Date(Date.now() - 3600_000)));
  const data: Wx = {
    city: loc.city,
    temp: w.current.temperature_2m,
    feels: w.current.apparent_temperature,
    code: w.current.weather_code,
    isDay: !!w.current.is_day,
    hi: w.daily.temperature_2m_max[0],
    lo: w.daily.temperature_2m_min[0],
    hourly: w.hourly.time.slice(nowIdx + 1, nowIdx + 7).map((t: string, i: number) => ({ t, temp: w.hourly.temperature_2m[nowIdx + 1 + i], code: w.hourly.weather_code[nowIdx + 1 + i] })),
    daily: w.daily.time.slice(1).map((d: string, i: number) => ({ d, hi: w.daily.temperature_2m_max[i + 1], lo: w.daily.temperature_2m_min[i + 1], code: w.daily.weather_code[i + 1] })),
  };
  wxCache = { at: Date.now(), data };
  return data;
}

export function WeatherModule() {
  const f = useSettings((s) => s.fahrenheit);
  const visible = useUi((s) => s.visible);
  const [wx, setWx] = useState<Wx | null>(null);
  const [err, setErr] = useState(false);
  const { lots } = useMotion();
  useEffect(() => {
    if (!visible) return;
    wxCache = wxCache && (wxCache as any).f === f ? wxCache : null;
    fetchWeather(f).then((d) => { (wxCache as any).f = f; setWx(d); setErr(false); }).catch(() => setErr(true));
  }, [visible, f]);
  if (!wx) return <Card title="Weather" icon={<CloudSun size={15} />}><div className="empty small">{err ? "Weather unavailable (offline?)" : "Loading weather…"}</div></Card>;
  const Icon = wxIcon(wx.code, wx.isDay);
  return (
    <Card title="" pad>
      <div className="wx drag-handle">
        <div className="wx-top">
          <div>
            <div className="wx-city"><MapPin size={12} /> {wx.city}</div>
            <div className="wx-temp">{Math.round(wx.temp)}°</div>
            <div className="dim small">{wxText(wx.code)} · Feels {Math.round(wx.feels)}°</div>
            <div className="faint small">H {Math.round(wx.hi)}° · L {Math.round(wx.lo)}°</div>
          </div>
          <motion.div className="wx-icon" animate={lots ? (wx.code === 0 && wx.isDay ? { rotate: 360 } : { y: [0, -6, 0] }) : {}}
            transition={wx.code === 0 && wx.isDay ? { repeat: Infinity, duration: 40, ease: "linear" } : { repeat: Infinity, duration: 4, ease: "easeInOut" }}>
            <Icon size={64} strokeWidth={1.4} />
          </motion.div>
        </div>
        <div className="wx-hours">
          {wx.hourly.map((h) => {
            const I = wxIcon(h.code);
            return <div key={h.t} className="wx-hour"><span className="faint small">{new Date(h.t).toLocaleTimeString(undefined, { hour: "numeric" })}</span><I size={16} /><b>{Math.round(h.temp)}°</b></div>;
          })}
        </div>
        <div className="wx-days">
          {wx.daily.map((d) => {
            const I = wxIcon(d.code);
            return <div key={d.d} className="wx-day"><span className="dim">{new Date(d.d + "T00:00").toLocaleDateString(undefined, { weekday: "short" })}</span><I size={15} /><span><b>{Math.round(d.hi)}°</b> <span className="faint">{Math.round(d.lo)}°</span></span></div>;
          })}
        </div>
      </div>
    </Card>
  );
}

// ---------- To-do + notes ----------
export function TodoModule() {
  const todos = useSettings((s) => s.todos);
  const notes = useSettings((s) => s.notes);
  const set = useSettings((s) => s.set);
  const [tab, setTab] = useState<"todo" | "notes">("todo");
  const [draft, setDraft] = useState("");
  const left = useMemo(() => todos.filter((t) => !t.done).length, [todos]);
  return (
    <Card title={tab === "todo" ? `To-do${left ? ` · ${left}` : ""}` : "Notes"} icon={<ListTodo size={15} />}
      actions={<Segmented value={tab} onChange={setTab} options={[{ id: "todo", label: "To-do" }, { id: "notes", label: "Notes" }]} />}>
      {tab === "todo" ? (
        <div className="todo">
          <form className="todo-add" onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            sfx("toggle");
            set({ todos: [{ id: crypto.randomUUID(), text: draft.trim(), done: false }, ...todos] });
            setDraft("");
          }}>
            <Plus size={15} className="faint" />
            <input placeholder="Add a task…" value={draft} onChange={(e) => setDraft(e.target.value)} />
          </form>
          <div className="todo-list">
            <AnimatePresence initial={false}>
              {[...todos].sort((a, b) => Number(a.done) - Number(b.done)).map((t) => (
                <motion.div key={t.id} layout className={`todo-item ${t.done ? "done" : ""}`}
                  initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20, height: 0 }}>
                  <button className="todo-check" onClick={() => { sfx("toggle"); set({ todos: todos.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)) }); }}>
                    {t.done && <Check size={12} strokeWidth={3} />}
                  </button>
                  <span className="todo-text">{t.text}</span>
                  <button className="todo-del" onClick={() => set({ todos: todos.filter((x) => x.id !== t.id) })}><Trash2 size={13} /></button>
                </motion.div>
              ))}
            </AnimatePresence>
            {todos.length === 0 && <div className="empty small">All clear ✨</div>}
          </div>
        </div>
      ) : (
        <textarea className="notes" placeholder="Scratch pad — saved automatically" value={notes} onChange={(e) => set({ notes: e.target.value })} />
      )}
    </Card>
  );
}
