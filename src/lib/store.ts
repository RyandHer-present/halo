import { create } from "zustand";
import { persist, createJSONStorage, StateStorage } from "zustand/middleware";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { LayoutItem } from "react-grid-layout";
import type { AlertCfg, StartApp } from "./api";

const disk = new LazyStore("halo-settings.json");
// Never write before the saved settings have loaded: an early write would replace them with defaults.
let settingsLoaded = false;
const tauriStorage: StateStorage = {
  getItem: async (k) => ((await disk.get<string>(k)) ?? null),
  setItem: async (k, v) => {
    if (!settingsLoaded) return;
    await disk.set(k, v);
    await disk.save();
  },
  removeItem: async (k) => {
    await disk.delete(k);
    await disk.save();
  },
};

export type AccentSource = "theme" | "windows" | "wallpaper" | "album" | "custom";
export type Motion = "lots" | "subtle" | "off";
export type StatView = "gauge" | "graph";
export interface Todo { id: string; text: string; done: boolean }
export interface CalEvent { id: string; date: string; time: string; title: string }
export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  when: "daily" | "once" | "interval" | "startup";
  time: string; // HH:MM (daily) or YYYY-MM-DDTHH:MM (once)
  days: number[]; // 0=Sun..6, empty = every day
  minutes: number; // interval
  kind: "command" | "ai";
  action: string;
  lastRun: number;
}
export interface AiCfg {
  provider: "gemini" | "claude";
  geminiKey: string;
  claudeKey: string;
  geminiModel: string;
  claudeModel: string;
  speak: boolean;
  voice: string;
  ttsEngine: "windows" | "groq" | "fish";
  groqKey: string;
  groqVoice: string;
  fishKey: string;
  fishVoice: string;
}

export const DEFAULT_LAYOUT: LayoutItem[] = [
  // 14 rows fill one screen; the rest scrolls.
  { i: "clock", x: 0, y: 0, w: 3, h: 9, minW: 2, minH: 3 },
  { i: "weather", x: 3, y: 0, w: 3, h: 5, minW: 2, minH: 3 },
  { i: "cpu", x: 6, y: 0, w: 2, h: 5, minW: 2, minH: 3 },
  { i: "gpu", x: 8, y: 0, w: 2, h: 5, minW: 2, minH: 3 },
  { i: "ram", x: 10, y: 0, w: 2, h: 5, minW: 2, minH: 3 },
  { i: "media", x: 3, y: 5, w: 5, h: 7, minW: 3, minH: 4 },
  { i: "quick", x: 8, y: 5, w: 4, h: 7, minW: 3, minH: 5 },
  { i: "battery", x: 0, y: 9, w: 3, h: 6, minW: 2, minH: 4 },
  { i: "launcher", x: 3, y: 12, w: 6, h: 7, minW: 3, minH: 4 },
  { i: "todo", x: 9, y: 12, w: 3, h: 7, minW: 2, minH: 3 },
  { i: "net", x: 0, y: 15, w: 3, h: 4, minW: 2, minH: 3 },
  { i: "disk", x: 0, y: 19, w: 3, h: 5, minW: 2, minH: 3 },
  { i: "notifs", x: 3, y: 19, w: 4, h: 7, minW: 2, minH: 3 },
  { i: "ai", x: 7, y: 19, w: 5, h: 7, minW: 3, minH: 4 },
];

export const MODULE_NAMES: Record<string, string> = {
  clock: "Clock & calendar",
  weather: "Weather",
  cpu: "CPU",
  gpu: "GPU",
  ram: "Memory",
  media: "Now playing",
  quick: "Quick controls",
  net: "Network",
  battery: "Battery & power",
  launcher: "Apps & games",
  todo: "To-do & notes",
  disk: "Storage",
  uptime: "System info",
  notifs: "Notifications",
  ai: "Assistant",
};

interface Settings {
  theme: string;
  accentSource: AccentSource;
  customAccent: string;
  font: string;
  motion: Motion;
  sounds: boolean;
  soundVolume: number;
  clock24h: boolean;
  fahrenheit: boolean;
  dim: number; // extra darkening over the blurred desktop, 0..1
  statViews: Record<string, StatView>;
  layout: LayoutItem[];
  pinnedApps: StartApp[];
  hiddenGames: string[];
  todos: Todo[];
  notes: string;
  events: CalEvent[];
  ai: AiCfg;
  alerts: AlertCfg;
  organizer: { enabled: boolean; clean_installers: boolean };
  schedules: Schedule[];
  hiddenNotifs: number[];
  notifsClearedAt: number;
  set: (p: Partial<Settings>) => void;
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      theme: "glass",
      accentSource: "theme",
      customAccent: "#7aa2ff",
      font: "inter",
      motion: "lots",
      sounds: true,
      soundVolume: 0.5,
      clock24h: false,
      fahrenheit: true,
      dim: 0.15,
      statViews: {},
      layout: DEFAULT_LAYOUT,
      pinnedApps: [],
      hiddenGames: [],
      todos: [],
      notes: "",
      events: [],
      ai: { provider: "gemini", geminiKey: "", claudeKey: "", geminiModel: "", claudeModel: "claude-opus-5-5", speak: true, voice: "", ttsEngine: "windows", groqKey: "", groqVoice: "daniel", fishKey: "", fishVoice: "" },
      alerts: { cpu_temp: 95, gpu_temp: 87, disk_free_pct: 8, hog_cpu: 70, net_down: true },
      organizer: { enabled: false, clean_installers: false },
      schedules: [],
      hiddenNotifs: [],
      notifsClearedAt: 0,
      set: (p) => set(p),
    }),
    {
      name: "settings",
      version: 3,
      migrate: (old: any, v) => {
        if (v < 2) return { ...old, layout: DEFAULT_LAYOUT };
        if (v < 3) {
          // add the new widgets at the bottom of an existing layout
          const extra = DEFAULT_LAYOUT.filter((d) => (d.i === "notifs" || d.i === "ai") && !old.layout?.some((l: LayoutItem) => l.i === d.i)).map((d) => ({ ...d, y: 999 }));
          return { ...old, layout: [...(old.layout ?? DEFAULT_LAYOUT), ...extra] };
        }
        return old;
      },
      storage: createJSONStorage(() => tauriStorage),
      onRehydrateStorage: () => (_state, error) => { if (!error) settingsLoaded = true; },
      partialize: ({ set: _s, ...rest }) => rest,
    },
  ),
);

/** Live, non-persisted UI state. */
interface Ui {
  page: string;
  visible: boolean;
  editing: boolean;
  accent: string;
  albumAccent: string | null;
  toast: { id: number; text: string; kind?: "info" | "warn" } | null;
  setUi: (p: Partial<Ui>) => void;
}
export const useUi = create<Ui>()((set) => ({
  page: "home",
  visible: true,
  editing: false,
  accent: "#7aa2ff",
  albumAccent: null,
  toast: null,
  setUi: (p) => set(p),
}));

export const toast = (text: string, kind: "info" | "warn" = "info") =>
  useUi.getState().setUi({ toast: { id: Date.now(), text, kind } });
