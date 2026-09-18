import { useState } from "react";
import { useRefresh } from "../stores/refresh";

/** ⇧⌘R's one band (E2 R2, DESIGN.md rule 6). It plays at once and always,
 * even when the connection turns out dead: it says "a hard refresh started",
 * never "it worked" — the surfaces it crosses are the verdict. Keyed by
 * sweepSeq so a second chord restarts the travel instead of joining it, and
 * unmounted again when the band has left the window. */
export function RefreshSweep() {
  const seq = useRefresh((s) => s.sweepSeq);
  const [spent, setSpent] = useState(0);
  if (seq === 0 || seq === spent) return null;
  return (
    <div className="v2-sweep" aria-hidden="true">
      <span key={seq} className="v2-sweep-band" onAnimationEnd={() => setSpent(seq)} />
    </div>
  );
}
