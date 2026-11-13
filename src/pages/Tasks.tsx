import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight, FolderOpen, Package, Play, RefreshCw, RotateCw, Search, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppIcon, Card, Empty, IconBtn, Segmented, Switch } from "../components/ui";
import { api, Proc, Program, Service, StartupItem } from "../lib/api";
import { toast } from "../lib/store";
import { fmtBytes, sfx, usePoll } from "../lib/util";
import { PageHeader } from "./Pages";

type Tab = "procs" | "services" | "startup" | "apps";

export function TasksPage() {
  const [tab, setTab] = useState<Tab>("procs");
  const [q, setQ] = useState("");
  return (
    <div className="page">
      <PageHeader title="Tasks" sub="Everything running on your PC, what starts with it, and what's installed" />
      <div className="toolbar">
        <Segmented value={tab} onChange={(t) => { setTab(t); setQ(""); }} options={[{ id: "procs", label: "Processes" }, { id: "services", label: "Services" }, { id: "startup", label: "Startup" }, { id: "apps", label: "Installed apps" }]} />
        <div className="search-field small"><Search size={15} /><input className="no-drag" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></div>
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
          {tab === "procs" && <Processes q={q} />}
          {tab === "services" && <Services q={q} />}
          {tab === "startup" && <Startup q={q} />}
          {tab === "apps" && <Programs q={q} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ---------------- processes ----------------
interface Node { p: Proc; kids: Node[]; cpu: number; mem: number; disk: number }
const NO_NEST = new Set(["explorer.exe", "services.exe", "svchost.exe", "wininit.exe", "winlogon.exe", "System", "userinit.exe", "sihost.exe", "smss.exe", "csrss.exe"]);

function buildTree(ps: Proc[]) {
  const byPid = new Map(ps.map((p) => [p.pid, p]));
  const nodes = new Map<number, Node>(ps.map((p) => [p.pid, { p, kids: [], cpu: p.cpu, mem: p.mem, disk: p.disk_read + p.disk_write }]));
  const roots: Node[] = [];
  for (const p of ps) {
    const parent = p.parent != null ? byPid.get(p.parent) : undefined;
    const nest = parent && parent.pid !== p.pid && !NO_NEST.has(parent.name) && (parent.name === p.name || (parent.window != null && !p.window));
    if (nest) nodes.get(parent!.pid)!.kids.push(nodes.get(p.pid)!);
    else roots.push(nodes.get(p.pid)!);
  }
  const sum = (n: Node): void => {
    n.kids.forEach(sum);
    n.cpu = n.p.cpu + n.kids.reduce((a, k) => a + k.cpu, 0);
    n.mem = n.p.mem + n.kids.reduce((a, k) => a + k.mem, 0);
    n.disk = n.p.disk_read + n.p.disk_write + n.kids.reduce((a, k) => a + k.disk, 0);
  };
  roots.forEach(sum);
  return roots;
}

const heat = (v: number, hi: number) => `rgba(var(--accent-rgb), ${Math.min(0.35, (v / hi) * 0.35)})`;

function ProcRow({ n, depth, sort, open, setOpen, sel, setSel }: { n: Node; depth: number; sort: string; open: Set<number>; setOpen: (s: Set<number>) => void; sel: number | null; setSel: (p: number | null) => void }) {
  const isOpen = open.has(n.p.pid);
  const kids = [...n.kids].sort(sorter(sort));
  const name = n.p.window && depth === 0 ? n.p.window : n.p.name;
  return (
    <>
      <div className={`trow proc ${sel === n.p.pid ? "sel" : ""}`} onClick={() => setSel(sel === n.p.pid ? null : n.p.pid)}>
        <div className="tcell name" style={{ paddingLeft: 8 + depth * 22 }}>
          {n.kids.length > 0 ? (
            <button className={`twisty ${isOpen ? "open" : ""}`} onClick={(e) => { e.stopPropagation(); const s = new Set(open); isOpen ? s.delete(n.p.pid) : s.add(n.p.pid); setOpen(s); }}><ChevronRight size={14} /></button>
          ) : <span className="twisty" />}
          {n.p.exe ? <AppIcon path={n.p.exe} size={20} fallback={n.p.name} /> : <div className="appicon-fallback" style={{ width: 20, height: 20, fontSize: 10 }}>{n.p.name[0]}</div>}
          <span className="ellipsis">{name}{n.kids.length > 0 && <span className="faint"> ({n.kids.length + 1})</span>}</span>
        </div>
        <div className="tcell num" style={{ background: heat(n.cpu, 50) }}>{n.cpu.toFixed(1)}%</div>
        <div className="tcell num" style={{ background: heat(n.mem, 3e9) }}>{fmtBytes(n.mem)}</div>
        <div className="tcell num" style={{ background: heat(n.disk, 50e6) }}>{n.disk ? `${fmtBytes(n.disk)}/s` : "0"}</div>
        <div className="tcell num faint">{n.p.pid}</div>
        <div className="tcell act">
          <button className="end-btn" title="End task" onClick={(e) => { e.stopPropagation(); sfx("close"); api.killProcess(n.p.pid, true).then(() => toast(`Ended ${n.p.name}`)).catch((er) => toast(`${er}`, "warn")); }}><X size={13} /> End</button>
        </div>
      </div>
      <AnimatePresence>
        {sel === n.p.pid && (
          <motion.div className="proc-detail" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <div className="kv">
              <span>Process</span><b>{n.p.name}</b>
              <span>Path</span><b title={n.p.exe ?? ""}>{n.p.exe ?? "—"}</b>
              <span>Started</span><b>{n.p.start ? new Date(n.p.start * 1000).toLocaleString() : "—"}</b>
              <span>Disk</span><b>read {fmtBytes(n.p.disk_read)}/s · write {fmtBytes(n.p.disk_write)}/s</b>
            </div>
            <div className="detail-actions">
              {n.p.exe && <button className="pill" onClick={() => api.openLocation(n.p.exe!)}><FolderOpen size={13} /> Open location</button>}
              <select className="input mini-select" defaultValue="" onChange={(e) => { if (e.target.value) api.setPriority(n.p.pid, e.target.value).then(() => toast("Priority changed")).catch((er) => toast(`${er}`, "warn")); }}>
                <option value="" disabled>Priority…</option>
                <option value="high">High</option><option value="above">Above normal</option><option value="normal">Normal</option><option value="below">Below normal</option><option value="low">Low</option>
              </select>
              <button className="pill danger" onClick={() => api.killProcess(n.p.pid, true).then(() => toast(`Ended ${n.p.name} and its children`))}><X size={13} /> End process tree</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {isOpen && kids.map((k) => <ProcRow key={k.p.pid} n={k} depth={depth + 1} sort={sort} open={open} setOpen={setOpen} sel={sel} setSel={setSel} />)}
    </>
  );
}

const sorter = (sort: string) => (a: Node, b: Node) =>
  sort === "mem" ? b.mem - a.mem : sort === "disk" ? b.disk - a.disk : sort === "name" ? (a.p.window ?? a.p.name).localeCompare(b.p.window ?? b.p.name) : b.cpu - a.cpu;

function Processes({ q }: { q: string }) {
  const ps = usePoll(api.processes, 2000);
  const [sort, setSort] = useState("cpu");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [sel, setSel] = useState<number | null>(null);
  const tree = useMemo(() => (ps ? buildTree(ps) : []), [ps]);
  const match = (n: Node): boolean => !q || n.p.name.toLowerCase().includes(q.toLowerCase()) || (n.p.window ?? "").toLowerCase().includes(q.toLowerCase()) || String(n.p.pid) === q || n.kids.some(match);
  const roots = tree.filter(match).sort(sorter(sort));
  const apps = roots.filter((n) => n.p.window);
  const bg = roots.filter((n) => !n.p.window);
  const head = (id: string, label: string) => (
    <button className={`tcell num th ${sort === id ? "on" : ""}`} onClick={() => setSort(id)}>{label}</button>
  );
  if (!ps) return <Empty>Loading processes…</Empty>;
  return (
    <Card pad={false}>
      <div className="table">
        <div className="trow head">
          <button className={`tcell name th ${sort === "name" ? "on" : ""}`} onClick={() => setSort("name")}>Name</button>
          {head("cpu", "CPU")}{head("mem", "Memory")}{head("disk", "Disk")}
          <div className="tcell num th">PID</div><div className="tcell act" />
        </div>
        <div className="tgroup">Apps ({apps.length})</div>
        {apps.map((n) => <ProcRow key={n.p.pid} n={n} depth={0} sort={sort} open={open} setOpen={setOpen} sel={sel} setSel={setSel} />)}
        <div className="tgroup">Background ({bg.length})</div>
        {bg.map((n) => <ProcRow key={n.p.pid} n={n} depth={0} sort={sort} open={open} setOpen={setOpen} sel={sel} setSel={setSel} />)}
      </div>
    </Card>
  );
}

// ---------------- services ----------------
function Services({ q }: { q: string }) {
  const [list, setList] = useState<Service[] | null>(null);
  const [filter, setFilter] = useState<"running" | "all">("running");
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => api.services().then(setList).catch((e) => { toast(`${e}`, "warn"); setList([]); });
  useEffect(() => { load(); }, []);
  const act = async (s: Service, action: string) => {
    sfx("click");
    setBusy(s.name);
    try {
      await api.serviceAction(s.name, action);
      toast(`${s.display}: ${action === "demand" ? "manual" : action}`);
    } catch (e) {
      toast(`${e}`.trim() || "Failed", "warn");
    }
    setTimeout(() => { load(); setBusy(null); }, 900);
  };
  const shown = (list ?? []).filter((s) => (filter === "all" || s.state === "Running") && (!q || `${s.display} ${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <Card pad={false} title={`${shown.length} services`} actions={<>
      <Segmented value={filter} onChange={setFilter} options={[{ id: "running", label: "Running" }, { id: "all", label: "All" }]} />
      <IconBtn title="Refresh" onClick={load}><RefreshCw size={14} /></IconBtn>
    </>}>
      {!list ? <Empty>Loading services…</Empty> : (
        <div className="table">
          {shown.map((s) => (
            <div key={s.name} className="trow svc">
              <div className="tcell name col-flex">
                <span className="ellipsis"><b>{s.display}</b></span>
                <span className="faint small ellipsis" title={s.description}>{s.name}{s.description ? ` · ${s.description}` : ""}</span>
              </div>
              <div className="tcell"><span className={`state-chip ${s.state === "Running" ? "on" : ""}`}>{busy === s.name ? "…" : s.state}</span></div>
              <div className="tcell">
                <select className="input mini-select" value={s.start_mode === "Manual" ? "demand" : s.start_mode.toLowerCase()} onChange={(e) => act(s, e.target.value)}>
                  <option value="auto">Automatic</option><option value="demand">Manual</option><option value="disabled">Disabled</option>
                </select>
              </div>
              <div className="tcell act wide">
                {s.state === "Running" ? (
                  <>
                    <IconBtn title="Restart" onClick={() => act(s, "restart")}><RotateCw size={14} /></IconBtn>
                    <IconBtn title="Stop" onClick={() => act(s, "stop")}><Square size={13} /></IconBtn>
                  </>
                ) : <IconBtn title="Start" onClick={() => act(s, "start")}><Play size={14} /></IconBtn>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------- startup ----------------
function Startup({ q }: { q: string }) {
  const [list, setList] = useState<StartupItem[] | null>(null);
  const load = () => api.startup().then(setList);
  useEffect(() => { load(); }, []);
  const shown = (list ?? []).filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Card pad={false} title={`${(list ?? []).filter((s) => s.enabled).length} of ${(list ?? []).length} apps start with Windows`}>
      {!list ? <Empty>Loading…</Empty> : (
        <div className="table">
          {shown.map((s) => (
            <div key={s.id} className={`trow startup ${s.enabled ? "" : "off"}`}>
              <div className="tcell name">
                {s.path ? <AppIcon path={s.path} size={28} fallback={s.name} /> : <div className="appicon-fallback" style={{ width: 28, height: 28, fontSize: 12 }}>{s.name[0]}</div>}
                <div className="col-flex">
                  <b className="ellipsis">{s.name}</b>
                  <span className="faint small ellipsis" title={s.command}>{s.command}</span>
                </div>
              </div>
              <div className="tcell faint small">{s.location}</div>
              <div className="tcell act">
                {s.path && <IconBtn title="Open location" onClick={() => api.openLocation(s.path!)}><FolderOpen size={14} /></IconBtn>}
                <Switch on={s.enabled} onChange={async (v) => {
                  try { await api.setStartup(s.id, v); setList((l) => l!.map((x) => (x.id === s.id ? { ...x, enabled: v } : x))); toast(`${s.name} ${v ? "will" : "won't"} start with Windows`); }
                  catch (e) { toast(`${e}`, "warn"); }
                }} />
              </div>
            </div>
          ))}
          {shown.length === 0 && <Empty>Nothing starts with Windows</Empty>}
        </div>
      )}
    </Card>
  );
}

// ---------------- installed apps ----------------
function Programs({ q }: { q: string }) {
  const [list, setList] = useState<Program[] | null>(null);
  const [sort, setSort] = useState<"name" | "size" | "date">("name");
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => { api.programs().then(setList); }, []);
  const shown = (list ?? [])
    .filter((p) => !q || `${p.name} ${p.publisher}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (sort === "size" ? b.size - a.size : sort === "date" ? b.installed.localeCompare(a.installed) : a.name.localeCompare(b.name)));
  return (
    <Card pad={false} title={list ? `${list.length} apps installed` : "Installed apps"} actions={<Segmented value={sort} onChange={setSort} options={[{ id: "name", label: "Name" }, { id: "size", label: "Size" }, { id: "date", label: "Newest" }]} />}>
      {!list ? <Empty>Reading installed apps…</Empty> : (
        <div className="table">
          {shown.map((p) => (
            <div key={p.id} className="trow program">
              <div className="tcell name">
                {p.icon ? <AppIcon path={p.icon} size={28} fallback={p.name} /> : <div className="appicon-fallback" style={{ width: 28, height: 28, fontSize: 12 }}>{p.kind === "store" ? <Package size={14} /> : p.name[0]}</div>}
                <div className="col-flex">
                  <b className="ellipsis">{p.name}</b>
                  <span className="faint small ellipsis">{[p.publisher, p.version, p.kind === "store" ? "Microsoft Store" : ""].filter(Boolean).join(" · ")}</span>
                </div>
              </div>
              <div className="tcell num">{p.size ? fmtBytes(p.size) : ""}</div>
              <div className="tcell num faint">{p.installed}</div>
              <div className="tcell act wide">
                {confirm === p.id ? (
                  <>
                    <button className="pill danger" onClick={() => { sfx("click"); setConfirm(null); api.uninstall(p.id, p.uninstall).then(() => toast(`Uninstalling ${p.name}…`)).catch((e) => toast(`${e}`, "warn")); }}>Uninstall</button>
                    <IconBtn onClick={() => setConfirm(null)}><X size={14} /></IconBtn>
                  </>
                ) : <button className="pill ghost" onClick={() => setConfirm(p.id)}><Trash2 size={13} /> Uninstall</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
