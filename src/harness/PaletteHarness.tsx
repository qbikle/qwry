// The palette fixture harness (DESIGN rules 9 and 13, the taste-gate skill):
// the real <Palette/> with the real tokens.css and palette.css over the app
// background, fed from the stores with canned data (fixtures.palette.ts)
// instead of a database. Mounted by src/main.tsx instead of <App/> when the
// URL says so, DEV builds only:
//
//   /?harness=palette&state=<a2-palette|a2-define|a2-checks>&theme=<dark|light>
//
// A second root rather than a state of the Ask harness (A2): the palette is a
// modal over the whole window, not a pane inside a card, so it has no width to
// vary — it is its own 620px at every window size, and the frame is the window.
//
// The two things a still cannot hold are written after mount through the
// component's own doors, never by reaching into its state: define mode is
// ENTERED by picking `Define…` the way a user does, its line typed into the
// real input through the input's own event, and the hot row is stamped with
// the attribute cmdk itself sets (`data-selected`), the `actions` precedent.
//
// Never calls IPC: tauriShim.ts (imported first) answers the one command the
// palette fires on open (`history_search`) and refuses the rest by name.

import "./tauriShim";
import { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { Palette } from "../palette/Palette";
import { DEFAULT_PALETTE } from "../design/theme";
import { useConnections } from "../stores/connections";
import { useKnowledge } from "../stores/knowledge";
import { useSaved } from "../stores/saved";
import { useSchema } from "../stores/schema";
import { useSettings } from "../stores/settings";
import { useTabs } from "../stores/tabs";
import {
  CHECKS_QUERY,
  DEFINE_LINE,
  HOT_ROW,
  PALETTE_STATES,
  paletteSeed,
  type PaletteState,
} from "./fixtures.palette";
import "../app/v2.css";
import "./harness.css";

type Theme = "dark" | "light";

interface Params {
  state: PaletteState;
  theme: Theme;
}

function paramsFrom(search: string): Params {
  const q = new URLSearchParams(search);
  const raw = q.get("state");
  return {
    state: (PALETTE_STATES as readonly string[]).includes(raw ?? "")
      ? (raw as PaletteState)
      : "a2-palette",
    theme: q.get("theme") === "light" ? "light" : "dark",
  };
}

/** every store the palette reads, filled before the first render */
function seed({ theme }: Params) {
  const s = paletteSeed();
  useSettings.setState({
    gridDensity: "normal",
    uiZoom: 100,
    paletteId: DEFAULT_PALETTE,
    matchConnection: false,
    themeEverywhere: true,
  });
  useSettings.getState().setMode(theme);
  document.documentElement.dataset.theme = theme;

  useConnections.setState({
    profiles: [s.profile],
    activeProfileId: s.profile.id,
    connState: { [s.profile.id]: "connected" },
  });
  useSchema.setState({
    snapshots: { [s.profile.id]: s.snapshot },
    source: { [s.profile.id]: "server" },
    loading: {},
    errors: {},
  });
  useTabs.setState({ tabs: s.tabs, activeId: s.activeTabId });
  useSaved.setState({ queries: s.saved });
  useKnowledge.setState({ rows: { [s.profile.id]: s.knowledge } });
}

/** cmdk's own row marker: the item whose value this is becomes the hot row and
 * whichever it had chosen stands down */
function stamp(value: string) {
  const list = document.querySelectorAll<HTMLElement>("[cmdk-item]");
  for (const el of list) el.dataset.selected = el.getAttribute("data-value") === value ? "true" : "false";
  const hot = [...list].find((el) => el.dataset.selected === "true");
  hot?.scrollIntoView({ block: "center" });
}

/** type into the real input: React reads the value off the node, so the
 * setter has to be the node's own before the event it listens for */
function type(text: string) {
  const input = document.querySelector<HTMLInputElement>("[cmdk-input]");
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const pick = (value: string) =>
  document.querySelector<HTMLElement>(`[cmdk-item][data-value="${value}"]`)?.click();

function Harness({ state }: Params) {
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const ready = () => {
        document.documentElement.dataset.harnessReady = "1";
      };
      if (state === "a2-define") {
        pick("define term meaning definition");
        requestAnimationFrame(() => {
          type(DEFINE_LINE);
          requestAnimationFrame(ready);
        });
        return;
      }
      if (state === "a2-checks") {
        type(CHECKS_QUERY);
        requestAnimationFrame(ready);
        return;
      }
      stamp(HOT_ROW);
      ready();
    });
    return () => cancelAnimationFrame(id);
  }, [state]);
  return <Palette open onClose={() => {}} />;
}

export function mountPaletteHarness(root: HTMLElement): void {
  const params = paramsFrom(location.search);
  document.title = `Palette harness · ${params.state} · ${params.theme}`;
  seed(params);
  ReactDOM.createRoot(root).render(<Harness {...params} />);
}
