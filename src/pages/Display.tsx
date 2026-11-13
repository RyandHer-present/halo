import { AnimatePresence, motion } from "framer-motion";
import { AppWindow, Keyboard, Monitor, MousePointer2, Sun } from "lucide-react";
import { ReactNode, useEffect, useRef, useState } from "react";
import { Card, Empty, Segmented, Slider, Switch } from "../components/ui";
import { api, DefaultApp, DisplayInfo, InputSettings, Mode } from "../lib/api";
import { toast } from "../lib/store";
import { sfx } from "../lib/util";
import { PageHeader } from "./Pages";

const Row = ({ label, sub, children }: { label: string; sub?: string; children: ReactNode }) => (
  <div className="set-row">
    <div><div className="set-label">{label}</div>{sub && <div className="faint small">{sub}</div>}</div>
    <div className="set-ctl">{children}</div>
  </div>
);

function DisplayCard({ d, reload }: { d: DisplayInfo; reload: () => void }) {
  const [revert, setRevert] = useState<{ mode: Mode; left: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const resolutions = [...new Map(d.modes.map((m) => [`${m.width}x${m.height}`, m])).values()];
  const rates = [...new Set(d.modes.filter((m) => m.width === d.current.width && m.height === d.current.height).map((m) => m.hz))].sort((a, b) => b - a);

  const setMode = async (m: Mode) => {
    const prev = d.current;
    try {
      await api.setDisplayMode(d.device, m.width, m.height, m.hz);
      reload();
      // safety net: revert automatically unless confirmed
      setRevert({ mode: prev, left: 15 });
      clearInterval(timer.current);
      timer.current = window.setInterval(() => {
        setRevert((r) => {
          if (!r) return r;
          if (r.left <= 1) {
            clearInterval(timer.current);
            api.setDisplayMode(d.device, r.mode.width, r.mode.height, r.mode.hz).then(reload);
            toast("Display change reverted");
            return null;
          }
          return { ...r, left: r.left - 1 };
        });
      }, 1000);
    } catch (e) {
      toast(`${e}`, "warn");
    }
  };
  useEffect(() => () => clearInterval(timer.current), []);

  return (
    <Card title={d.name + (d.primary ? " · main display" : "")} icon={<Monitor size={15} />}>
      <AnimatePresence>
        {revert && (
          <motion.div className="revert-bar" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <span>Keep this display setting? Reverting in <b>{revert.left}s</b></span>
            <button className="pill accent-pill" onClick={() => { clearInterval(timer.current); setRevert(null); toast("Kept"); }}>Keep</button>
            <button className="pill" onClick={() => { clearInterval(timer.current); api.setDisplayMode(d.device, revert.mode.width, revert.mode.height, revert.mode.hz).then(reload); setRevert(null); }}>Revert</button>
          </motion.div>
        )}
      </AnimatePresence>
      <Row label="Resolution" sub={`${d.current.width} × ${d.current.height}`}>
        <select className="input" style={{ width: 200 }} value={`${d.current.width}x${d.current.height}`} onChange={(e) => {
          const [w, h] = e.target.value.split("x").map(Number);
          const hz = Math.max(...d.modes.filter((m) => m.width === w && m.height === h).map((m) => m.hz));
          setMode({ width: w, height: h, hz });
        }}>
          {resolutions.map((m) => <option key={`${m.width}x${m.height}`} value={`${m.width}x${m.height}`}>{m.width} × {m.height}</option>)}
        </select>
      </Row>
      <Row label="Refresh rate" sub="Higher is smoother, lower saves battery">
        <Segmented value={String(d.current.hz)} onChange={(v) => setMode({ ...d.current, hz: +v })} options={rates.map((r) => ({ id: String(r), label: `${r} Hz` }))} />
      </Row>
      {d.scale != null && d.scales.length > 0 && (
        <Row label="Scaling" sub="Size of text and apps">
          <Segmented value={String(d.scale)} onChange={(v) => api.setScale(d.device, +v).then(() => { toast(`Scaling ${v}%`); setTimeout(reload, 800); }).catch((e) => toast(`${e}`, "warn"))}
            options={d.scales.filter((s) => s <= 250).map((s) => ({ id: String(s), label: `${s}%` }))} />
        </Row>
      )}
      <Row label="HDR" sub={d.hdr_supported ? "High dynamic range" : "This display doesn't support HDR"}>
        <Switch on={d.hdr_on} onChange={(v) => d.hdr_supported ? api.setHdr(d.device, v).then(() => setTimeout(reload, 800)).catch((e) => toast(`${e}`, "warn")) : toast("HDR isn't supported on this display", "warn")} />
      </Row>
      <Row label="Night light & more"><button className="pill" onClick={() => api.launchPath("ms-settings:nightlight")}><Sun size={13} /> Night light</button></Row>
    </Card>
  );
}

function InputCards() {
  const [s, setS] = useState<InputSettings | null>(null);
  useEffect(() => { api.input().then(setS); }, []);
  if (!s) return null;
  const put = (key: keyof InputSettings, v: number | boolean) => {
    const n = typeof v === "boolean" ? (v ? 1 : 0) : Math.round(v);
    setS({ ...s, [key]: typeof v === "boolean" ? v : n } as InputSettings);
    api.setInput(key, n).catch((e) => toast(`${e}`, "warn"));
  };
  const SliderRow = ({ k, label, sub, min, max, invert }: { k: keyof InputSettings; label: string; sub?: string; min: number; max: number; invert?: boolean }) => {
    const raw = s[k] as number;
    const v = invert ? max + min - raw : raw;
    return (
      <Row label={label} sub={sub}>
        <div style={{ width: 240 }}>
          <Slider value={v} min={min} max={max} onChange={(x) => setS({ ...s, [k]: invert ? max + min - Math.round(x) : Math.round(x) } as InputSettings)} onCommit={(x) => put(k, invert ? max + min - x : x)} />
        </div>
      </Row>
    );
  };
  return (
    <>
      <div className="span-6">
        <Card title="Mouse & touchpad" icon={<MousePointer2 size={15} />}>
          <SliderRow k="mouse_speed" label="Pointer speed" min={1} max={20} />
          <Row label="Enhance pointer precision" sub="Mouse acceleration — most gamers turn this off"><Switch on={s.precision} onChange={(v) => put("precision", v)} /></Row>
          <Row label="Swap left and right buttons"><Switch on={s.swap_buttons} onChange={(v) => put("swap_buttons", v)} /></Row>
          <SliderRow k="scroll_lines" label="Lines per scroll" min={1} max={20} />
          <SliderRow k="double_click_ms" label="Double-click speed" sub="Right = faster" min={200} max={900} invert />
          <Row label="Touchpad gestures"><button className="pill" onClick={() => api.launchPath("ms-settings:devices-touchpad")}>Touchpad settings</button></Row>
        </Card>
      </div>
      <div className="span-6">
        <Card title="Keyboard" icon={<Keyboard size={15} />}>
          <SliderRow k="key_delay" label="Repeat delay" sub="Right = shorter wait before a held key repeats" min={0} max={3} invert />
          <SliderRow k="key_speed" label="Repeat rate" sub="How fast a held key repeats" min={0} max={31} />
          <SliderRow k="caret_blink_ms" label="Cursor blink speed" sub="Right = faster" min={200} max={1200} invert />
          <div className="try-field"><input className="input no-drag" placeholder="Hold a key here to test…" onKeyDown={(e) => e.stopPropagation()} /></div>
          <Row label="Language & layout"><button className="pill" onClick={() => api.launchPath("ms-settings:keyboard")}>Typing settings</button></Row>
        </Card>
      </div>
    </>
  );
}

function DefaultApps() {
  const [list, setList] = useState<DefaultApp[] | null>(null);
  useEffect(() => { api.defaultApps().then(setList); }, []);
  return (
    <Card title="Default apps" icon={<AppWindow size={15} />} actions={<button className="pill" onClick={() => api.launchPath("ms-settings:defaultapps")}>All defaults</button>}>
      {!list ? <Empty>Loading…</Empty> : (
        <div className="defaults">
          {list.map((d) => (
            <div key={d.kind} className="default-row">
              <div className="col-flex"><span className="faint small">{d.label}</span><b className="ellipsis">{d.app}</b></div>
              <button className="pill small-pill" onClick={() => { sfx("click"); api.changeDefaultApp(d.kind).catch((e) => toast(`${e}`, "warn")); }}>Change</button>
            </div>
          ))}
        </div>
      )}
      <div className="faint small" style={{ marginTop: 10 }}>Windows only lets you pick defaults yourself, so “Change” opens its picker — choose an app and tick “Always”.</div>
    </Card>
  );
}

export function DisplayPage() {
  const [ds, setDs] = useState<DisplayInfo[] | null>(null);
  const reload = () => api.displays().then(setDs);
  useEffect(() => { reload(); }, []);
  return (
    <div className="page">
      <PageHeader title="Display & input" sub="Screen, mouse, keyboard and default apps" />
      <div className="page-grid">
        {(ds ?? []).map((d) => <div key={d.device} className="span-6"><DisplayCard d={d} reload={reload} /></div>)}
        <div className="span-6"><DefaultApps /></div>
        <InputCards />
      </div>
    </div>
  );
}
