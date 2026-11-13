import { motion } from "framer-motion";
import { Bluetooth, BluetoothOff, ChevronDown, Headphones, Lock, Moon, Power, RotateCcw, Settings2, Speaker, Volume1, Volume2, VolumeX, Wifi, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Card, Slider, Tile } from "../components/ui";
import { api, AudioState, Radios } from "../lib/api";
import { toast, useUi } from "../lib/store";
import { sfx, usePoll } from "../lib/util";

export function useAudio() {
  const [audio, setAudio] = useState<AudioState | null>(null);
  const dragging = useRef(false);
  const polled = usePoll(api.audio, 1500);
  useEffect(() => {
    if (polled && !dragging.current) setAudio(polled);
  }, [polled]);
  const setVol = (v: number) => {
    dragging.current = true;
    setAudio((a) => (a ? { ...a, volume: v, muted: false } : a));
    api.setVolume(v);
  };
  const commit = (v: number) => {
    dragging.current = false;
    api.setVolume(v);
    if (audio?.muted) api.setMute(false);
  };
  return { audio, setAudio, setVol, commit };
}

const deviceIcon = (name: string) => (/head|ear|bud|arctis|hyperx|airpod|bluetooth/i.test(name) ? Headphones : Speaker);

export function DevicePicker({ audio, onPick }: { audio: AudioState; onPick: () => void }) {
  const [open, setOpen] = useState(false);
  const def = audio.devices.find((d) => d.default);
  const Icon = deviceIcon(def?.name ?? "");
  return (
    <div className="picker">
      <button className="picker-btn" onClick={() => { sfx("click"); setOpen(!open); }}>
        <Icon size={15} />
        <span className="ellipsis">{def?.name ?? "No output"}</span>
        <ChevronDown size={14} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
      </button>
      {open && (
        <motion.div className="picker-menu" initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}>
          {audio.devices.map((d) => {
            const I = deviceIcon(d.name);
            return (
              <button key={d.id} className={`picker-item ${d.default ? "on" : ""}`}
                onClick={async () => {
                  sfx("click");
                  setOpen(false);
                  try {
                    await api.setAudioDevice(d.id);
                    toast(`Output: ${d.name}`);
                  } catch (e) {
                    toast(`Couldn't switch: ${e}`, "warn");
                  }
                  onPick();
                }}>
                <I size={15} />
                <span className="ellipsis">{d.name}</span>
              </button>
            );
          })}
        </motion.div>
      )}
    </div>
  );
}

/** Press-and-hold button so shutdown/restart can't happen by accident. */
function HoldButton({ icon, label, action }: { icon: React.ReactNode; label: string; action: () => void }) {
  const [p, setP] = useState(0);
  const timer = useRef<number>(0);
  const start = () => {
    sfx("click");
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 900);
      setP(k);
      if (k >= 1) {
        sfx("close");
        action();
        setP(0);
        return;
      }
      timer.current = requestAnimationFrame(step);
    };
    timer.current = requestAnimationFrame(step);
  };
  const cancel = () => {
    cancelAnimationFrame(timer.current);
    setP(0);
  };
  return (
    <button className="power-btn hold" title={`Hold to ${label.toLowerCase()}`} onPointerDown={start} onPointerUp={cancel} onPointerLeave={cancel}>
      <svg viewBox="0 0 36 36" className="hold-ring">
        <circle cx="18" cy="18" r="16" strokeDasharray={`${p * 100.5} 100.5`} />
      </svg>
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function PowerRow() {
  return (
    <div className="power-row">
      <button className="power-btn" onClick={() => { sfx("click"); api.power("lock"); }}><Lock size={16} /><span>Lock</span></button>
      <button className="power-btn" onClick={() => { sfx("click"); api.hide(); setTimeout(() => api.power("sleep"), 400); }}><Moon size={16} /><span>Sleep</span></button>
      <HoldButton icon={<RotateCcw size={16} />} label="Restart" action={() => api.power("restart")} />
      <HoldButton icon={<Power size={16} />} label="Shut down" action={() => api.power("shutdown")} />
    </div>
  );
}

export function QuickModule() {
  const { audio, setAudio, setVol, commit } = useAudio();
  const [radios, setRadios] = useState<Radios | null>(null);
  const setPage = useUi((s) => s.setUi);
  const visible = useUi((s) => s.visible);
  useEffect(() => {
    if (visible) api.radios().then(setRadios).catch(() => setRadios({ wifi: null, bluetooth: null }));
  }, [visible]);

  const flip = async (kind: "wifi" | "bluetooth") => {
    const cur = radios?.[kind];
    if (cur == null) return;
    setRadios((r) => (r ? { ...r, [kind]: !cur } : r));
    try {
      await api.setRadio(kind, !cur);
    } catch (e) {
      toast(`Couldn't change ${kind === "wifi" ? "Wi-Fi" : "Bluetooth"}: ${e}`, "warn");
      setRadios((r) => (r ? { ...r, [kind]: cur } : r));
    }
  };

  const VolIcon = !audio || audio.muted || audio.volume === 0 ? VolumeX : audio.volume < 0.5 ? Volume1 : Volume2;
  return (
    <Card title="Quick controls" icon={<Settings2 size={15} />}>
      <div className="quick">
        <div className="vol-row">
          <button className="mute-btn" onClick={() => {
            if (!audio) return;
            sfx("toggle");
            setAudio({ ...audio, muted: !audio.muted });
            api.setMute(!audio.muted);
          }}>
            <VolIcon size={18} />
          </button>
          <Slider value={audio?.muted ? 0 : audio?.volume ?? 0} onChange={setVol} onCommit={commit} />
        </div>
        {audio && <DevicePicker audio={audio} onPick={() => api.audio().then(setAudio)} />}
        <div className="tiles">
          <Tile on={!!radios?.wifi} disabled={radios?.wifi == null} icon={radios?.wifi ? <Wifi size={18} /> : <WifiOff size={18} />}
            label="Wi-Fi" sub={radios?.wifi == null ? "Unavailable" : radios.wifi ? "On" : "Off"} onClick={() => flip("wifi")} />
          <Tile on={!!radios?.bluetooth} disabled={radios?.bluetooth == null} icon={radios?.bluetooth ? <Bluetooth size={18} /> : <BluetoothOff size={18} />}
            label="Bluetooth" sub={radios?.bluetooth == null ? "Unavailable" : radios.bluetooth ? "On" : "Off"} onClick={() => flip("bluetooth")} />
        </div>
        <button className="link-btn" onClick={() => { sfx("click"); setPage({ page: "network" }); }}>Wi-Fi networks & audio mixer →</button>
      </div>
    </Card>
  );
}
