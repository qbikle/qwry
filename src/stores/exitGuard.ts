// The exit ceremony shared by Quit (menu ⌘Q, window close) and the updater's
// relaunch — both are process deaths: flush the debounced tab persist so the
// last keystrokes hit disk, then confirm any loss the death would cause
// (staged cell edits, a half-typed draft row, open transactions — those roll
// back, and never silently).
import { openTxCount, useConnections } from "./connections";

/** what a process death would cost right now — returned on confirm so a
 * second guard can auto-pass when nothing new appeared in between */
export interface ExitCensus {
  dirty: number;
  draft: boolean;
  txn: number;
}

/** census = clear to exit (the user confirmed, or nothing to lose);
 * null = the user kept the app's state alive. Pass a prior confirmed
 * census to re-prompt ONLY if the stakes grew since — confirming a loss
 * doesn't discard anything, so an unchanged census must not re-ask the
 * identical question. */
export async function prepareExit(
  verb: "Quit" | "Update",
  prior?: ExitCensus | null,
): Promise<ExitCensus | null> {
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
  const census: ExitCensus = { dirty, draft, txn };
  if (dirty === 0 && !draft && txn === 0) return census;
  if (prior && dirty <= prior.dirty && (prior.draft || !draft) && txn <= prior.txn) {
    return census;
  }
  const { confirmDanger } = await import("./danger");
  const ok = await confirmDanger(
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
  return ok ? census : null;
}
