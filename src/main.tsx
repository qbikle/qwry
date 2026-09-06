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
const harness = import.meta.env.DEV ? new URLSearchParams(location.search).get("harness") : null;
if (harness === "ask") {
  // the Ask fixture harness (src/harness, taste-gate evidence): DEV only, so
  // the branch and its import are dead code in the production bundle
  void import("./harness/AskHarness").then((m) => m.mountAskHarness(root));
} else if (harness === "palette") {
  // the palette's own root (A2): a modal over the window, not a pane in a card
  void import("./harness/PaletteHarness").then((m) => m.mountPaletteHarness(root));
} else if (harness === "structure") {
  // the Structure view's own root (A2): the hint line lives in a tab's width
  void import("./harness/StructureHarness").then((m) => m.mountStructureHarness(root));
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
