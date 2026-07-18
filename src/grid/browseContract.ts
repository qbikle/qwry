// Grid-side adapter over the browse store's data-navigation contract:
//   - sort chain: `useBrowser.getState().setSortChain(chain)` with chain =
//     Array<{column, dir: "asc"|"desc", nulls?: "first"|"last"}> (sortChain
//     state is the source of truth; `sort` is a legacy mirror of entry 0).
//   - compiled WHERE for the histogram: the EXACT text the browse queries
//     embed, via the exported `compiledWhere(filters, rawWhere)` — builder
//     filters, or the raw-WHERE escape hatch when that mode is on.
// Only maps between the store's {column,…} shape and the grid's generic
// ChainEntry<K> (keyed by name here, by data index for editor results).
import { useBrowser, compiledWhere } from "../stores/browser";
import type { SortChain } from "../stores/browser";
import type { ChainEntry } from "./spelunkLogic";

/** store chain → the grid's generic chain (keyed by column name) */
export function browseEffectiveChain(chain: SortChain): ChainEntry<string>[] {
  return chain.map((e) => ({
    key: e.column,
    dir: e.dir,
    ...(e.nulls ? { nulls: e.nulls } : {}),
  }));
}

/** grid chain → the store contract (replaces the whole chain; the store
 * re-runs with the new ORDER BY and keeps its keyset/pagination honest) */
export function dispatchBrowseChain(next: ChainEntry<string>[]): void {
  useBrowser
    .getState()
    .setSortChain(
      next.map((e) => ({ column: e.key, dir: e.dir, ...(e.nulls ? { nulls: e.nulls } : {}) })),
    );
}

/** the WHERE body the active browse tab's queries actually use (null = none) */
export function browseWhere(): string | null {
  const st = useBrowser.getState();
  return compiledWhere(st.filters, st.whereMode === "raw" ? st.rawWhere : null);
}
