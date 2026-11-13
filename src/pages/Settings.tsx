import { motion } from "framer-motion";
import { Check, Keyboard, Paintbrush, Power, Rocket, ShieldCheck, ShieldAlert, Sparkles, Type, Volume2 } from "lucide-react";
import { ReactNode, useEffect, useState } from "react";
import { Card, Segmented, Slider, Switch } from "../components/ui";
import { api } from "../lib/api";
import { AccentSource, DEFAULT_LAYOUT, Motion, toast, useSettings } from "../lib/store";
import { FONTS, THEMES, THEME_GROUPS, Theme } from "../lib/themes";
import { sfx } from "../lib/util";
import { PageHeader } from "./Pages";

const Row = ({ label, sub, children }: { label: string; sub?: string; children: ReactNode }) => (
  <div className="set-row">
    <div>
      <div className="set-label">{label}</div>
      {sub && <div className="faint small">{sub}</div>}
    </div>
    <div className="set-ctl">{children}</div>
  </div>
);

function ThemeCard({ t, on, onPick }: { t: Theme; on: boolean; onPick: () => void }) {
  const v = t.vars;
  return (
    <motion.button className={`theme-card ${on ? "on" : ""}`} whileHover={{ y: -3 }} whileTap={{ scale: 0.97 }} onClick={onPick}>
      <div className="theme-prev" style={{ background: `linear-gradient(135deg, ${t.accent}55, transparent 60%), ${v["--tint"]}` }}>
        <div className="theme-prev-card" style={{ background: v["--panel"], borderColor: v["--panel-border"], borderRadius: `calc(${v["--radius"]} / 2.5)` }}>
          <i style={{ background: t.accent }} />
          <span style={{ background: v["--text"] }} />
          <span style={{ background: v["--text-faint"], width: "40%" }} />
        </div>
        <div className="theme-prev-card small" style={{ background: v["--panel"], borderColor: v["--panel-border"], borderRadius: `calc(${v["--radius"]} / 2.5)` }}>
          <i style={{ background: t.accent, borderRadius: 99 }} />
        </div>
      </div>
      <div className="theme-name">
        {t.name}
        {on && <Check size={13} />}
      </div>
    </motion.button>
  );
}

const SWATCHES = ["#7aa2ff", "#9b8cff", "#c084fc", "#ff7eb6", "#ff6b6b", "#ff9f43", "#ffd23f", "#9be37a", "#2ee6a6", "#00e5ff", "#4cc9ff", "#e8e8e8"];

