// Plain-text Halo commands, used by schedules and the command bar ("volume 30", "wifi off",
// "launch spotify", "clean temp", "ps: <powershell>", ...). Returns a short result string.
import { api } from "./api";
import { toast, useSettings, useUi } from "./store";
import { THEMES } from "./themes";
import { useLibrary } from "../modules/Launcher";

export const COMMAND_HELP = [
  "volume 30 · mute · unmute",
  "wifi on/off · bluetooth on/off",
  "lock · sleep · shutdown · restart",
  "mode turbo / balanced / saver",
  "play · pause · next · previous",
  "launch <app or game> · open <url or folder>",
  "theme <name>",
  "clean temp · clean all · empty recycle bin",
  "sort downloads · clean installers",
  "kill <process name>",
  "fps overlay",
  "ps: <PowerShell command>",
];

async function findLaunchable(name: string) {
  const lib = useLibrary.getState();
  lib.load();
  for (let i = 0; i < 30 && (!lib.games || !lib.apps); i++) await new Promise((r) => setTimeout(r, 100));
  const { games, apps } = useLibrary.getState();
  const q = name.toLowerCase().trim();
  const g = (games ?? []).find((x) => x.name.toLowerCase() === q) ?? (games ?? []).find((x) => x.name.toLowerCase().includes(q));
  const a = (apps ?? []).find((x) => x.name.toLowerCase() === q) ?? (apps ?? []).find((x) => x.name.toLowerCase().startsWith(q)) ?? (apps ?? []).find((x) => x.name.toLowerCase().includes(q));
  return { g, a };
}

export async function launchByName(name: string): Promise<string> {
  const { g, a } = await findLaunchable(name);
  if (a && (!g || a.name.toLowerCase() === name.toLowerCase().trim())) {
    await api.launchPath(a.path);
    return `Opened ${a.name}`;
  }
  if (g) {
    await api.launchGame(g.source, g.id);
    return `Launching ${g.name}`;
  }
  if (a) {
    await api.launchPath(a.path);
    return `Opened ${a.name}`;
  }
  throw new Error(`No app or game called "${name}"`);
}

export async function runCommand(raw: string): Promise<string> {
  const text = raw.trim();
  const q = text.toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = q.match(/^(?:set\s+)?(?:vol|volume)\s*(?:to\s*)?(\d{1,3})%?$/))) {
    const v = Math.min(100, +m[1]);
    await api.setVolume(v / 100);
    await api.setMute(false);
    return `Volume ${v}%`;
  }
  if (q === "mute") return api.setMute(true).then(() => "Muted");
  if (q === "unmute") return api.setMute(false).then(() => "Unmuted");
  if ((m = q.match(/^(wifi|wi-fi|bluetooth|bt)\s+(on|off)$/))) {
    const kind = m[1].startsWith("b") ? "bluetooth" : "wifi";
    await api.setRadio(kind, m[2] === "on");
    return `${kind === "wifi" ? "Wi-Fi" : "Bluetooth"} ${m[2]}`;
  }
  if (["lock", "sleep", "hibernate", "shutdown", "shut down", "restart", "reboot", "sign out"].includes(q)) {
    const a = q === "shut down" ? "shutdown" : q === "reboot" ? "restart" : q === "sign out" ? "signout" : q;
    if (a !== "lock") api.hide();
    setTimeout(() => api.power(a), a === "lock" ? 0 : 500);
    return `Power: ${a}`;
  }
  if ((m = q.match(/^(?:power\s+)?mode\s+(turbo|performance|balanced|saver|efficiency|battery saver)$/))) {
    const mode = /turbo|perf/.test(m[1]) ? "performance" : m[1] === "balanced" ? "balanced" : "efficiency";
    await api.setPowerMode(mode);
    return `Power mode ${mode}`;
  }
  if (["play", "pause", "play pause", "toggle music"].includes(q)) return api.media("toggle").then(() => "Play/pause");
  if (["next", "skip", "next track"].includes(q)) return api.media("next").then(() => "Next track");
  if (["previous", "prev", "back"].includes(q)) return api.media("prev").then(() => "Previous track");
  if ((m = text.match(/^(?:launch|start|run|play)\s+(.+)$/i))) return launchByName(m[1]);
  if ((m = text.match(/^open\s+(.+)$/i))) {
    const t = m[1].trim();
    if (/^(https?:|ms-settings:|shell:|[a-z]:\\|\\\\)/i.test(t)) {
      await api.launchPath(t);
      return `Opened ${t}`;
    }
    return launchByName(t);
  }
  if ((m = q.match(/^theme\s+(.+)$/))) {
    const t = THEMES.find((x) => x.name.toLowerCase() === m![1]) ?? THEMES.find((x) => x.name.toLowerCase().includes(m![1]));
    if (!t) throw new Error("No theme by that name");
    useSettings.getState().set({ theme: t.id });
    return `Theme ${t.name}`;
  }
  if (q === "clean temp" || q === "clean all" || q === "empty recycle bin" || q === "cleanup") {
    const ids = q === "clean temp" ? ["temp", "wintemp"] : q === "empty recycle bin" ? ["recycle"] : ["temp", "wintemp", "thumbs", "dumps", "browser", "updates", "delivery"];
    const freed = await api.cleanupRun(ids);
    return `Freed ${(freed / 1e9).toFixed(2)} GB`;
  }
  if (q === "sort downloads") return api.sortDownloads().then((n) => `Sorted ${n} files`);
  if (q === "clean installers") return api.cleanInstallers().then((n) => `Moved ${n} old installers to the Recycle Bin`);
  if ((m = text.match(/^(?:kill|end|close)\s+(.+)$/i))) return api.killByName(m[1].trim()).then(() => `Ended ${m![1]}`);
  if (q === "fps overlay" || q === "fps") return api.fpsToggle().then((on) => `FPS overlay ${on ? "on" : "off"}`);
  if ((m = text.match(/^ps:\s*([\s\S]+)$/i))) return api.powershell(m[1]);
  if ((m = q.match(/^(?:go to|page)\s+(\w+)$/))) {
    useUi.getState().setUi({ page: m[1] });
    return `Opened ${m[1]}`;
  }
  throw new Error(`Halo doesn't know the command "${text}"`);
}

/** Run a command and toast the outcome. */
export async function runCommandToast(text: string) {
  try {
    toast(await runCommand(text));
  } catch (e) {
    toast(`${e instanceof Error ? e.message : e}`, "warn");
  }
}
