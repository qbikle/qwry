// Assumption chips (AGENT-UX section 3): Chip / pill toggle species, one per
// interpretation the agent made. The row leads with `Assumed` (tier 2, inline)
// and the chips wrap onto further lines; a long label grows its pill downward
// (ask.css .chip: min-height, normal white-space), never clipping or
// scrolling. `aria-pressed` = active = in effect. Toggling re-runs through the
// store; the chips are disabled while a run is in flight. Labels arrive in
// the control register (Title Case, at most six words: the prompt asks the
// model for that). The host omits the whole row when there are no chips.

import { Check } from "lucide-react";
import type { Assumption } from "../agent/types";

export interface AssumptionChipsProps {
  assumptions: Assumption[];
  /** a run is in flight on this thread: chips render but cannot be toggled */
  disabled: boolean;
  onToggle: (chipId: string) => void;
}

export function AssumptionChips({ assumptions, disabled, onToggle }: AssumptionChipsProps) {
  if (assumptions.length === 0) return null;
  return (
    <div className="ans-chips">
      <span className="ans-chips-lbl">Assumed</span>
      {assumptions.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`chip${a.active ? " active" : ""}`}
          aria-pressed={a.active}
          disabled={disabled}
          onClick={() => onToggle(a.id)}
        >
          <Check size={12} />
          {a.label}
        </button>
      ))}
    </div>
  );
}
