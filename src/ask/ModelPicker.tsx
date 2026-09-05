// Provider and model picker (AGENT-UX section 8): the pill in the composer's
// control row (short model name + chevron; `small` alone badges it, the one
// tier that changes what Ask can do) and its popover, grouped by provider,
// opening UPWARD from the pill. The popover is an AnchoredOverlay
// (app/overlay): portaled, registered on escStack so Esc and an outside click
// close it, clamped to the viewport, keyboard-navigable through the stack's
// topmost-only onKey like ContextMenu. Rows are name · optional context hint
// · tier badge; the badge word is the whole explanation (DESIGN rule 11), so
// nothing here describes a tier and an unverified model wears the tier the
// loop gates it at. The context hint prints only under CTX_NORM: the norm is
// silent, the one window a schema prompt presses against speaks.
// Keys never appear here; `Manage Models…` hands off to Settings › Models.
// Picking a row writes the per-connection default (useSettings.setAgentConnModel),
// and the app default too when none exists yet, so modelChoice() resolves at once.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, ChevronDown } from "lucide-react";
import { AnchoredOverlay } from "../app/overlay/Overlay";
import { menuIn } from "../design/springs";
import type { Tier } from "../agent/providers/registry";
import type { ProviderId } from "../agent/providers/types";
import { useSettings } from "../stores/settings";
import {
  contextHint,
  groupsFrom,
  initialGroups,
  loadSourceState,
  modelLabel,
  tierFor,
  type ModelChoice,
  type ProviderGroup,
} from "./modelSources";

export { modelLabel } from "./modelSources";

export interface ModelPickerProps {
  profileId: string;
  /** the resolved choice for this connection, null when none is configured */
  choice: ModelChoice | null;
  open: boolean;
  /** the pane is not connected: the pill dims with the composer */
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  /** `Manage Models…` */
  onManage: () => void;
}

/** the popover hangs 4px above the pill; the pill's top edge is the anchor */
const POP_GAP = 4;

/** windows at or above this are the norm and print no hint; `8k ctx` stays */
const CTX_NORM = 32_768;

/** the tier in the WRITING data-state register: lowercase word, one tint
 * per tier (small warn, mid accent, large ok) */
function TierBadge({ tier }: { tier: Tier }) {
  return (
    <span
      className={`badge picker-tier ${tier}${tier === "large" ? " badge-ok" : tier === "mid" ? " badge-accent" : ""}`}
    >
      {tier}
    </span>
  );
}

/** one keyboard-reachable row of the popover, in visual order */
interface Entry {
  key: string;
  run: () => void;
}

export function ModelPicker({
  profileId,
  choice,
  open,
  disabled = false,
  onOpenChange,
  onManage,
}: ModelPickerProps) {
  const tier = choice ? tierFor(choice).tier : null;
  const btnRef = useRef<HTMLButtonElement>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [groups, setGroups] = useState<ProviderGroup[]>(() => initialGroups(choice));
  const [hot, setHot] = useState(0);

  // anchor at the pill's top-left corner, measured the frame it opens; the
  // popover grows upward from there (.picker-anchor). The registry groups
  // paint at once and the Keychain + runtime answers replace them when they
  // land (a closed popover discards a late answer)
  useLayoutEffect(() => {
    if (!open) {
      setPoint(null);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPoint({ x: r.left, y: r.top - POP_GAP });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setGroups(initialGroups(choice));
    void loadSourceState().then((state) => {
      if (live) setGroups(groupsFrom(state, choice));
    });
    return () => {
      live = false;
    };
    // choice identity changes only through this picker or Settings, both of
    // which close it first; re-reading it here would re-probe on every pick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => onOpenChange(false);
  const manage = () => {
    close();
    onManage();
  };
  const select = (providerId: ProviderId, model: string) => {
    const s = useSettings.getState();
    s.setAgentConnModel(profileId, providerId, model);
    if (!s.agentProvider || !s.agentModel) s.setAgentModel(providerId, model);
    close();
  };

  // keyboard order = visual order: every model row
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const g of groups) {
      for (const r of g.rows) out.push({ key: `${g.id}:${r.id}`, run: () => select(g.id, r.id) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, profileId]);
  const activeKey = choice ? `${choice.providerId}:${choice.model}` : null;
  useEffect(() => {
    if (!open) return;
    const i = entries.findIndex((e) => e.key === activeKey);
    setHot(i >= 0 ? i : 0);
  }, [open, entries, activeKey]);

  const onKey = (e: KeyboardEvent) => {
    const stop = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const n = entries.length;
    if (e.key === "ArrowDown") {
      stop();
      if (n) setHot((h) => (h + 1) % n);
    } else if (e.key === "ArrowUp") {
      stop();
      if (n) setHot((h) => (h - 1 + n) % n);
    } else if (e.key === "Home") {
      stop();
      setHot(0);
    } else if (e.key === "End") {
      stop();
      setHot(Math.max(0, n - 1));
    } else if (e.key === "Enter") {
      stop();
      entries[hot]?.run();
    }
  };

  let index = -1;
  return (
    <>
      <button
        ref={btnRef}
        className={`picker${open ? " active" : ""}`}
        title="Model"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        <span className="picker-model">{modelLabel(choice)}</span>
        {tier === "small" && <TierBadge tier={tier} />}
        <ChevronDown size={12} />
      </button>

      {open && point && (
        <AnchoredOverlay point={point} onClose={close} onKey={onKey} role="menu" label="Model">
          <div className="picker-anchor">
            <motion.div
              className="picker-pop"
              {...menuIn}
              // focusless like ContextMenu: focus stays where it was (WKWebView
              // buttons grab focus oddly) and escStack restores it on close
              onMouseDown={(e) => e.preventDefault()}
            >
              {groups.map((g) => (
                <Fragment key={g.id}>
                  <div className="picker-group">{g.title}</div>
                  {g.rows.map((row) => {
                    const i = ++index;
                    const on = choice?.providerId === g.id && choice.model === row.id;
                    const ctx = row.contextWindow < CTX_NORM ? contextHint(row.contextWindow) : "";
                    return (
                      <button
                        key={row.id}
                        className={`picker-item${on ? " active" : ""}${hot === i ? " hot" : ""}`}
                        role="menuitemradio"
                        aria-checked={on}
                        onMouseEnter={() => setHot(i)}
                        onClick={() => select(g.id, row.id)}
                      >
                        {on ? <Check size={12} /> : <span className="picker-check" />}
                        <span className="picker-label">{row.label}</span>
                        <span className="ask-grow" />
                        {ctx && <span className="picker-ctx">{ctx}</span>}
                        <TierBadge tier={row.tier} />
                      </button>
                    );
                  })}
                </Fragment>
              ))}
              <div className="picker-foot">
                <button className="linkish" onClick={manage}>
                  Manage Models…
                </button>
              </div>
            </motion.div>
          </div>
        </AnchoredOverlay>
      )}
    </>
  );
}
