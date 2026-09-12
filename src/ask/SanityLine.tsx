// Sanity line (AGENT-UX section 4): status register, `·`-separated fragments.
// A warning fragment carries the warning glyph (icon-sm) and tier-1 contrast;
// the rest sits at tier 2. Every fragment is a button that shows the probe
// that produced it. The host omits the line when no probe ran.

import { Fragment } from "react";
import { TriangleAlert } from "lucide-react";
import type { SanityFragment } from "../agent/types";

export interface SanityLineProps {
  fragments: SanityFragment[];
  /** fragment index clicked: the host opens the trace at the matching probe */
  onShowProbe: (index: number) => void;
}

export function SanityLine({ fragments, onShowProbe }: SanityLineProps) {
  if (fragments.length === 0) return null;
  return (
    <div className="ans-status">
      {fragments.map((f, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true">·</span>}
          <button
            type="button"
            className={`frag${f.warn ? " warn" : ""}`}
            onClick={() => onShowProbe(i)}
          >
            {f.warn && <TriangleAlert size={12} />}
            {f.text}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
