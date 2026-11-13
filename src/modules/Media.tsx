import { AnimatePresence, motion } from "framer-motion";
import { Music2, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Card, IconBtn } from "../components/ui";
import { api } from "../lib/api";
import { useLive } from "../lib/live";
import { useUi } from "../lib/store";
import { fmtTime, useMotion } from "../lib/util";

/** Canvas visualizer fed by real loopback audio from the backend. */
function Visualizer({ playing }: { playing: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const bands = useRef<number[]>(new Array(48).fill(0));
  const visible = useUi((s) => s.visible);

  useEffect(() => {
    if (!visible || !playing) return;
    invoke("viz_start");
    const un = listen<number[]>("halo://viz", (e) => { bands.current = e.payload; });
    return () => {
      invoke("viz_stop");
      un.then((f) => f());
    };
  }, [visible, playing]);

  useEffect(() => {
    let raf = 0;
    const shown = new Array(48).fill(0);
    const draw = () => {
      const c = canvas.current;
      if (c) {
        const dpr = window.devicePixelRatio || 1;
        const w = c.clientWidth, h = c.clientHeight;
        if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
        const ctx = c.getContext("2d")!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const cs = getComputedStyle(c);
        const a1 = cs.getPropertyValue("--accent").trim() || "#7aa2ff";
        const a2 = cs.getPropertyValue("--accent-2").trim() || "#c084fc";
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, a1);
        grad.addColorStop(1, a2);
        ctx.fillStyle = grad;
        ctx.shadowColor = a1;
        ctx.shadowBlur = 12;
        const n = shown.length;
        const gap = 3;
        const bw = Math.max(2, (w - gap * (n - 1)) / n);
        for (let i = 0; i < n; i++) {
          const target = playing ? bands.current[i] ?? 0 : 0;
          shown[i] += (target - shown[i]) * 0.35;
          const bh = Math.max(2, shown[i] * h * 0.95);
          const x = i * (bw + gap);
          ctx.globalAlpha = 0.55 + shown[i] * 0.45;
          ctx.beginPath();
          ctx.roundRect(x, h - bh, bw, bh, Math.min(bw / 2, 3));
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  return <canvas ref={canvas} className="viz" />;
}

/** Smoothly ticking playback position. */
function useProgress() {
  const media = useLive((l) => l.media);
  const at = useLive((l) => l.mediaAt);
  const [, force] = useState(0);
  useEffect(() => {
    if (!media?.playing) return;
    const t = setInterval(() => force((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [media?.playing]);
  if (!media) return 0;
  const extra = media.playing ? (performance.now() - at) / 1000 : 0;
  return Math.min(media.duration || Infinity, media.position + extra);
}

export function MediaModule() {
  const media = useLive((l) => l.media);
  const pos = useProgress();
  const { spring, on } = useMotion();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const playing = optimistic ?? media?.playing ?? false;
  useEffect(() => setOptimistic(null), [media?.playing]);

  const bar = useRef<HTMLDivElement>(null);
  const seek = (e: React.MouseEvent) => {
    if (!media?.duration || !bar.current) return;
    const r = bar.current.getBoundingClientRect();
    api.media("seek", ((e.clientX - r.left) / r.width) * media.duration);
  };

  if (!media?.active) {
    return (
      <Card title="Now playing" icon={<Music2 size={15} />}>
        <div className="empty">
          <Music2 size={34} className="faint" />
          <div>Nothing playing</div>
          <div className="faint small">Play something in Spotify, YouTube or any media app</div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="media-card" pad={false}>
      <AnimatePresence>
        {media.art && (
          <motion.div key={media.art_key} className="media-bg" style={{ backgroundImage: `url(${media.art})` }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: on ? 0.8 : 0 }} />
        )}
      </AnimatePresence>
      <div className="media drag-handle">
        <div className="media-main">
          <AnimatePresence mode="popLayout">
            <motion.div key={media.art_key} className="media-art"
              initial={{ opacity: 0, scale: 0.85, rotate: -4 }} animate={{ opacity: 1, scale: playing ? 1 : 0.94, rotate: 0 }}
              exit={{ opacity: 0, scale: 0.9 }} transition={spring}>
              {media.art ? <img src={media.art} draggable={false} /> : <Music2 size={40} />}
            </motion.div>
          </AnimatePresence>
          <div className="media-info">
            <div className="media-app">{media.app}</div>
            <AnimatePresence mode="wait">
              <motion.div key={media.art_key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: on ? 0.3 : 0 }}>
                <div className="media-title" title={media.title}>{media.title || "Unknown title"}</div>
                <div className="media-artist">{media.artist}</div>
              </motion.div>
            </AnimatePresence>
            <div className="media-controls">
              <IconBtn onClick={() => api.media("prev")}><SkipBack size={18} fill="currentColor" /></IconBtn>
              <IconBtn big onClick={() => { setOptimistic(!playing); api.media("toggle"); }}>
                {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" style={{ marginLeft: 2 }} />}
              </IconBtn>
              <IconBtn onClick={() => api.media("next")}><SkipForward size={18} fill="currentColor" /></IconBtn>
            </div>
          </div>
        </div>
        <Visualizer playing={playing} />
        {media.duration > 0 && (
          <div className="media-progress">
            <span>{fmtTime(pos)}</span>
            <div className="progress" ref={bar} onClick={seek}>
              <div className="progress-fill" style={{ width: `${(pos / media.duration) * 100}%` }} />
            </div>
            <span>{fmtTime(media.duration)}</span>
          </div>
        )}
      </div>
    </Card>
  );
}
