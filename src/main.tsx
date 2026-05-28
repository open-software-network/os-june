import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { initTheme } from "./lib/theme";
import "./styles/app.css";

initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
