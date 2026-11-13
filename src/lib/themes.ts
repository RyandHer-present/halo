// Every theme is just a set of CSS variables + an optional decoration style.
// `group` is used to keep the theme picker tidy.

export type Decor = "none" | "hud" | "synth" | "aurora" | "grain";

export interface Theme {
  id: string;
  name: string;
  group: "Glass" | "Dark" | "Light" | "Vivid";
  accent: string; // default accent when "Theme" accent source is used
  decor: Decor;
  vars: Record<string, string>;
}

const glassBase = {
  "--tint": "rgba(8, 10, 18, 0.38)",
  "--panel": "rgba(255, 255, 255, 0.07)",
  "--panel-strong": "rgba(255, 255, 255, 0.12)",
  "--panel-border": "rgba(255, 255, 255, 0.12)",
  "--panel-hi": "rgba(255, 255, 255, 0.22)",
  "--panel-blur": "24px",
  "--text": "#f4f6fb",
  "--text-dim": "rgba(244, 246, 251, 0.66)",
  "--text-faint": "rgba(244, 246, 251, 0.38)",
  "--track": "rgba(255, 255, 255, 0.10)",
  "--shadow": "0 18px 50px -12px rgba(0, 0, 0, 0.45)",
  "--radius": "22px",
  "--radius-sm": "14px",
  "--glow": "0.55",
};

