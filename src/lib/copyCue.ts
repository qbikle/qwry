// One clipboard write path with visible feedback — audits found copies were
// silent app-wide (an accidental schema-tree click silently overwrites the
// clipboard) and failures indistinguishable from empty clipboards. Fire the
// cue event either way; CopyToast renders it.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

export function copyCueShow(label: string) {
  window.dispatchEvent(new CustomEvent("qwry:copy-cue", { detail: label }));
}

/** write to the clipboard and flash a cue ("Copied" / "copy failed").
 * Resolves true only when the write landed — follow-up honesty notes
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
