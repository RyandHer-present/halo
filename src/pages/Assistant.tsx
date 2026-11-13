import { AnimatePresence, motion } from "framer-motion";
import { Bot, Brain, Camera, Check, ChevronDown, History, KeyRound, Mic, Plus, RotateCcw, Send, Settings2, Sparkles, Trash2, Undo2, Volume2, VolumeX, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Card, Empty, IconBtn, Segmented, Switch } from "../components/ui";
import { api } from "../lib/api";
import { ask, ChatMsg, finishVoice, listGeminiModels, newChat, startRecording, stopSpeaking, ToolCall, undo, useAi, useVoice } from "../lib/ai";
import { toast, useSettings, useUi } from "../lib/store";
import { sfx } from "../lib/util";

const TOOL_LABEL: Record<string, string> = {
  get_system_status: "Checked your PC", list_processes: "Looked at processes", end_process: "Ended a process", set_volume: "Volume",
  set_mute: "Mute", set_audio_output: "Audio output", media_control: "Media", set_radio: "Radio", wifi: "Wi-Fi", power: "Power",
  set_power_mode: "Power mode", launch: "Opened app", open: "Opened", run_powershell: "PowerShell", list_folder: "Listed folder",
  read_file: "Read file", write_file: "Wrote file", move_file: "Moved", delete_files: "Recycled", take_screenshot: "Looked at screen",
  remember: "Remembered", forget: "Forgot", set_theme: "Theme", display: "Display", disk_cleanup: "Cleanup", organize_downloads: "Downloads",
  services: "Services", startup_apps: "Startup apps", apps: "winget", add_todo: "To-do", add_event: "Calendar", create_schedule: "Schedule",
  halo_command: "Halo command", notifications: "Notifications", show_page: "Page",
};

function ToolChip({ c }: { c: ToolCall }) {
  const [open, setOpen] = useState(false);
  const log = useAi((s) => s.log.find((l) => l.id === c.logId));
  return (
    <div className={`tool-chip ${c.ok ? "" : "bad"}`}>
      <button className="tool-chip-head" onClick={() => setOpen(!open)}>
        <Wrench size={12} />
        <span>{log?.summary ?? TOOL_LABEL[c.name] ?? c.name}</span>
        {log?.undo && !log.undone && (
          <span className="tool-undo" onClick={(e) => { e.stopPropagation(); sfx("click"); undo(log.id); }}><Undo2 size={11} /> {log.undo.label}</span>
        )}
        {log?.undone && <span className="faint">undone</span>}
        <ChevronDown size={12} className={open ? "rot" : ""} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.pre className="tool-detail" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            {Object.keys(c.args ?? {}).length ? `${JSON.stringify(c.args, null, 1)}\n\n` : ""}{c.result.slice(0, 3000)}
          </motion.pre>
        )}
      </AnimatePresence>
    </div>
  );
}