export const THEMES: Theme[] = [
  // ---------- Glass ----------
  { id: "glass", name: "Glass", group: "Glass", accent: "#7aa2ff", decor: "none", vars: { ...glassBase } },
  {
    id: "glass-midnight", name: "Midnight Glass", group: "Glass", accent: "#9b8cff", decor: "none",
    vars: { ...glassBase, "--tint": "rgba(3, 4, 10, 0.62)", "--panel": "rgba(255,255,255,0.05)", "--panel-border": "rgba(255,255,255,0.09)" },
  },
  {
    id: "glass-frost", name: "Frost", group: "Glass", accent: "#2f6bff", decor: "none",
    vars: {
      ...glassBase,
      "--tint": "rgba(235, 240, 250, 0.40)",
      "--panel": "rgba(255, 255, 255, 0.55)",
      "--panel-strong": "rgba(255, 255, 255, 0.75)",
      "--panel-border": "rgba(255, 255, 255, 0.7)",
      "--panel-hi": "rgba(255, 255, 255, 0.95)",
      "--text": "#121826",
      "--text-dim": "rgba(18, 24, 38, 0.66)",
      "--text-faint": "rgba(18, 24, 38, 0.40)",
      "--track": "rgba(18, 24, 38, 0.10)",
      "--shadow": "0 18px 50px -14px rgba(30, 40, 80, 0.30)",
      "--glow": "0.25",
    },
  },
  {
    id: "glass-aurora", name: "Aurora", group: "Glass", accent: "#5ef0c5", decor: "aurora",
    vars: { ...glassBase, "--tint": "rgba(4, 12, 20, 0.45)" },
  },
  {
    id: "glass-rose", name: "Rosé", group: "Glass", accent: "#ff8fb1", decor: "none",
    vars: { ...glassBase, "--tint": "rgba(30, 10, 20, 0.40)", "--panel": "rgba(255, 220, 235, 0.08)" },
  },

  // ---------- Dark ----------
  {
    id: "hud", name: "Sci-Fi HUD", group: "Dark", accent: "#00e5ff", decor: "hud",
    vars: {
      ...glassBase,
      "--tint": "rgba(0, 6, 12, 0.78)",
      "--panel": "rgba(0, 229, 255, 0.04)",
      "--panel-strong": "rgba(0, 229, 255, 0.10)",
      "--panel-border": "rgba(0, 229, 255, 0.28)",
      "--panel-hi": "rgba(0, 229, 255, 0.0)",
      "--text": "#d8fbff",
      "--text-dim": "rgba(216, 251, 255, 0.65)",
      "--text-faint": "rgba(216, 251, 255, 0.35)",
      "--track": "rgba(0, 229, 255, 0.12)",
      "--radius": "4px",
      "--radius-sm": "2px",
      "--glow": "1",
    },
  },
  {
    id: "obsidian", name: "Obsidian", group: "Dark", accent: "#e8e8e8", decor: "grain",
    vars: {
      ...glassBase,
      "--tint": "rgba(5, 5, 6, 0.88)",
      "--panel": "rgba(255,255,255,0.035)",
      "--panel-strong": "rgba(255,255,255,0.08)",
      "--panel-border": "rgba(255,255,255,0.07)",
      "--panel-hi": "rgba(255,255,255,0.10)",
      "--glow": "0.2",
    },
  },
  {
    id: "minimal-dark", name: "Minimal Dark", group: "Dark", accent: "#8ab4f8", decor: "none",
    vars: {
      ...glassBase,
      "--tint": "rgba(16, 17, 20, 0.92)",
      "--panel": "#1b1d22",
      "--panel-strong": "#24272d",
      "--panel-border": "rgba(255,255,255,0.05)",
      "--panel-hi": "rgba(255,255,255,0.04)",
      "--shadow": "0 6px 20px -8px rgba(0,0,0,0.5)",
      "--radius": "18px",
      "--glow": "0",
    },
  },
  {
    id: "forest", name: "Forest", group: "Dark", accent: "#9be37a", decor: "grain",
    vars: { ...glassBase, "--tint": "rgba(6, 16, 10, 0.80)", "--panel": "rgba(180, 255, 190, 0.05)", "--panel-border": "rgba(180,255,190,0.10)" },
  },
  {
    id: "ocean", name: "Deep Ocean", group: "Dark", accent: "#4cc9ff", decor: "aurora",
    vars: { ...glassBase, "--tint": "rgba(2, 10, 24, 0.80)", "--panel": "rgba(120, 190, 255, 0.06)" },
  },

  // ---------- Light ----------
  {
    id: "minimal-light", name: "Minimal Light", group: "Light", accent: "#0a84ff", decor: "none",
    vars: {
      ...glassBase,
      "--tint": "rgba(244, 245, 248, 0.94)",
      "--panel": "#ffffff",
      "--panel-strong": "#f1f3f7",
      "--panel-border": "rgba(0,0,0,0.06)",
      "--panel-hi": "rgba(255,255,255,1)",
      "--text": "#111318",
      "--text-dim": "rgba(17,19,24,0.62)",
      "--text-faint": "rgba(17,19,24,0.38)",
      "--track": "rgba(17,19,24,0.08)",
      "--shadow": "0 10px 30px -14px rgba(20, 30, 60, 0.22)",
      "--radius": "20px",
      "--glow": "0",
    },
  },
  {
    id: "paper", name: "Paper", group: "Light", accent: "#d9480f", decor: "grain",
    vars: {
      ...glassBase,
      "--tint": "rgba(242, 236, 225, 0.94)",
      "--panel": "rgba(255, 252, 245, 0.92)",
      "--panel-strong": "#efe7d8",
      "--panel-border": "rgba(60, 40, 20, 0.10)",
      "--panel-hi": "rgba(255,255,255,0.8)",
      "--text": "#2b2118",
      "--text-dim": "rgba(43,33,24,0.65)",
      "--text-faint": "rgba(43,33,24,0.40)",
      "--track": "rgba(43,33,24,0.09)",
      "--shadow": "0 10px 30px -16px rgba(60, 40, 20, 0.3)",
      "--radius": "16px",
      "--glow": "0",
    },
  },

  // ---------- Vivid ----------
  {
    id: "bento", name: "Bento", group: "Vivid", accent: "#ffd23f", decor: "none",
    vars: {
      ...glassBase,
      "--tint": "rgba(14, 14, 18, 0.90)",
      "--panel": "#1f1f27",
      "--panel-strong": "#2a2a35",
      "--panel-border": "rgba(255,255,255,0.0)",
      "--panel-hi": "rgba(255,255,255,0.06)",
      "--radius": "28px",
      "--glow": "0.3",
      "--bento": "1",
    },
  },
  {
    id: "synthwave", name: "Synthwave", group: "Vivid", accent: "#ff3df2", decor: "synth",
    vars: {
      ...glassBase,
      "--tint": "rgba(20, 4, 36, 0.72)",
      "--panel": "rgba(255, 61, 242, 0.07)",
      "--panel-strong": "rgba(255, 61, 242, 0.14)",
      "--panel-border": "rgba(255, 120, 245, 0.30)",
      "--panel-hi": "rgba(255, 200, 250, 0.25)",
      "--text": "#ffe9fd",
      "--text-dim": "rgba(255, 233, 253, 0.68)",
      "--text-faint": "rgba(255, 233, 253, 0.38)",
      "--radius": "14px",
      "--glow": "1",
    },
  },
  {
    id: "sunset", name: "Sunset", group: "Vivid", accent: "#ff9f43", decor: "aurora",
    vars: { ...glassBase, "--tint": "rgba(40, 12, 10, 0.55)", "--panel": "rgba(255, 190, 140, 0.08)" },
  },
  {
    id: "matrix", name: "Terminal", group: "Vivid", accent: "#39ff6a", decor: "hud",
    vars: {
      ...glassBase,
      "--tint": "rgba(0, 8, 2, 0.88)",
      "--panel": "rgba(57, 255, 106, 0.035)",
      "--panel-strong": "rgba(57, 255, 106, 0.09)",
      "--panel-border": "rgba(57, 255, 106, 0.25)",
      "--panel-hi": "rgba(0,0,0,0)",
      "--text": "#c9ffd6",
      "--text-dim": "rgba(201, 255, 214, 0.65)",
      "--text-faint": "rgba(201, 255, 214, 0.35)",
      "--radius": "0px",
      "--radius-sm": "0px",
      "--glow": "1",
    },
  },
];

export const THEME_GROUPS = ["Glass", "Dark", "Light", "Vivid"] as const;

export const FONTS: { id: string; name: string; stack: string }[] = [
  { id: "inter", name: "Inter", stack: "'Inter Variable', 'Segoe UI Variable', system-ui, sans-serif" },
  { id: "outfit", name: "Outfit", stack: "'Outfit Variable', system-ui, sans-serif" },
  { id: "manrope", name: "Manrope", stack: "'Manrope Variable', system-ui, sans-serif" },
  { id: "grotesk", name: "Space Grotesk", stack: "'Space Grotesk Variable', system-ui, sans-serif" },
  { id: "segoe", name: "Segoe UI", stack: "'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif" },
  { id: "nunito", name: "Nunito (rounded)", stack: "'Nunito Variable', system-ui, sans-serif" },
  { id: "mono", name: "JetBrains Mono", stack: "'JetBrains Mono Variable', ui-monospace, monospace" },
  { id: "orbitron", name: "Orbitron (sci-fi)", stack: "'Orbitron Variable', 'Space Grotesk Variable', sans-serif" },
];

export const themeById = (id: string) => THEMES.find((t) => t.id === id) ?? THEMES[0];
