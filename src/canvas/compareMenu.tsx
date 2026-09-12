// `Compare With ▸` (A3 item 5): the picker that names the second connection a
// result block's statement is run against. It is a MENU ROW, not a button,
// because the block's cluster settled at five hot and a sixth would have put
// a column name under the fade at the 640 floor; and because its picker was
// always going to be a menu, and `More` is already one (DECISIONS, A3).
//
// Reuses the app's own context-menu primitive (src/app/overlay/ContextMenu),
// which is where every other one-level submenu in the window lives: the rows
// carry a label, a hint and an arrow and no icon, so lucide `GitCompare` is
// never drawn (contextmenu.css). The compared sibling wears a check in the
// hint slot, and picking the checked one clears the comparison, so the row
// that turned the diff face on is the row that turns it off.
//
// The list is the connection's SIBLINGS and comes from the store that runs
// the comparison (`compareTargets`), so the picker and the run cannot
// disagree about what a sibling is: every other saved connection, prod
// included, because `agent_run_readonly` refuses anything but a SELECT and
// nothing here writes (AGENT-SPEC section 8). With no sibling to compare
// against there is no submenu to open: the row stands disabled, never hidden
// (DESIGN rule 2's matrix), so the action stays discoverable on a
// one-connection machine.
//
// The check rides the row's HINT slot, which is where the app's menu rows
// carry a mark; a check column of its own would be a fourth slot on every
// menu row in the window for one submenu's sake.

import { Check } from "lucide-react";
import type { MenuNode } from "../app/overlay/ContextMenu";
import { compareTargets } from "../stores/canvas";

export interface CompareMenuProps {
  /** the block's own connection: never a sibling of itself */
  profileId: string;
  /** the connection this block is currently compared against, or null */
  comparedTo: string | null;
  /** null clears the comparison and puts the table face back */
  onPick: (profileId: string | null) => void;
}

export function compareWithMenu({ profileId, comparedTo, onPick }: CompareMenuProps): MenuNode {
  const siblings = compareTargets(profileId);
  if (siblings.length === 0) {
    return { kind: "item", label: "Compare With", disabled: true, onSelect: () => {} };
  }
  return {
    kind: "submenu",
    label: "Compare With",
    items: siblings.map((p) => ({
      kind: "item" as const,
      label: p.name,
      hint: p.id === comparedTo ? <Check size={12} /> : undefined,
      onSelect: () => onPick(p.id === comparedTo ? null : p.id),
    })),
  };
}
