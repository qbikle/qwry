import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { installNoAutocorrect } from "./app/noAutocorrect";
// these stores wire cross-store state via module-level subscribe(): they must
// load with the entry chunk, before any tab/results activity, even though the
// heavy surfaces that render them (grid, browser) load lazily
import "./stores/edits";
import "./stores/browser";
import "./design/tokens.css";

installNoAutocorrect();

const root = document.getElementById("root") as HTMLElement;
if (import.meta.env.DEV && new URLSearchParams(location.search).get("harness") === "ask") {
  // the Ask fixture harness (src/harness, taste-gate evidence): DEV only, so
  // the branch and its import are dead code in the production bundle
  void import("./harness/AskHarness").then((m) => m.mountAskHarness(root));
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