export function SettingsPage() {
  const s = useSettings();
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  useEffect(() => {
    api.isAdmin().then(setAdmin);
    api.getAutostart().then(setAutostart);
  }, []);

  return (
    <div className="page settings">
      <PageHeader title="Settings" sub="Make Halo yours" />

      <Card title="Theme" icon={<Paintbrush size={15} />}>
        {THEME_GROUPS.map((g) => (
          <div key={g} className="theme-group">
            <div className="theme-group-name">{g}</div>
            <div className="theme-grid">
              {THEMES.filter((t) => t.group === g).map((t) => (
                <ThemeCard key={t.id} t={t} on={s.theme === t.id} onPick={() => { sfx("toggle"); s.set({ theme: t.id }); }} />
              ))}
            </div>
          </div>
        ))}
      </Card>

      <Card title="Color & feel" icon={<Sparkles size={15} />}>
        <Row label="Accent color" sub="Where Halo gets its highlight color">
          <Segmented<AccentSource> value={s.accentSource} onChange={(v) => s.set({ accentSource: v })}
            options={[{ id: "theme", label: "Theme" }, { id: "windows", label: "Windows" }, { id: "wallpaper", label: "Wallpaper" }, { id: "album", label: "Album art" }, { id: "custom", label: "Custom" }]} />
        </Row>
        {s.accentSource === "custom" && (
          <Row label="Custom color">
            <div className="swatches">
              {SWATCHES.map((c) => (
                <button key={c} className={`swatch ${s.customAccent === c ? "on" : ""}`} style={{ background: c }} onClick={() => { sfx("click"); s.set({ customAccent: c }); }} />
              ))}
              <label className="swatch picker-swatch" style={{ background: s.customAccent }}>
                <input type="color" value={s.customAccent} onChange={(e) => s.set({ customAccent: e.target.value })} />
              </label>
            </div>
          </Row>
        )}
        <Row label="Animation" sub="How much movement Halo uses">
          <Segmented<Motion> value={s.motion} onChange={(v) => s.set({ motion: v })} options={[{ id: "lots", label: "Lots" }, { id: "subtle", label: "Subtle" }, { id: "off", label: "Off" }]} />
        </Row>
        <Row label="Background dim" sub="How dark the blurred desktop gets behind Halo">
          <div style={{ width: 220 }}><Slider value={s.dim} onChange={(v) => s.set({ dim: v })} /></div>
        </Row>
      </Card>

      <Card title="Font" icon={<Type size={15} />}>
        <div className="font-grid">
          {FONTS.map((f) => (
            <button key={f.id} className={`font-card ${s.font === f.id ? "on" : ""}`} style={{ fontFamily: f.stack }} onClick={() => { sfx("click"); s.set({ font: f.id }); }}>
              <span className="font-sample">Aa 12:45</span>
              <span className="font-name">{f.name}</span>
            </button>
          ))}
        </div>
      </Card>

      <Card title="Sound & units" icon={<Volume2 size={15} />}>
        <Row label="UI sounds" sub="Soft clicks and whooshes"><Switch on={s.sounds} onChange={(v) => s.set({ sounds: v })} /></Row>
        {s.sounds && <Row label="Sound volume"><div style={{ width: 220 }}><Slider value={s.soundVolume} onChange={(v) => s.set({ soundVolume: v })} onCommit={() => sfx("toggle")} /></div></Row>}
        <Row label="Temperature"><Segmented value={s.fahrenheit ? "f" : "c"} onChange={(v) => s.set({ fahrenheit: v === "f" })} options={[{ id: "f", label: "°F" }, { id: "c", label: "°C" }]} /></Row>
        <Row label="Clock"><Segmented value={s.clock24h ? "24" : "12"} onChange={(v) => s.set({ clock24h: v === "24" })} options={[{ id: "12", label: "12-hour" }, { id: "24", label: "24-hour" }]} /></Row>
      </Card>

      <Card title="Startup & system" icon={<Rocket size={15} />}>
        <Row label="Start with Windows" sub="Runs as admin at sign-in through Task Scheduler — no UAC popup each time">
          <Switch on={!!autostart} onChange={async (v) => {
            try {
              await api.setAutostart(v);
              const now = await api.getAutostart();
              setAutostart(now);
              toast(now ? "Halo will start with Windows" : "Halo won't start with Windows");
            } catch (e) {
              toast(`${e}`, "warn");
            }
          }} />
        </Row>
        <Row label="Admin mode" sub={admin ? "Running as admin — temps, services and system tools fully available" : "Not elevated right now — some readings (CPU temp) may be missing"}>
          {admin ? <ShieldCheck className="accent" size={20} /> : <ShieldAlert className="warn" size={20} />}
        </Row>
        <Row label="Open / close Halo" sub="Works from anywhere, even over games"><span className="kbd"><Keyboard size={13} /> Win + Shift + D</span></Row>
        <Row label="Push to talk" sub="Hold to speak to the assistant"><span className="kbd"><Keyboard size={13} /> Ctrl + Shift + Space</span></Row>
        <Row label="FPS overlay" sub="Show or hide the in-game counter"><span className="kbd"><Keyboard size={13} /> Win + Shift + F</span></Row>
        <Row label="Home layout"><button className="pill" onClick={() => { s.set({ layout: DEFAULT_LAYOUT }); toast("Layout reset"); }}>Reset to default</button></Row>
        <Row label="Quit Halo" sub="Fully closes Halo (the hotkey stops working until it starts again)">
          <button className="pill danger" onClick={() => api.quit()}><Power size={14} /> Quit</button>
        </Row>
      </Card>
      <div className="faint small center" style={{ margin: "20px 0 40px" }}>Halo 0.2</div>
    </div>
  );
}
