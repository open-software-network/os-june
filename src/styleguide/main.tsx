import React from "react";
import ReactDOM from "react-dom/client";
import { applyBrandVar, getStoredBrand } from "../lib/brand";
import { initTheme } from "../lib/theme";
import "../styles/app.css";
import { StyleguideApp } from "./StyleguideApp";
import "./styleguide.css";

// Dev-only living styleguide entry. Mounts its own root against the real
// app.css + tokens.css so specimens resolve to the shipping design system.
// Both initTheme() and applyBrandVar()/getStoredBrand() are tauri-safe to
// import in a plain browser (localStorage-guarded, no invoke at import time).
initTheme();
applyBrandVar(getStoredBrand());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <StyleguideApp />
  </React.StrictMode>,
);