function Bubble({ m }: { m: ChatMsg }) {
  return (
    <motion.div className={`bubble-row ${m.role}`} initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 300, damping: 26 }}>
      {m.role === "assistant" && <div className="bot-dot"><Sparkles size={14} /></div>}
      <div className="bubble-col">
        {m.tools && m.tools.length > 0 && <div className="tool-list">{m.tools.map((c, i) => <ToolChip key={i} c={c} />)}</div>}
        {m.text && (
          <div className={`bubble ${m.role} ${m.error ? "error" : ""}`}>
            {m.image && <span className="bubble-tag"><Camera size={11} /> screenshot</span>}
            {m.text}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function Thinking() {
  const live = useAi((s) => s.live);
  const tools = useAi((s) => s.liveTools);
  const status = useAi((s) => s.status);
  return (
    <div className="bubble-row assistant">
      <div className="bot-dot pulse"><Sparkles size={14} /></div>
      <div className="bubble-col">
        {tools.length > 0 && <div className="tool-list">{tools.map((c, i) => <ToolChip key={i} c={c} />)}</div>}
        <div className="bubble assistant">
          {live || <span className="typing"><i /><i /><i /> <span className="faint small">{status}</span></span>}
        </div>
      </div>
    </div>
  );
}

/** Text box + mic + screenshot + send. */
export function Composer({ compact }: { compact?: boolean }) {
  const [text, setText] = useState("");
  const [shot, setShot] = useState(false);
  const busy = useAi((s) => s.busy);
  const recording = useVoice((s) => s.recording);
  const level = useVoice((s) => s.level);
  const pending = useAi((s) => s.pending);
  const ref = useRef<HTMLTextAreaElement>(null);

  const send = async (t = text) => {
    if (!t.trim() && !shot) return;
    sfx("click");
    setText("");
    const img = shot ? await api.screenshot().catch(() => undefined) : undefined;
    setShot(false);
    ask(t.trim() || "What's on my screen?", { image: img }).catch(() => {});
  };
  useEffect(() => {
    if (pending) {
      useAi.setState({ pending: null });
      send(pending);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const down = async () => {
    try { await startRecording(); sfx("toggle"); } catch (e) { toast(`Microphone: ${e instanceof Error ? e.message : e}`, "warn"); }
  };
  const up = () => { if (useVoice.getState().recording) { sfx("click"); finishVoice(); } };

  return (
    <div className={`composer ${compact ? "compact" : ""}`}>
      {!compact && (
        <button className={`comp-btn ${shot ? "on" : ""}`} title="Attach a screenshot of your screen" onClick={() => { sfx("toggle"); setShot(!shot); }}><Camera size={17} /></button>
      )}
      <textarea ref={ref} rows={1} className="comp-input no-drag" value={text} placeholder={recording ? "Listening… release to send" : busy ? "Working…" : "Ask Halo to do anything on your PC…"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!busy) send(); } e.stopPropagation(); }} />
      <button className={`comp-btn mic ${recording ? "rec" : ""}`} title="Hold to talk (or hold Ctrl+Shift+Space anywhere)"
        style={{ "--lvl": level } as any} onPointerDown={down} onPointerUp={up} onPointerLeave={up}>
        <Mic size={17} />
      </button>
      <button className="comp-btn send" disabled={busy || (!text.trim() && !shot)} onClick={() => send()}><Send size={16} /></button>
    </div>
  );
}

function Setup({ onClose }: { onClose?: () => void }) {
  const ai = useSettings((s) => s.ai);
  const set = useSettings((s) => s.set);
  const [models, setModels] = useState<string[]>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const upd = (p: Partial<typeof ai>) => set({ ai: { ...useSettings.getState().ai, ...p } });
  useEffect(() => {
    if (ai.geminiKey) listGeminiModels(ai.geminiKey).then(setModels).catch(() => setModels([]));
  }, [ai.geminiKey]);
  useEffect(() => {
    const load = () => setVoices(speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en")));
    load();
    speechSynthesis.onvoiceschanged = load;
  }, []);
  return (
    <Card title="Assistant setup" icon={<KeyRound size={15} />} actions={onClose && <IconBtn onClick={onClose}><X size={15} /></IconBtn>}>
      <div className="setup">
        <div className="set-row">
          <div><div className="set-label">Who answers</div><div className="faint small">Gemini is free with a Google AI Studio key. Claude needs a paid API key (your claude.ai plan doesn't include one).</div></div>
          <Segmented value={ai.provider} onChange={(v) => upd({ provider: v })} options={[{ id: "gemini", label: "Gemini" }, { id: "claude", label: "Claude" }]} />
        </div>
        <label className="field">
          <span>Gemini API key <a className="link-btn" onClick={() => api.launchPath("https://aistudio.google.com/apikey")}>get one free →</a></span>
          <input className="input no-drag" type="password" value={ai.geminiKey} placeholder="AIza…" onChange={(e) => upd({ geminiKey: e.target.value.trim() })} />
        </label>
        {models.length > 0 && (
          <label className="field">
            <span>Gemini model</span>
            <select className="input" value={ai.geminiModel} onChange={(e) => upd({ geminiModel: e.target.value })}>
              <option value="">Automatic (newest Flash)</option>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        )}
        <label className="field">
          <span>Claude API key <span className="faint">(optional)</span></span>
          <input className="input no-drag" type="password" value={ai.claudeKey} placeholder="sk-ant-…" onChange={(e) => upd({ claudeKey: e.target.value.trim() })} />
        </label>
        {ai.claudeKey && (
          <label className="field">
            <span>Claude model</span>
            <select className="input" value={ai.claudeModel} onChange={(e) => upd({ claudeModel: e.target.value })}>
              <option value="claude-opus-5-5">Claude Opus 5.5 (smartest)</option>
              <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (faster, cheaper)</option>
              <option value="claude-haiku-5-5">Claude Haiku 5.5 (fastest, cheapest)</option>
            </select>
          </label>
        )}
        <div className="set-row">
          <div><div className="set-label">Speak replies</div><div className="faint small">Read answers out loud</div></div>
          <Switch on={ai.speak} onChange={(v) => upd({ speak: v })} />
        </div>
        {ai.speak && voices.length > 0 && (
          <label className="field">
            <span>Voice</span>
            <select className="input" value={ai.voice} onChange={(e) => upd({ voice: e.target.value })}>
              <option value="">Automatic</option>
              {voices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
            </select>
          </label>
        )}
        <div className="faint small">Push-to-talk anywhere: hold <span className="kbd">Ctrl + Shift + Space</span>. Voice uses your Gemini key to transcribe.</div>
      </div>
    </Card>
  );
}

function ActionLog() {
  const log = useAi((s) => s.log);
  return (
    <Card title="Action log" icon={<History size={15} />} actions={log.length > 0 && <IconBtn title="Clear log" onClick={() => useAi.setState({ log: [] })}><Trash2 size={14} /></IconBtn>}>
      <div className="log-list">
        {log.length === 0 && <Empty>Everything the assistant does shows up here, with undo.</Empty>}
        {log.slice(0, 60).map((l) => (
          <div key={l.id} className={`log-row ${l.undone ? "undone" : ""}`}>
            <div className="log-text">
              <span className="ellipsis">{l.summary}</span>
              <span className="faint small">{new Date(l.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
            </div>
            {l.undo && !l.undone && <button className="pill small-pill" onClick={() => { sfx("click"); undo(l.id); }}><Undo2 size={12} /> {l.undo.label}</button>}
            {l.undone && <span className="faint small">Undone</span>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Memory() {
  const memory = useAi((s) => s.memory);
  const [adding, setAdding] = useState("");
  return (
    <Card title="Memory" icon={<Brain size={15} />}>
      <div className="mem-list">
        {memory.length === 0 && <div className="faint small">Tell the assistant about yourself and it'll remember across chats.</div>}
        {memory.map((m, i) => (
          <div key={i} className="mem-row">
            <span>{m}</span>
            <button onClick={() => useAi.setState({ memory: memory.filter((_, j) => j !== i) })}><X size={12} /></button>
          </div>
        ))}
        <form onSubmit={(e) => { e.preventDefault(); if (adding.trim()) { useAi.setState({ memory: [...memory, adding.trim()] }); setAdding(""); } }}>
          <input className="input no-drag" placeholder="Add something to remember…" value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </form>
      </div>
    </Card>
  );
}

const SUGGESTIONS = [
  "What's using my CPU right now?",
  "Clean up junk files",
  "Turn the volume to 30 and switch to turbo mode",
  "What's on my screen?",
  "Sort my Downloads folder",
  "Any app updates?",
];

export function AiPage() {
  const { chats, currentId, busy } = useAi();
  const ai = useSettings((s) => s.ai);
  const [showSetup, setShowSetup] = useState(false);
  const chat = chats.find((c) => c.id === currentId);
  const scroller = useRef<HTMLDivElement>(null);
  const live = useAi((s) => s.live);
  const liveTools = useAi((s) => s.liveTools);
  const noKey = ai.provider === "gemini" ? !ai.geminiKey : !ai.claudeKey;
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [chat?.messages.length, busy, live, liveTools.length]);

  return (
    <div className="page ai-page">
      <div className="ai-cols">
        <div className="ai-side">
          <button className="pill accent-pill wide" onClick={() => { sfx("click"); newChat(); }}><Plus size={14} /> New chat</button>
          <div className="chat-list">
            {chats.map((c) => (
              <div key={c.id} className={`chat-item ${c.id === currentId ? "on" : ""}`} onClick={() => { sfx("click"); useAi.setState({ currentId: c.id }); }}>
                <span className="ellipsis">{c.title}</span>
                <button className="chat-del" onClick={(e) => { e.stopPropagation(); useAi.setState((s) => ({ chats: s.chats.filter((x) => x.id !== c.id), currentId: s.currentId === c.id ? null : s.currentId })); }}><X size={12} /></button>
              </div>
            ))}
            {chats.length === 0 && <div className="faint small" style={{ padding: 10 }}>Chats are saved here.</div>}
          </div>
        </div>

        <div className="ai-main">
          <div className="ai-top">
            <div>
              <h1 className="ai-title">Assistant</h1>
              <div className="faint small">{ai.provider === "claude" ? ai.claudeModel : ai.geminiModel || "Gemini"} · full control · every action can be undone</div>
            </div>
            <div className="grow" />
            <IconBtn title={ai.speak ? "Mute replies" : "Speak replies"} onClick={() => { stopSpeaking(); useSettings.getState().set({ ai: { ...ai, speak: !ai.speak } }); }}>{ai.speak ? <Volume2 size={16} /> : <VolumeX size={16} />}</IconBtn>
            <IconBtn title="Setup" active={showSetup} onClick={() => setShowSetup(!showSetup)}><Settings2 size={16} /></IconBtn>
          </div>
          <AnimatePresence>
            {(showSetup || noKey) && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} style={{ overflow: "hidden", flex: "none" }}>
                <Setup onClose={noKey ? undefined : () => setShowSetup(false)} />
              </motion.div>
            )}
          </AnimatePresence>
          <div className="messages" ref={scroller}>
            {(!chat || chat.messages.length === 0) && !busy && (
              <div className="ai-empty">
                <motion.div className="ai-orb" animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 4, repeat: Infinity }}><Bot size={34} /></motion.div>
                <h2>What can I do for you?</h2>
                <div className="suggests">
                  {SUGGESTIONS.map((s) => <button key={s} className="pill" onClick={() => useAi.setState({ pending: s })}>{s}</button>)}
                </div>
              </div>
            )}
            {chat?.messages.map((m) => <Bubble key={m.id} m={m} />)}
            {busy && <Thinking />}
          </div>
          <Composer />
        </div>

        <div className="ai-right">
          <ActionLog />
          <Memory />
        </div>
      </div>
    </div>
  );
}

/** Home-grid widget: last reply + a composer. */
export function AssistantModule() {
  const { chats, currentId, busy } = useAi();
  const chat = chats.find((c) => c.id === currentId);
  const last = chat?.messages.slice(-2) ?? [];
  const status = useAi((s) => s.status);
  const live = useAi((s) => s.live);
  const setUi = useUi((s) => s.setUi);
  return (
    <Card title="Assistant" icon={<Sparkles size={15} />} actions={<IconBtn title="Open assistant" onClick={() => setUi({ page: "ai" })}><RotateCcw size={14} style={{ transform: "scaleX(-1)" }} /></IconBtn>}>
      <div className="ai-mini">
        <div className="ai-mini-msgs">
          {last.length === 0 && !busy && <div className="faint small">Ask me to change settings, clean up, find files, open apps — anything.</div>}
          {last.map((m) => (
            <div key={m.id} className={`mini-msg ${m.role} ${m.error ? "error" : ""}`}>
              {m.tools && m.tools.length > 0 && <span className="mini-tools"><Check size={11} /> {m.tools.length} action{m.tools.length > 1 ? "s" : ""}</span>}
              {m.text}
            </div>
          ))}
          {busy && <div className="mini-msg assistant">{live || <span className="typing"><i /><i /><i /> <span className="faint small">{status}</span></span>}</div>}
        </div>
        <Composer compact />
      </div>
    </Card>
  );
}

