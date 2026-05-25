/**
 * The SPA entry — mounts the React app into `#root`. Bundled by Bun's built-in
 * bundler via the HTML import in `../index.html`; there is no webpack/vite step.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("dashboard: #root element missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
