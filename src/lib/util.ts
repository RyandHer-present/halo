import { useEffect, useRef, useState } from "react";
import { useSettings, useUi } from "./store";

// ---------- formatting ----------
export const fmtBytes = (b: number, digits = 1) => {
  if (!b || b < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
};
export const fmtRate = (b: number) => `${fmtBytes(b)}/s`;
export const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};
export const fmtUptime = (s: number) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
export const fmtTemp = (c: number | null | undefined, f: boolean) =>
  c == null ? "—" : f ? `${Math.round(c * 9 / 5 + 32)}°` : `${Math.round(c)}°`;

// ---------- polling: only while Halo is visible (keeps it ~idle when hidden) ----------
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []): T | null {
  const visible = useUi((s) => s.visible);
  const [data, setData] = useState<T | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let t: number;
    const tick = async () => {
      try {
        const d = await fnRef.current();
        if (alive) setData(d);
      } catch (e) {
        console.warn(e);
      }
      if (alive) t = window.setTimeout(tick, ms);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, ms, ...deps]);
  return data;
}

/** Rolling history buffer for graphs. */
export function useHistory(value: number | null | undefined, len = 60) {
  const ref = useRef<number[]>([]);
  const last = useRef<number | null | undefined>(undefined);
  if (value != null && value !== last.current) {
    ref.current = [...ref.current, value].slice(-len);
  }
  last.current = value;
  return ref.current;
}

// ---------- color ----------
export function hexToRgb(hex: string) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
}
export const rgbToHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** Pick a vivid, representative color from an image (data URL). */
export function dominantColor(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      const S = 48;
      c.width = S;
      c.height = S;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, S, S);
      const d = ctx.getImageData(0, 0, S, S).data;
      // bucket by hue, weight by saturation * brightness
      const buckets: { w: number; r: number; g: number; b: number }[] = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const val = max / 255;
        if (val < 0.18 || sat < 0.2) continue;
        let h = 0;
        if (max !== min) {
          if (max === r) h = ((g - b) / (max - min)) % 6;
          else if (max === g) h = (b - r) / (max - min) + 2;
          else h = (r - g) / (max - min) + 4;
        }
        h = ((h * 60) + 360) % 360;
        const k = Math.floor(h / 15);
        const w = sat * sat * val;
        buckets[k].w += w;
        buckets[k].r += r * w;
        buckets[k].g += g * w;
        buckets[k].b += b * w;
      }
      const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
      if (best.w < 0.5) return resolve(null);
      let [r, g, b] = [best.r / best.w, best.g / best.w, best.b / best.w];
      // lift dark colors so the accent reads on glass
      const max = Math.max(r, g, b);
      if (max < 170) {
        const k = 170 / max;
        r *= k; g *= k; b *= k;
      }
      resolve(rgbToHex(Math.min(r, 255), Math.min(g, 255), Math.min(b, 255)));
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// ---------- sounds (synthesized, no files) ----------
let actx: AudioContext | null = null;
export function sfx(kind: "click" | "toggle" | "open" | "close" | "hover" | "launch" | "error") {
  const { sounds, soundVolume } = useSettings.getState();
  if (!sounds) return;
  try {
    actx ??= new AudioContext();
    const t = actx.currentTime;
    const out = actx.createGain();
    out.gain.value = soundVolume * 0.35;
    out.connect(actx.destination);
    const tone = (freq: number, start: number, dur: number, type: OscillatorType = "sine", vol = 1, to?: number) => {
      const o = actx!.createOscillator();
      const g = actx!.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t + start);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t + start + dur);
      g.gain.setValueAtTime(0, t + start);
      g.gain.linearRampToValueAtTime(vol, t + start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      o.connect(g);
      g.connect(out);
      o.start(t + start);
      o.stop(t + start + dur + 0.02);
    };
    switch (kind) {
      case "hover": tone(1800, 0, 0.03, "sine", 0.08); break;
      case "click": tone(900, 0, 0.05, "triangle", 0.5, 600); break;
      case "toggle": tone(700, 0, 0.06, "sine", 0.5); tone(1050, 0.05, 0.08, "sine", 0.4); break;
      case "open": tone(420, 0, 0.35, "sine", 0.35, 880); tone(840, 0.05, 0.3, "sine", 0.12, 1320); break;
      case "close": tone(760, 0, 0.25, "sine", 0.3, 360); break;
      case "launch": tone(523, 0, 0.12, "sine", 0.4); tone(784, 0.08, 0.14, "sine", 0.35); tone(1046, 0.16, 0.25, "sine", 0.3); break;
      case "error": tone(220, 0, 0.18, "square", 0.15); tone(180, 0.12, 0.2, "square", 0.12); break;
    }
  } catch {
    /* audio unavailable */
  }
}

// ---------- motion ----------
export function useMotion() {
  const motion = useSettings((s) => s.motion);
  const on = motion !== "off";
  const lots = motion === "lots";
  return {
    on,
    lots,
    spring: on
      ? lots
        ? { type: "spring" as const, stiffness: 260, damping: 22, mass: 0.9 }
        : { type: "spring" as const, stiffness: 400, damping: 40 }
      : { duration: 0 },
    stagger: lots ? 0.045 : on ? 0.015 : 0,
  };
}
