// flash a read-only reason (or any honesty note) through the status bar's
// existing message slot — double-click/Enter/type-to-edit on an uneditable
// cell must never no-op mute. Shared by the grid and the record view.
import { useEdits } from "../stores/edits";

let reasonTimer: ReturnType<typeof setTimeout> | undefined;

export function flashReadOnlyReason(msg: string) {
  useEdits.setState({ lastError: msg });
  clearTimeout(reasonTimer);
  reasonTimer = setTimeout(() => {
    if (useEdits.getState().lastError === msg) useEdits.setState({ lastError: null });
  }, 2500);
}
