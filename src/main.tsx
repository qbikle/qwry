import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { installNoAutocorrect } from "./app/noAutocorrect";
// these stores wire cross-store state via module-level subscribe() — they must
// load with the entry chunk, before any tab/results activity, even though the
// heavy surfaces that render them (grid, browser) load lazily
import "./stores/edits";
import "./stores/browser";
import "./design/tokens.css";

installNoAutocorrect();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
