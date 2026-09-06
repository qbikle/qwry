// The Structure view's fixture harness (DESIGN rules 9 and 13, the taste-gate
// skill): the real <StructureTab/> with the real tokens.css and browser.css,
// fed from the stores and from tauriShim's canned `table_stats`
// (fixtures.structure.ts) instead of a database. Mounted by src/main.tsx
// instead of <App/> when the URL says so, DEV builds only:
//
//   /?harness=structure&state=<a2-hint|a2-hint-edit|a2-hint-rest|a2-hint-aka>
//     &w=<560|780|1040>&theme=<dark|light>
//
// A root of its own (A2): the hint line lives in this view, which is a tab's
// whole width and not a pane in a card, so the frame is the view at the widths
// the browser actually gets.
//
// Edit mode is ENTERED after mount the way a user enters it, by clicking the
// line (the `edit` states' precedent in AskHarness): the frame then shows the
// field the product renders, with the database's own comment as its
// placeholder, not a state a fixture asserted.

import "./tauriShim";
import { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { StructureTab } from "../browser/StructureTab";
import { DEFAULT_PALETTE } from "../design/theme";
import { useConnections } from "../stores/connections";
import { useKnowledge } from "../stores/knowledge";
import { useSchema } from "../stores/schema";
import { useSettings } from "../stores/settings";
import {
  setStructureFixture,
  STRUCTURE_SNAPSHOT,
  STRUCTURE_STATES,
  STRUCTURE_TABLE,
  structureKnowledge,
  type StructureState,
} from "./fixtures.structure";
import "../app/v2.css";
import "./harness.css";

type Theme = "dark" | "light";

/** the widths a table tab gets: the sidebar's floor, the default, and a wide
 * window (the sketch's row 4 draws these three) */
export const STRUCTURE_WIDTHS = [560, 780, 1040] as const;

interface Params {
  state: StructureState;
  w: number;
  theme: Theme;
}

const PROFILE = "harness-staging";

function paramsFrom(search: string): Params {
  const q = new URLSearchParams(search);
  const raw = q.get("state");
  const w = Number(q.get("w"));
  return {
    state: (STRUCTURE_STATES as readonly string[]).includes(raw ?? "")
      ? (raw as StructureState)
      : "a2-hint",
    w: (STRUCTURE_WIDTHS as readonly number[]).includes(w) ? w : 780,
    theme: q.get("theme") === "light" ? "light" : "dark",
  };
}

function seed({ state, theme }: Params) {
  // the canned `table_stats` answers per state (a2-hint-aka is uncommented):
  // set before the view mounts and asks for them
  setStructureFixture(state);
  useSettings.setState({
    gridDensity: "normal",
    uiZoom: 100,
    paletteId: DEFAULT_PALETTE,
    matchConnection: false,
    themeEverywhere: true,
  });
  useSettings.getState().setMode(theme);
  document.documentElement.dataset.theme = theme;
  // a live session on the profile: the view reads its stats through whichever
  // one stands, and tauriShim answers for it
  useConnections.setState({
    activeProfileId: PROFILE,
    sessions: { [PROFILE]: "harness-session" },
    connState: { [PROFILE]: "connected" },
  });
  useSchema.setState({
    snapshots: { [PROFILE]: STRUCTURE_SNAPSHOT },
    source: { [PROFILE]: "server" },
    loading: {},
    errors: {},
  });
  useKnowledge.setState({ rows: { [PROFILE]: structureKnowledge(state) } });
}

function Harness({ state, w }: Params) {
  useEffect(() => {
    // the stats land a tick after mount; the click waits for the view they
    // draw, so the line is the one standing in the finished view
    const id = setTimeout(() => {
      if (state === "a2-hint-edit") {
        document.querySelector<HTMLElement>(".st-hint")?.click();
      }
      // an empty cell prints its placeholder on its row's hover OR on focus
      // (DESIGN rule 8's two routes). A still cannot hold a pointer, so the
      // frame takes the focus route on the `currency` row and the hover one is
      // the dev build's eyeball
      if (state === "a2-hint-rest") {
        emptyCell("currency")?.focus({ preventScroll: true });
      }
      requestAnimationFrame(() => {
        document.documentElement.dataset.harnessReady = "1";
      });
    }, 120);
    return () => clearTimeout(id);
  }, [state]);
  return (
    <div className="harness">
      <div className="card harness-card harness-structure" style={{ width: w }}>
        <StructureTab table={STRUCTURE_TABLE} />
      </div>
    </div>
  );
}

/** the hint cell of the column row with this name, when it is an empty one */
function emptyCell(column: string): HTMLElement | null {
  for (const tr of document.querySelectorAll("tbody tr")) {
    if (tr.querySelector(".st-name")?.textContent?.trim() !== column) continue;
    return tr.querySelector<HTMLElement>(".st-comment .st-hint.empty");
  }
  return null;
}

export function mountStructureHarness(root: HTMLElement): void {
  const params = paramsFrom(location.search);
  document.title = `Structure harness · ${params.state} · ${params.w} · ${params.theme}`;
  seed(params);
  ReactDOM.createRoot(root).render(<Harness {...params} />);
}
