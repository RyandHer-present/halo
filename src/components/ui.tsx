import { motion } from "framer-motion";
import { ReactNode, useEffect, useId, useRef, useState, CSSProperties, MouseEvent } from "react";
import { sfx, useMotion } from "../lib/util";
import { api } from "../lib/api";

// ---------- Card: the glass module shell ----------
export function Card({
  title,
  icon,
  actions,
  children,
  className = "",
  style,
  pad = true,
}: {
  title?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  pad?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { lots } = useMotion();
  const onMove = (e: MouseEvent) => {
    if (!lots || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    ref.current.style.setProperty("--mx", `${e.clientX - r.left}px`);
    ref.current.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <div ref={ref} className={`card ${className}`} style={style} onMouseMove={onMove}>
      <span className="card-glow" />
      <span className="hud-corners" />
      {(title || actions) && (
        <div className="card-head drag-handle">
          <div className="card-title">
            {icon}
            <span>{title}</span>
          </div>
          <div className="card-actions">{actions}</div>
        </div>
      )}
      <div className={`card-body ${pad ? "" : "nopad"}`}>{children}</div>
    </div>
  );
}

// ---------- Ring gauge ----------
export function Ring({
  value,
  max = 100,
  size = 120,
  stroke = 10,
  label,
  sub,
  color = "var(--accent)",
}: {
  value: number;
  max?: number;
  size?: number;
  stroke?: number;
  label?: ReactNode;
  sub?: ReactNode;
  color?: string;
}) {
  const id = useId().replace(/:/g, "");
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const arc = 0.78; // 280° gauge
  const pct = Math.max(0, Math.min(1, value / max));
  const { on } = useMotion();
  return (
    <div className="ring" style={{ "--ring": `${size}px`, "--ring-scale": size / 118 } as CSSProperties}>
      <svg width="100%" height="100%" viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(130deg)" }}>
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.55" />
            <stop offset="100%" stopColor={color} />
          </linearGradient>
          <filter id={`f${id}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={stroke}
          strokeDasharray={`${c * arc} ${c}`} strokeLinecap="round" />
        <motion.circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" filter={`url(#f${id})`} style={{ opacity: "calc(var(--glow) * 0.8)" }}
          strokeDasharray={`${c * arc} ${c}`}
          initial={{ strokeDashoffset: c * arc }}
          animate={{ strokeDashoffset: c * arc * (1 - pct) }}
          transition={on ? { type: "spring", stiffness: 60, damping: 16 } : { duration: 0 }} />
        <motion.circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#g${id})`} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={`${c * arc} ${c}`}
          initial={{ strokeDashoffset: c * arc }}
          animate={{ strokeDashoffset: c * arc * (1 - pct) }}
          transition={on ? { type: "spring", stiffness: 60, damping: 16 } : { duration: 0 }} />
      </svg>
      <div className="ring-label">
        <div className="ring-value">{label}</div>
        {sub && <div className="ring-sub">{sub}</div>}
      </div>
    </div>
  );
}

// ---------- Line graph (smooth SVG, gradient fill) ----------
export function Graph({
  data,
  max,
  height = 70,
  color = "var(--accent)",
  data2,
  color2 = "var(--accent-2)",
}: {
  data: number[];
  max?: number;
  height?: number;
  color?: string;
  data2?: number[];
  color2?: string;
}) {
  const id = useId().replace(/:/g, "");
  const W = 300;
  const N = 60;
  const m = max ?? Math.max(1, ...data, ...(data2 ?? [])) * 1.15;
  const path = (arr: number[]) => {
    if (arr.length < 2) return "";
    const pts = arr.map((v, i) => [W - (arr.length - 1 - i) * (W / (N - 1)), height - (Math.min(v, m) / m) * (height - 4) - 2]);
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const cx = (x0 + x1) / 2;
      d += ` C ${cx} ${y0}, ${cx} ${y1}, ${x1} ${y1}`;
    }
    return d;
  };
  const area = (arr: number[]) => {
    const p = path(arr);
    if (!p) return "";
    const x0 = W - (arr.length - 1) * (W / (N - 1));
    return `${p} L ${W} ${height} L ${x0} ${height} Z`;
  };
  return (
    <svg className="graph" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ height }}>
      <defs>
        <linearGradient id={`a${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.45" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`b${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color2} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color2} stopOpacity="0" />
        </linearGradient>
      </defs>
      {data2 && <path d={area(data2)} fill={`url(#b${id})`} />}
      {data2 && <path d={path(data2)} fill="none" stroke={color2} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />}
      <path d={area(data)} fill={`url(#a${id})`} />
      <path d={path(data)} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"
        style={{ filter: "drop-shadow(0 0 calc(var(--glow) * 6px) " + color + ")" }} />
    </svg>
  );
}

// ---------- Bar meter ----------
export function Bar({ value, max = 100, color = "var(--accent)", h = 6 }: { value: number; max?: number; color?: string; h?: number }) {
  const { on } = useMotion();
  return (
    <div className="bar" style={{ height: h }}>
      <motion.div className="bar-fill" style={{ background: color }}
        initial={{ width: 0 }} animate={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%` }}
        transition={on ? { type: "spring", stiffness: 80, damping: 18 } : { duration: 0 }} />
    </div>
  );
}

// ---------- Slider (custom, smooth) ----------
export function Slider({
  value,
  onChange,
  onCommit,
  icon,
  min = 0,
  max = 1,
  label,
}: {
  label?: string;
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  icon?: ReactNode;
  min?: number;
  max?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const fromEvent = (x: number) => {
    const r = ref.current!.getBoundingClientRect();
    return min + Math.max(0, Math.min(1, (x - r.left) / r.width)) * (max - min);
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => onChange(fromEvent(e.clientX));
    const up = (e: PointerEvent) => {
      setDrag(false);
      onCommit?.(fromEvent(e.clientX));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  });
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className={`slider ${drag ? "drag" : ""}`} ref={ref}
      onPointerDown={(e) => {
        setDrag(true);
        onChange(fromEvent(e.clientX));
      }}
      onWheel={(e) => {
        const v = Math.max(min, Math.min(max, value - Math.sign(e.deltaY) * (max - min) * 0.04));
        onChange(v);
        onCommit?.(v);
      }}>
      <div className="slider-fill" style={{ width: `${pct}%` }} />
      {icon && <div className="slider-icon">{icon}</div>}
      <div className="slider-pct">{label ?? Math.round(pct)}</div>
    </div>
  );
}

// ---------- Toggle tile ----------
export function Tile({
  on,
  icon,
  label,
  sub,
  onClick,
  disabled,
}: {
  on?: boolean;
  icon: ReactNode;
  label: string;
  sub?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <motion.button className={`tile ${on ? "on" : ""}`} disabled={disabled} whileTap={{ scale: 0.95 }}
      onClick={() => {
        sfx("toggle");
        onClick?.();
      }}>
      <span className="tile-icon">{icon}</span>
      <span className="tile-text">
        <span className="tile-label">{label}</span>
        {sub && <span className="tile-sub">{sub}</span>}
      </span>
    </motion.button>
  );
}

export function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`switch ${on ? "on" : ""}`} onClick={() => { sfx("toggle"); onChange(!on); }}>
      <motion.span className="switch-knob" layout transition={{ type: "spring", stiffness: 500, damping: 30 }} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  const id = useId();
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.id} className={`seg-btn ${value === o.id ? "on" : ""}`} onClick={() => { sfx("click"); onChange(o.id); }}>
          {value === o.id && <motion.span layoutId={`seg${id}`} className="seg-pill" transition={{ type: "spring", stiffness: 500, damping: 35 }} />}
          <span className="seg-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function IconBtn({ children, onClick, title, big, active }: { children: ReactNode; onClick?: () => void; title?: string; big?: boolean; active?: boolean }) {
  return (
    <motion.button className={`iconbtn ${big ? "big" : ""} ${active ? "active" : ""}`} title={title} whileTap={{ scale: 0.88 }}
      whileHover={{ scale: 1.06 }} onClick={() => { sfx("click"); onClick?.(); }}>
      {children}
    </motion.button>
  );
}

// ---------- App icon (lazy) ----------
const iconCache = new Map<string, string | null>();
export function AppIcon({ path, size = 40, fallback }: { path: string; size?: number; fallback?: string }) {
  const [src, setSrc] = useState<string | null | undefined>(iconCache.get(path));
  useEffect(() => {
    if (iconCache.has(path)) return setSrc(iconCache.get(path));
    let alive = true;
    api.icon(path).then((s) => {
      iconCache.set(path, s);
      if (alive) setSrc(s);
    });
    return () => { alive = false; };
  }, [path]);
  if (!src)
    return (
      <div className="appicon-fallback" style={{ width: size, height: size, fontSize: size * 0.45 }}>
        {(fallback ?? "?").slice(0, 1).toUpperCase()}
      </div>
    );
  return <img src={src} width={size} height={size} className="appicon" draggable={false} />;
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
