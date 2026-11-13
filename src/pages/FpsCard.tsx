import { Activity, Keyboard, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Card, Switch } from "../components/ui";
import { api } from "../lib/api";
import { toast } from "../lib/store";

export function FpsCard() {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dl, setDl] = useState<number | null>(null);
  useEffect(() => {
    api.fpsRunning().then(setOn);
    const un = listen<{ tag: string; got: number; total: number }>("halo://download", (e) => {
      if (e.payload.tag === "presentmon") setDl(e.payload.total ? e.payload.got / e.payload.total : null);
    });
    return () => { un.then((f) => f()); };
  }, []);
  return (
    <Card title="FPS overlay" icon={<Activity size={15} />}>
      <div className="set-row">
        <div>
          <div className="set-label">Show FPS in games</div>
          <div className="faint small">FPS, frame time, CPU/GPU load and temps, RAM and VRAM in the top-left corner. Works in borderless/windowed games.</div>
        </div>
        <Switch on={on} onChange={async () => {
          setBusy(true);
          try { setOn(await api.fpsToggle()); } catch (e) { toast(`${e}`, "warn"); }
          setBusy(false);
          setDl(null);
        }} />
      </div>
      {busy && <div className="faint small"><RefreshCw size={12} className="spin" /> {dl != null ? `Downloading PresentMon (one time)… ${Math.round(dl * 100)}%` : "Starting…"}</div>}
      <div className="set-row">
        <div className="set-label">Toggle from anywhere</div>
        <span className="kbd"><Keyboard size={13} /> Win + Shift + F</span>
      </div>
    </Card>
  );
}
