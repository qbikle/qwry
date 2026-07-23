// The exit ceremony shared by Quit (menu ⌘Q, window close) and the updater's
// relaunch — both are process deaths: flush the debounced tab persist so the
// last keystrokes hit disk, then confirm any loss the death would cause
// (staged cell edits, a half-typed draft row, open transactions — those roll
// back, and never silently).
import { openTxCount, useConnections } from "./connections";

/** true = clear to exit; false = the user kept the app's state alive */
export async function prepareExit(verb: "Quit" | "Update"): Promise<boolean> {
  const { flushTabs } = await import("./tabs");
  await flushTabs();
  const [{ useEdits }, { useBrowser, draftHasContent }] = await Promise.all([
    import("./edits"),
    import("./browser"),
  ]);
  const dirty = Object.values(useEdits.getState().byTab).reduce(
    (n, t) => n + Object.keys(t.pending).length,
    0,
  );
  const draft = Object.values(useBrowser.getState().byTab).some((t) =>
    draftHasContent(t.draftRow),
  );
  const txn = useConnections.getState().profiles.reduce((n, p) => n + openTxCount(p.id), 0);
  if (dirty === 0 && !draft && txn === 0) return true;
  const { confirmDanger } = await import("./danger");
  return confirmDanger(
    dirty > 0
      ? `${verb} with ${dirty} Uncommitted Edit${dirty === 1 ? "" : "s"}?`
      : draft
        ? `${verb} with an Unfinished New Row?`
        : `${verb} with ${txn} Open Transaction${txn === 1 ? "" : "s"}?`,
    [
      dirty > 0 || draft
        ? "Staged changes are not written to the database and will be lost."
        : null,
      txn > 0
        ? `Open transaction${txn === 1 ? "" : "s"} on ${txn} tab${txn === 1 ? "" : "s"} will be rolled back.`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
    verb,
  );
}
