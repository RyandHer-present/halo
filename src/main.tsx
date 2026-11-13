import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/outfit";
import "@fontsource-variable/manrope";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/nunito";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/orbitron";
import "./styles.css";
import "./styles2.css";
import App from "./App";
import { FpsWindow, ToastWindow } from "./Overlays";

const view = window.location.hash.replace("#", "");
if (view) document.documentElement.classList.add(`win-${view}`);

// No browser context menu / reload shortcuts in the overlay.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!["INPUT", "TEXTAREA"].includes(t.tagName)) e.preventDefault();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {view === "toast" ? <ToastWindow /> : view === "fps" ? <FpsWindow /> : <App />}
  </React.StrictMode>,
);
