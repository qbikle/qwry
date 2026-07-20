// flash a read-only reason (or any honesty note) through the status bar's
// existing message slot — double-click/Enter/type-to-edit on an uneditable
// cell must never no-op mute. Shared by the grid and the record view.
import { useEdits } from "../stores/edits";

let reasonTimer: ReturnType<typeof setTimeout> | undefined;
/** the message currently flashed from here — an informational note, never a
 * failure (the slot's other writers are real errors, plus the grid's
 * "building copy…" progress prefix) */
let flashedNote: string | null = null;

export function flashReadOnlyReason(msg: string) {
  flashedNote = msg;
  useEdits.setState({ lastError: msg });
  clearTimeout(reasonTimer);
  reasonTimer = setTimeout(() => {
    if (useEdits.getState().lastError === msg) useEdits.setState({ lastError: null });
    if (flashedNote === msg) flashedNote = null;
  }, 2500);
}

/** classify the slot's current message so notes/progress never render in the
 * danger-red error styling */
export function lastErrorKind(msg: string): "error" | "note" | "progress" {
  if (msg.startsWith("building copy…")) return "progress";
  if (msg === flashedNote) return "note";
  return "error";
}
