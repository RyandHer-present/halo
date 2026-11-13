import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Check, Copy, Download, File, FileSearch, Folder, FolderOpen, HardDrive, Package, RefreshCw, Sparkles, Trash2, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppIcon, Card, Empty, IconBtn, Segmented, Switch } from "../components/ui";
import { api, CleanCat, FileInfo, FsEntry, Moved } from "../lib/api";
import { useLive } from "../lib/live";
import { toast, useSettings } from "../lib/store";
import { fmtBytes, sfx } from "../lib/util";
import { PageHeader } from "./Pages";

type Tab = "space" | "cleanup" | "downloads" | "dupes" | "folders";

export function FilesPage() {
  const [tab, setTab] = useState<Tab>("space");
  return (
    <div className="page">
      <PageHeader title="Files" sub="See what's taking space, clean up, and keep Downloads tidy" />
      <div className="toolbar">
        <Segmented value={tab} onChange={setTab} options={[{ id: "space", label: "Space" }, { id: "cleanup", label: "Cleanup" }, { id: "downloads", label: "Downloads" }, { id: "dupes", label: "Big & duplicate files" }, { id: "folders", label: "Folders & recent" }]} />
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
          {tab === "space" && <Space />}
          {tab === "cleanup" && <Cleanup />}
          {tab === "downloads" && <Downloads />}
          {tab === "dupes" && <Dupes />}
          {tab === "folders" && <Folders />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ---------------- treemap (squarified) ----------------
interface Rect { x: number; y: number; w: number; h: number; e: FsEntry }
function squarify(items: FsEntry[], x: number, y: number, w: number, h: number): Rect[] {
  const total = items.reduce((a, b) => a + b.size, 0);
  if (!total || !items.length) return [];
  const scale = (w * h) / total;
  const out: Rect[] = [];
  let rest = items.map((e) => ({ e, a: e.size * scale }));
  while (rest.length) {
    const short = Math.min(w, h);
    let row: typeof rest = [];
    let worst = Infinity;
    for (const it of rest) {
      const next = [...row, it];
      const s = next.reduce((a, b) => a + b.a, 0);
      const mx = Math.max(...next.map((n) => n.a)), mn = Math.min(...next.map((n) => n.a));
      const wst = Math.max((short * short * mx) / (s * s), (s * s) / (short * short * mn));
      if (wst > worst) break;
      worst = wst;
      row = next;
    }
    const s = row.reduce((a, b) => a + b.a, 0);
    if (w >= h) {
      const cw = s / h;
      let cy = y;
      for (const r of row) { const ch = r.a / cw; out.push({ x, y: cy, w: cw, h: ch, e: r.e }); cy += ch; }
      x += cw; w -= cw;
    } else {
      const ch = s / w;
      let cx = x;
      for (const r of row) { const cw = r.a / ch; out.push({ x: cx, y, w: cw, h: ch, e: r.e }); cx += cw; }
      y += ch; h -= ch;
    }
    rest = rest.slice(row.length);
  }
  return out;
}

function Space() {
  const disks = useLive((l) => l.stats?.disks ?? []);
  const [path, setPath] = useState<string>("C:\\");
  const [items, setItems] = useState<FsEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState<FsEntry | null>(null);
  const load = (p: string, fresh = false) => {
    setBusy(true);
    setItems(null);
    api.scanFolder(p, fresh).then(setItems).catch((e) => { toast(`${e}`, "warn"); setItems([]); }).finally(() => setBusy(false));
  };
  useEffect(() => { load(path); }, [path]);
  const total = (items ?? []).reduce((a, b) => a + b.size, 0);
  const W = 1000, H = 520;
  const big = (items ?? []).filter((e) => e.size > total * 0.004).slice(0, 80);
  const rects = useMemo(() => squarify(big, 0, 0, W, H), [items]);
  const parts = path.replace(/\\$/, "").split("\\");
  const up = parts.length > 1 ? parts.slice(0, -1).join("\\") + (parts.length === 2 ? "\\" : "") : null;
  return (
    <div className="page-grid">
      <div className="span-12">
        <Card title={path} icon={<HardDrive size={15} />} actions={<>
          {disks.map((d) => <button key={d.mount} className={`pill ${path.startsWith(d.mount) ? "accent-pill" : ""}`} onClick={() => setPath(d.mount)}>{d.mount.replace(/\\$/, "")}</button>)}
          {up && <IconBtn title="Up" onClick={() => setPath(up)}><ArrowLeft size={15} /></IconBtn>}
          <IconBtn title="Rescan" onClick={() => load(path, true)}><RefreshCw size={14} className={busy ? "spin" : ""} /></IconBtn>
          <IconBtn title="Open in Explorer" onClick={() => api.launchPath(path)}><FolderOpen size={14} /></IconBtn>
        </>}>
          {busy ? (
            <div className="scan-wait">
              <div className="scan-orb" />
              <b>Measuring {path}…</b>
              <span className="faint small">The first scan of a whole drive can take a minute. Folders inside are instant after that.</span>
              <button className="pill" onClick={() => api.cancelScan()}>Stop</button>
            </div>
          ) : (
            <div className="space-wrap">
              <svg className="treemap" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
                {rects.map((r, i) => {
                  const hue = (i * 47) % 360;
                  return (
                    <g key={r.e.path} className="tm-cell" onMouseEnter={() => setHover(r.e)} onMouseLeave={() => setHover(null)} onClick={() => r.e.dir && (sfx("click"), setPath(r.e.path))}>
                      <rect x={r.x + 1.5} y={r.y + 1.5} width={Math.max(0, r.w - 3)} height={Math.max(0, r.h - 3)} rx={8}
                        style={{ fill: r.e.dir ? `hsla(${hue}, 70%, 60%, 0.28)` : "rgba(255,255,255,0.08)", stroke: `hsla(${hue}, 80%, 70%, 0.5)` }} />
                      {r.w > 70 && r.h > 34 && (
                        <text x={r.x + 10} y={r.y + 22} className="tm-label">
                          {r.e.name.length > r.w / 8 ? r.e.name.slice(0, Math.floor(r.w / 8)) + "…" : r.e.name}
                          <tspan x={r.x + 10} dy="17" className="tm-size">{fmtBytes(r.e.size)}</tspan>
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
              <div className="space-list">
                <div className="space-total"><b>{fmtBytes(total)}</b> <span className="faint small">in {items?.length ?? 0} items{hover ? ` · ${hover.name}: ${fmtBytes(hover.size)}` : ""}</span></div>
                {(items ?? []).slice(0, 40).map((e) => (
                  <div key={e.path} className="space-row" onClick={() => e.dir && setPath(e.path)}>
                    {e.dir ? <Folder size={15} className="accent" /> : <File size={15} className="faint" />}
                    <div className="col-flex grow">
                      <div className="row-between"><span className="ellipsis">{e.name}</span><b className="small">{fmtBytes(e.size)}</b></div>
                      <div className="bar" style={{ height: 4 }}><div className="bar-fill" style={{ width: `${(e.size / Math.max(1, items![0].size)) * 100}%`, background: "var(--accent)" }} /></div>
                    </div>
                    <button className="row-del" title="Move to Recycle Bin" onClick={(ev) => {
                      ev.stopPropagation();
                      api.trash([e.path]).then(() => { toast(`${e.name} moved to the Recycle Bin`); setItems((xs) => xs!.filter((x) => x.path !== e.path)); }).catch((er) => toast(`${er}`, "warn"));
                    }}><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------- cleanup ----------------
function Cleanup() {
  const [cats, setCats] = useState<CleanCat[] | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set(["temp", "wintemp", "thumbs", "dumps", "updates", "delivery"]));
  const [busy, setBusy] = useState(false);
  const scan = () => { setCats(null); api.cleanupScan().then(setCats); };
  useEffect(scan, []);
  const total = (cats ?? []).filter((c) => pick.has(c.id)).reduce((a, b) => a + b.size, 0);
  return (
    <Card title="Junk files" icon={<Sparkles size={15} />} actions={<IconBtn title="Rescan" onClick={scan}><RefreshCw size={14} /></IconBtn>}>
      {!cats ? <div className="scan-wait"><div className="scan-orb" /><b>Looking for junk…</b></div> : (
        <>
          <div className="clean-list">
            {cats.map((c) => (
              <button key={c.id} className={`clean-row ${pick.has(c.id) ? "on" : ""}`} onClick={() => { sfx("toggle"); const s = new Set(pick); s.has(c.id) ? s.delete(c.id) : s.add(c.id); setPick(s); }}>
                <span className="check">{pick.has(c.id) && <Check size={13} />}</span>
                <div className="col-flex grow"><b>{c.name}</b><span className="faint small">{c.desc}</span></div>
                <b className={c.size > 1e9 ? "warn" : ""}>{fmtBytes(c.size)}</b>
              </button>
            ))}
          </div>
          <div className="clean-foot">
            <div><div className="big-num sm">{fmtBytes(total)}</div><div className="faint small">selected</div></div>
            <button className="pill accent-pill big-pill" disabled={busy || !total} onClick={async () => {
              setBusy(true);
              sfx("launch");
              const freed = await api.cleanupRun([...pick]);
              setBusy(false);
              toast(`Freed ${fmtBytes(freed)}`);
              scan();
            }}>{busy ? <RefreshCw size={15} className="spin" /> : <Wand2 size={15} />} {busy ? "Cleaning…" : "Clean up"}</button>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------- downloads ----------------
const CAT_COLORS: Record<string, string> = { Images: "#ff7eb6", Videos: "#c084fc", Music: "#2ee6a6", Documents: "#7aa2ff", Archives: "#ffb547", Installers: "#ff6b6b", Minecraft: "#9be37a", Code: "#00e5ff", Fonts: "#e8e8e8", Torrents: "#ff9f43" };

function Downloads() {
  const org = useSettings((s) => s.organizer);
  const set = useSettings((s) => s.set);
  const [log, setLog] = useState<Moved[]>([]);
  useEffect(() => {
    const t = () => api.organizerLog().then(setLog);
    t();
    const id = setInterval(t, 3000);
    return () => clearInterval(id);
  }, []);
  const upd = (p: Partial<typeof org>) => set({ organizer: { ...org, ...p } });
  return (
    <div className="page-grid">
      <div className="span-6">
        <Card title="Downloads organizer" icon={<Download size={15} />}>
          <div className="set-row">
            <div><div className="set-label">Sort new downloads automatically</div><div className="faint small">Finished downloads move into Images, Videos, Documents, Installers… (waits until a download is complete)</div></div>
            <Switch on={org.enabled} onChange={(v) => upd({ enabled: v })} />
          </div>
          <div className="set-row">
            <div><div className="set-label">Recycle old installers</div><div className="faint small">.exe/.msi files older than 30 days go to the Recycle Bin</div></div>
            <Switch on={org.clean_installers} onChange={(v) => upd({ clean_installers: v })} />
          </div>
          <div className="btn-row">
            <button className="pill accent-pill" onClick={() => api.sortDownloads().then((n) => toast(`Sorted ${n} files`))}><Wand2 size={14} /> Sort now</button>
            <button className="pill" onClick={() => api.cleanInstallers().then((n) => toast(`${n} old installers → Recycle Bin`))}><Package size={14} /> Recycle old installers now</button>
          </div>
          <div className="legend">
            {Object.entries(CAT_COLORS).map(([k, c]) => <span key={k} className="legend-item"><i style={{ background: c }} />{k}</span>)}
          </div>
        </Card>
      </div>
      <div className="span-6">
        <Card title="Recently sorted" icon={<Check size={15} />}>
          <div className="log-list">
            {log.length === 0 && <Empty>Nothing sorted yet{org.enabled ? " — new downloads will show up here" : ""}</Empty>}
            {log.map((m, i) => (
              <div key={i} className="log-row">
                <span className="cat-dot" style={{ background: CAT_COLORS[m.folder] ?? "var(--accent)" }} />
                <div className="log-text"><span className="ellipsis">{m.name}</span><span className="faint small">→ {m.folder} · {new Date(m.at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------------- big + duplicate files ----------------
function Dupes() {
  const [big, setBig] = useState<FileInfo[] | null | "idle">("idle");
  const [dupes, setDupes] = useState<FileInfo[][] | null | "idle">("idle");
  const recycle = (paths: string[], after: () => void) => api.trash(paths).then(() => { toast(`${paths.length} file${paths.length > 1 ? "s" : ""} → Recycle Bin`); after(); }).catch((e) => toast(`${e}`, "warn"));
  return (
    <div className="page-grid">
      <div className="span-6">
        <Card title="Biggest files in your user folder" icon={<FileSearch size={15} />} actions={<button className="pill" onClick={() => { setBig(null); api.bigFiles(undefined, 200).then(setBig); }}><RefreshCw size={13} /> {big === "idle" ? "Find" : "Rescan"}</button>}>
          {big === "idle" ? <Empty>Find files over 200 MB</Empty> : big == null ? <div className="scan-wait"><div className="scan-orb" /><b>Searching…</b></div> : (
            <div className="log-list tall">
              {big.length === 0 && <Empty>No files over 200 MB</Empty>}
              {big.map((f) => (
                <div key={f.path} className="log-row">
                  <div className="log-text"><span className="ellipsis" title={f.path}>{f.name}</span><span className="faint small ellipsis">{f.path}</span></div>
                  <b className="small">{fmtBytes(f.size)}</b>
                  <IconBtn title="Show in folder" onClick={() => api.openLocation(f.path)}><FolderOpen size={14} /></IconBtn>
                  <IconBtn title="Recycle" onClick={() => recycle([f.path], () => setBig((b) => (Array.isArray(b) ? b.filter((x) => x.path !== f.path) : b)))}><Trash2 size={14} /></IconBtn>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      <div className="span-6">
        <Card title="Duplicate files" icon={<Copy size={15} />} actions={<button className="pill" onClick={() => { setDupes(null); api.duplicates().then(setDupes); }}><RefreshCw size={13} /> {dupes === "idle" ? "Find" : "Rescan"}</button>}>
          {dupes === "idle" ? <Empty>Looks in Downloads, Desktop, Documents, Pictures, Videos and Music</Empty> : dupes == null ? <div className="scan-wait"><div className="scan-orb" /><b>Comparing files…</b></div> : (
            <div className="log-list tall">
              {dupes.length === 0 && <Empty>No duplicates found</Empty>}
              {dupes.map((g, gi) => {
                const keep = [...g].sort((a, b) => b.modified - a.modified)[0];
                return (
                  <div key={gi} className="dupe-group">
                    <div className="row-between"><b className="ellipsis">{g[0].name}</b><span className="faint small">{g.length} copies · {fmtBytes(g[0].size * (g.length - 1))} wasted</span></div>
                    {g.map((f) => <div key={f.path} className={`faint small ellipsis ${f === keep ? "accent" : ""}`} title={f.path}>{f === keep ? "✓ keep " : ""}{f.path}</div>)}
                    <button className="pill small-pill" onClick={() => recycle(g.filter((f) => f !== keep).map((f) => f.path), () => setDupes((d) => (Array.isArray(d) ? d.filter((_, i) => i !== gi) : d)))}><Trash2 size={12} /> Recycle the older copies</button>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------- folders + recent ----------------
function Folders() {
  const [folders, setFolders] = useState<{ name: string; path: string }[]>([]);
  const [recent, setRecent] = useState<FileInfo[]>([]);
  useEffect(() => { api.quickFolders().then(setFolders); api.recentFiles().then(setRecent); }, []);
  const open = (p: string) => { sfx("launch"); api.launchPath(p); setTimeout(() => api.hide(), 300); };
  return (
    <div className="page-grid">
      <div className="span-6">
        <Card title="Quick folders" icon={<Folder size={15} />}>
          <div className="folder-grid">
            {folders.map((f) => (
              <motion.button key={f.path} className="folder-tile" whileHover={{ y: -3 }} whileTap={{ scale: 0.96 }} onClick={() => open(f.path)}>
                <AppIcon path={f.path} size={40} fallback={f.name} />
                <span>{f.name}</span>
              </motion.button>
            ))}
          </div>
        </Card>
      </div>
      <div className="span-6">
        <Card title="Recent files" icon={<File size={15} />}>
          <div className="log-list tall">
            {recent.length === 0 && <Empty>No recent files</Empty>}
            {recent.map((f) => (
              <button key={f.path} className="log-row clickable" onClick={() => open(f.path)}>
                <AppIcon path={f.path} size={24} fallback={f.name} />
                <div className="log-text"><span className="ellipsis">{f.name}</span><span className="faint small">{new Date(f.modified * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></div>
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
