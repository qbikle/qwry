// Assumption chips (AGENT-UX section 3): Chip / pill toggle species, one per
// interpretation the agent made. The row leads with `Assumed` (tier 2, inline)
// and the chips wrap onto further lines; a long label grows its pill downward
// (ask.css .chip: min-height, normal white-space), never clipping or
// scrolling. A click toggles the chip's WANTED state in the store's pending
// set and runs nothing (round 2, finding 3: a click that fired a model run
// took control away from the user); the floating retry pill over the
// composer applies the set on demand. The chip renders its wanted state:
// `aria-pressed` = wanted, the active costume when wanted on, the rest
// costume when wanted off; `data-pending` marks a chip whose wanted state
// differs from the answer's (a test hook, no extra costume). Chips are
// disabled while a run is in flight. Labels arrive in the control register
// (Title Case, at most six words: the prompt asks the model for that). The
// host omits the whole row when there are no chips.

import { Check } from "lucide-react";
import type { Assumption } from "../agent/types";

export interface AssumptionChipsProps {
  assumptions: Assumption[];
  /** wanted states that differ from the answer's (useAgent.pending[exchangeId]) */
  pending?: Record<string, boolean>;
  /** a run is in flight on this thread: chips render but cannot be toggled */
  disabled: boolean;
  /** a chip was clicked: the host flips its pending state (togglePending) */
  onToggle: (chipId: string) => void;
}

export function AssumptionChips({ assumptions, pending, disabled, onToggle }: AssumptionChipsProps) {
  if (assumptions.length === 0) return null;
  return (
    <div className="ans-chips">
      <span className="ans-chips-lbl">Assumed</span>
      {assumptions.map((a) => {
        const wanted = pending?.[a.id] ?? a.active;
        return (
          <button
            key={a.id}
            type="button"
            className={`chip${wanted ? " active" : ""}`}
            aria-pressed={wanted}
            data-pending={wanted !== a.active ? "" : undefined}
            disabled={disabled}
            onClick={() => onToggle(a.id)}
          >
            <Check size={12} />
            {a.label}
          </button>
        );
      })}
    </div>
  );
}
