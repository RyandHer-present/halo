import { motion } from "framer-motion";
import { ArrowUpCircle, Check, Cpu, Download, PackagePlus, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Card, Empty, IconBtn } from "../components/ui";
import { api, AppUpdate, HaloUpdate, WinUpdate } from "../lib/api";
import { toast } from "../lib/store";
import { sfx } from "../lib/util";
import { PageHeader } from "./Pages";

function AppUpdates() {
  const [list, setList] = useState<AppUpdate[] | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const load = () => { setList(null); api.wingetUpdates().then(setList).catch((e) => { toast(`winget: ${e}`, "warn"); setList([]); }); };
  useEffect(load, []);
  const up = async (id: string) => {
    sfx("click");
    setBusy((b) => new Set(b).add(id));
    try {
      const r = await api.wingetUpgrade(id);
      if (id === "--all") { toast("Updated everything"); load(); }
      else { setDone((d) => new Set(d).add(id)); toast(r || "Updated"); }
    } catch (e) {
      toast(`${e}`, "warn");
    }
    setBusy((b) => { const n = new Set(b); n.delete(id); return n; });
  };
  return (
    <Card title={list ? `${list.length} app update${list.length === 1 ? "" : "s"}` : "App updates"} icon={<ArrowUpCircle size={15} />} actions={<>
      {list && list.length > 1 && <button className="pill accent-pill" disabled={busy.has("--all")} onClick={() => up("--all")}>{busy.has("--all") ? <RefreshCw size={13} className="spin" /> : <Download size={13} />} Update all</button>}
      <IconBtn title="Check again" onClick={load}><RefreshCw size={14} /></IconBtn>
    </>}>
      {!list ? <div className="scan-wait"><div className="scan-orb" /><b>Asking winget…</b></div> : list.length === 0 ? <Empty><ShieldCheck size={26} className="accent" /> Everything is up to date</Empty> : (
        <div className="log-list tall">
          {list.map((a) => (
            <motion.div key={a.id} layout className="log-row">
              <div className="log-text"><b className="ellipsis">{a.name}</b><span className="faint small">{a.version} → <span className="accent">{a.available}</span> · {a.id}</span></div>
              {done.has(a.id) ? <span className="state-chip on"><Check size={12} /> Updated</span> : (
                <button className="pill small-pill" disabled={busy.has(a.id) || busy.has("--all")} onClick={() => up(a.id)}>{busy.has(a.id) ? <RefreshCw size={12} className="spin" /> : <Download size={12} />} Update</button>
              )}
            </motion.div>
          ))}
        </div>
      )}
    </Card>
  );
}

function WindowsUpdates() {
  const [list, setList] = useState<WinUpdate[] | null | "idle">("idle");
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const load = () => { setList(null); api.windowsUpdates().then((l) => { setList(l); setPick(new Set(l.filter((u) => u.kind === "driver").map((u) => u.id))); }).catch((e) => { toast(`${e}`, "warn"); setList([]); }); };
  return (
    <Card title="Drivers & Windows updates" icon={<Cpu size={15} />} actions={<IconBtn title="Check" onClick={load}><RefreshCw size={14} /></IconBtn>}>
      {list === "idle" ? (
        <Empty><button className="pill accent-pill" onClick={load}><Search size={14} /> Check Windows Update</button><span className="faint small">Takes up to a minute</span></Empty>
      ) : list == null ? <div className="scan-wait"><div className="scan-orb" /><b>Checking Windows Update…</b></div> : list.length === 0 ? <Empty><ShieldCheck size={26} className="accent" /> No driver or Windows updates waiting</Empty> : (
        <>
          <div className="clean-list">
            {list.map((u) => (
              <button key={u.id} className={`clean-row ${pick.has(u.id) ? "on" : ""}`} onClick={() => { const s = new Set(pick); s.has(u.id) ? s.delete(u.id) : s.add(u.id); setPick(s); }}>
                <span className="check">{pick.has(u.id) && <Check size={13} />}</span>
                <div className="col-flex grow"><b>{u.title}</b><span className="faint small">{u.kind === "driver" ? "Driver" : "Windows update"}</span></div>
              </button>
            ))}
          </div>
          <div className="btn-row">
            <button className="pill accent-pill" disabled={busy || !pick.size} onClick={async () => {
              setBusy(true);
              toast("Downloading and installing — this can take a while");
              try { toast(await api.installWindowsUpdates([...pick])); load(); } catch (e) { toast(`${e}`, "warn"); }
              setBusy(false);
            }}>{busy ? <RefreshCw size={13} className="spin" /> : <Download size={13} />} {busy ? "Installing…" : `Install ${pick.size} selected`}</button>
            <button className="pill" onClick={() => api.launchPath("ms-settings:windowsupdate")}>Open Windows Update</button>
          </div>
        </>
      )}
    </Card>
  );
}

function InstallApps() {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<AppUpdate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const search = () => { if (!q.trim()) return; setRes(null); api.wingetSearch(q).then(setRes).catch(() => setRes([])); };
  return (
    <Card title="Install apps" icon={<PackagePlus size={15} />}>
      <form className="search-field" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <Search size={15} /><input className="no-drag" placeholder="Search winget (e.g. discord, obs, vlc)…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </form>
      <div className="log-list tall" style={{ marginTop: 10 }}>
        {res == null && q && <div className="scan-wait"><div className="scan-orb" /></div>}
        {res?.length === 0 && <Empty>No results</Empty>}
        {res?.slice(0, 30).map((a) => (
          <div key={a.id} className="log-row">
            <div className="log-text"><b className="ellipsis">{a.name}</b><span className="faint small">{a.id} · {a.version}</span></div>
            <button className="pill small-pill" disabled={busy === a.id} onClick={async () => {
              setBusy(a.id);
              try { toast(await api.wingetInstall(a.id)); } catch (e) { toast(`${e}`, "warn"); }
              setBusy(null);
            }}>{busy === a.id ? <RefreshCw size={12} className="spin" /> : <Download size={12} />} Install</button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function HaloCard() {
  const [u, setU] = useState<HaloUpdate | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.checkHaloUpdate().then(setU).catch(() => setU(null)); }, []);
  return (
    <Card title="Halo" icon={<RefreshCw size={15} />}>
      <div className="halo-ver">
        <div className="big-num sm">v{u?.current ?? "…"}</div>
        {u?.latest ? (
          <>
            <div>Version <b className="accent">{u.latest}</b> is available</div>
            {u.notes && <div className="faint small notes">{u.notes.slice(0, 400)}</div>}
            <button className="pill accent-pill" disabled={busy || !u.url} onClick={() => { setBusy(true); api.installHaloUpdate(u.url!).catch((e) => { toast(`${e}`, "warn"); setBusy(false); }); }}>
              {busy ? <RefreshCw size={13} className="spin" /> : <Download size={13} />} {busy ? "Updating…" : "Update & restart"}
            </button>
          </>
        ) : <div className="faint small">{u ? "You're on the latest version" : "Checking…"}</div>}
      </div>
    </Card>
  );
}

export function UpdatesPage() {
  return (
    <div className="page">
      <PageHeader title="Updates" sub="Keep apps, drivers and Halo itself up to date" />
      <div className="page-grid">
        <div className="span-6 col"><AppUpdates /><HaloCard /></div>
        <div className="span-6 col"><WindowsUpdates /><InstallApps /></div>
      </div>
    </div>
  );
}
