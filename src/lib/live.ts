// One shared poller for system stats + media, so modules don't each hit the backend.
import { create } from "zustand";
import { useEffect } from "react";
import { api, NowPlaying, Stats } from "./api";
import { useUi } from "./store";

const N = 60;
const push = (arr: number[], v: number) => (arr.length >= N ? [...arr.slice(1), v] : [...arr, v]);

interface Live {
  stats: Stats | null;
  hist: { cpu: number[]; gpu: number[]; ram: number[]; down: number[]; up: number[]; cpuTemp: number[]; gpuTemp: number[] };
  media: NowPlaying | null;
  mediaAt: number; // performance.now() when media was fetched (for smooth progress)
}

export const useLive = create<Live>(() => ({
  stats: null,
  hist: { cpu: [], gpu: [], ram: [], down: [], up: [], cpuTemp: [], gpuTemp: [] },
  media: null,
  mediaAt: 0,
}));

export function useLivePollers() {
  const visible = useUi((s) => s.visible);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let t1: number, t2: number;
    const statTick = async () => {
      try {
        const s = await api.stats();
        if (!alive) return;
        const h = useLive.getState().hist;
        useLive.setState({
          stats: s,
          hist: {
            cpu: push(h.cpu, s.cpu),
            gpu: push(h.gpu, s.gpu?.load ?? 0),
            ram: push(h.ram, (s.ram_used / Math.max(1, s.ram_total)) * 100),
            down: push(h.down, s.net_down),
            up: push(h.up, s.net_up),
            cpuTemp: push(h.cpuTemp, s.cpu_temp ?? 0),
            gpuTemp: push(h.gpuTemp, s.gpu?.temp ?? 0),
          },
        });
      } catch (e) {
        console.warn("stats", e);
      }
      if (alive) t1 = window.setTimeout(statTick, 1000);
    };
    const mediaTick = async () => {
      try {
        const m = await api.nowPlaying();
        if (alive) useLive.setState({ media: m, mediaAt: performance.now() });
      } catch (e) {
        console.warn("media", e);
      }
      if (alive) t2 = window.setTimeout(mediaTick, 1500);
    };
    statTick();
    mediaTick();
    return () => {
      alive = false;
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [visible]);
}
