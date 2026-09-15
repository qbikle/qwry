// One clipboard write path with visible feedback: copies used to be
// silent app-wide (an accidental schema-tree click silently overwrites the
// clipboard) and failures indistinguishable from empty clipboards. Fire the
// cue event either way; CopyToast renders it.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

export function copyCueShow(label: string) {
  window.dispatchEvent(new CustomEvent("qwry:copy-cue", { detail: label }));
}

/** write to the clipboard and flash a cue ("Copied" / "copy failed").
 * Resolves true only when the write landed; follow-up honesty notes
 * (truncation flashes etc.) must not fire on a failed copy. */
export function copyCue(text: string, label = "Copied"): Promise<boolean> {
  return writeText(text).then(
    () => {
      copyCueShow(label);
      return true;
    },
    () => {
      copyCueShow("copy failed");
      return false;
    },
  );
}

/** the cue an action that FAILED shows: its error's first line, in the status
 * register, so a refused write says so instead of the surface snapping back
 * with nothing (LESSONS 9). One helper rather than a firstLine copy per call
 * site; `.catch(copyCueError)` is the whole idiom. */
export function copyCueError(e: unknown): void {
  const line = String((e as { message?: string })?.message ?? e)
    .split("\n")[0]
    .trim();
  copyCueShow(line || "the write failed");
}
