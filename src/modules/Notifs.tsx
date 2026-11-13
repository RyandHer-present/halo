import { AnimatePresence, motion } from "framer-motion";
import { Bell, BellOff, CheckCheck, X } from "lucide-react";
import { Card, Empty, IconBtn } from "../components/ui";
import { api } from "../lib/api";
import { useSettings } from "../lib/store";
import { sfx, usePoll } from "../lib/util";

const ago = (t: number) => {
  const s = Date.now() / 1000 - t;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const hue = (s: string) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;

export function NotifsModule() {
  const list = usePoll(api.notifications, 5000);
  const hidden = useSettings((s) => s.hiddenNotifs);
  const clearedAt = useSettings((s) => s.notifsClearedAt);
  const set = useSettings((s) => s.set);
  const shown = (list ?? []).filter((n) => !hidden.includes(n.id) && n.time > clearedAt);
  return (
    <Card title="Notifications" icon={<Bell size={15} />} actions={shown.length > 0 && (
      <IconBtn title="Clear all" onClick={() => { sfx("close"); set({ notifsClearedAt: Math.floor(Date.now() / 1000), hiddenNotifs: [] }); }}><CheckCheck size={15} /></IconBtn>
    )}>
      <div className="notifs">
        {list == null && <Empty>Loading…</Empty>}
        {list && shown.length === 0 && <Empty><BellOff size={22} /> You're all caught up</Empty>}
        <AnimatePresence initial={false}>
          {shown.slice(0, 40).map((n) => (
            <motion.div key={n.id} layout className="notif" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40, height: 0, marginBottom: 0, padding: 0 }}
              onClick={() => { sfx("launch"); api.openAumid(n.aumid).catch(() => {}); }}>
              <div className="notif-app" style={{ background: `hsl(${hue(n.app)} 70% 60% / 0.25)`, color: `hsl(${hue(n.app)} 80% 75%)` }}>{n.app.slice(0, 1)}</div>
              <div className="notif-body">
                <div className="row-between"><span className="notif-src">{n.app}</span><span className="faint small notif-time">{ago(n.time)}</span></div>
                <b className="notif-title">{n.title}</b>
                {n.body && <div className="notif-text">{n.body}</div>}
              </div>
              <button className="notif-x" onClick={(e) => { e.stopPropagation(); set({ hiddenNotifs: [...hidden, n.id].slice(-300) }); }}><X size={12} /></button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Card>
  );
}
