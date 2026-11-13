// Runs scheduled actions. The main window keeps running while hidden, so a timer here
// is enough (Chromium may slow hidden timers to once a minute, which is fine for schedules).
import { useEffect } from "react";
import { runCommand } from "./actions";
import { ask } from "./ai";
import { Schedule, useSettings } from "./store";

/** The most recent moment this schedule should have fired, at or before `now`. */
export function lastDue(s: Schedule, now: Date): number | null {
  if (s.when === "interval") return s.lastRun + Math.max(1, s.minutes) * 60_000 <= now.getTime() ? now.getTime() : null;
  if (s.when === "once") {
    const t = new Date(s.time).getTime();
    return isNaN(t) || t > now.getTime() ? null : t;
  }
  if (s.when === "daily") {
    const [h, m] = s.time.split(":").map(Number);
    for (let back = 0; back < 8; back++) {
      const d = new Date(now);
      d.setDate(d.getDate() - back);
      d.setHours(h || 0, m || 0, 0, 0);
      if (d.getTime() > now.getTime()) continue;
      if (s.days.length && !s.days.includes(d.getDay())) continue;
      return d.getTime();
    }
  }
  return null;
}

export function nextRun(s: Schedule, now = new Date()): Date | null {
  if (!s.enabled) return null;
  if (s.when === "interval") return new Date(Math.max(now.getTime(), s.lastRun + s.minutes * 60_000));
  if (s.when === "once") { const t = new Date(s.time); return t.getTime() > now.getTime() && s.lastRun < t.getTime() ? t : null; }
  if (s.when === "daily") {
    const [h, m] = s.time.split(":").map(Number);
    for (let f = 0; f < 8; f++) {
      const d = new Date(now);
      d.setDate(d.getDate() + f);
      d.setHours(h || 0, m || 0, 0, 0);
      if (d.getTime() <= now.getTime()) continue;
      if (s.days.length && !s.days.includes(d.getDay())) continue;
      return d;
    }
  }
  return null;
}

export async function runSchedule(s: Schedule) {
  const mark = (extra: Partial<Schedule> = {}) => {
    const st = useSettings.getState();
    st.set({ schedules: st.schedules.map((x) => (x.id === s.id ? { ...x, lastRun: Date.now(), ...extra } : x)) });
  };
  mark(s.when === "once" ? { enabled: false } : {});
  try {
    if (s.kind === "ai") await ask(s.action, { headless: true });
    else await runCommand(s.action);
  } catch (e) {
    console.warn("schedule failed", s.name, e);
  }
}

let startupRan = false;

export function useScheduleRunner() {
  useEffect(() => {
    // wait until settings are loaded from disk
    const begin = setTimeout(() => {
      if (!startupRan) {
        startupRan = true;
        useSettings.getState().schedules.filter((s) => s.enabled && s.when === "startup").forEach(runSchedule);
      }
    }, 4000);
    const tick = () => {
      const now = new Date();
      for (const s of useSettings.getState().schedules) {
        if (!s.enabled || s.when === "startup") continue;
        const due = lastDue(s, now);
        // fire if due since the last run, but not if we missed it by more than 30 minutes (PC asleep)
        if (due != null && due > s.lastRun && now.getTime() - due < 30 * 60_000) runSchedule(s);
      }
    };
    const id = setInterval(tick, 20_000);
    return () => { clearTimeout(begin); clearInterval(id); };
  }, []);
}
