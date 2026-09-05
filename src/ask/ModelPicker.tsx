// Provider and model picker (AGENT-UX section 8): the header pill (model
// label + tier badge) and its popover, grouped by provider. The popover is an
// AnchoredOverlay (app/overlay): portaled, registered on escStack so Esc and
// an outside click close it, clamped to the viewport, keyboard-navigable
// through the stack's topmost-only onKey like ContextMenu. The tier badge
// explains itself in a real styled bubble (native title tooltips are
// unreliable in WKWebView, ROADMAP gotcha): one sentence per tier from
// AGENT-SPEC section 3; an unknown model reads mid and says it is unverified.
// The bubble opens on hover AND by keyboard (DESIGN rule 8: what hover reveals
// must be reachable without discovering it): the pill's bubble on the pill's
// focus, a row's bubble when the arrow keys make that row hot. The badge is
// never focusable itself (a tabindex inside a button is invalid HTML, and the
// popover is focusless).
// Keys never appear here; `Manage in Settings › Models…` hands off. Picking a
// row writes the per-connection default (useSettings.setAgentConnModel), and
// the app default too when none exists yet, so modelChoice() resolves at once.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, ChevronDown } from "lucide-react";
import { AnchoredOverlay } from "../app/overlay/Overlay";
import { menuIn } from "../design/springs";
import type { Tier } from "../agent/providers/registry";
import type { ProviderId } from "../agent/providers/types";
import { useSettings } from "../stores/settings";
import {
  TIER_SENTENCE,
  UNVERIFIED_NOTE,
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
  onOpenChange: (open: boolean) => void;
  /** `Manage in Settings › Models…` */
  onManage: () => void;
}

/** matches .picker-pop's width; the popover hangs from the pill's right edge */
const POP_W = 280;

/** The tier badge with its bubble: open on hover, or while `reveal` holds (the
 * keyboard route the owner computes). The bubble is a sibling of the badge and
 * positions against the nearest positioned ancestor (the pill or the menu
 * row), so it never clips against the badge's own box. */
function TierBadge({ tier, known, reveal = false }: { tier: Tier; known: boolean; reveal?: boolean }) {
  const [hover, setHover] = useState(false);
  const show = hover || reveal;
  return (
    <>
      <span
        className={`badge picker-tier ${tier}${tier === "large" ? " badge-ok" : tier === "mid" ? " badge-accent" : ""}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {known ? tier : `${tier}?`}
      </span>
      {show && (
        <span className="picker-bubble" role="tooltip">
          <b>{tier}</b> · {known ? "" : `${UNVERIFIED_NOTE} · `}
          {TIER_SENTENCE[tier]}
        </span>
      )}
    </>
  );
}

/** one keyboard-reachable row of the popover, in visual order */
interface Entry {
  key: string;
  run: () => void;
}

export function ModelPicker({ profileId, choice, open, onOpenChange, onManage }: ModelPickerProps) {
  const tier = choice ? tierFor(choice) : null;
  const btnRef = useRef<HTMLButtonElement>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [groups, setGroups] = useState<ProviderGroup[]>(() => initialGroups(choice));
  const [hot, setHot] = useState(0);
  // the keyboard routes to the tier bubbles (DESIGN rule 8): the pill's opens
  // while the pill holds focus and the popover is closed (open, it would sit
  // under the popover); a row's opens when the arrow keys made it hot, never
  // when the pointer did (a bubble under every hovered row would cover the
  // rows below it)
  const [pillFocus, setPillFocus] = useState(false);
  const [hotByKey, setHotByKey] = useState(false);

  // anchor under the pill's right edge, measured the frame it opens; the
  // registry groups paint at once and the Keychain + runtime answers replace
  // them when they land (a closed popover discards a late answer)
  useLayoutEffect(() => {
    if (!open) {
      setPoint(null);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPoint({ x: r.right - POP_W, y: r.bottom + 4 });
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

  // keyboard order = visual order: every model row, then a group's "Add a Key" row
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const g of groups) {
      for (const r of g.rows) out.push({ key: `${g.id}:${r.id}`, run: () => select(g.id, r.id) });
      if (g.needsKey) out.push({ key: `${g.id}:add`, run: manage });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, profileId]);
  const activeKey = choice ? `${choice.providerId}:${choice.model}` : null;
  useEffect(() => {
    if (!open) return;
    const i = entries.findIndex((e) => e.key === activeKey);
    setHot(i >= 0 ? i : 0);
    setHotByKey(false);
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
      setHotByKey(true);
    } else if (e.key === "ArrowUp") {
      stop();
      if (n) setHot((h) => (h - 1 + n) % n);
      setHotByKey(true);
    } else if (e.key === "Home") {
      stop();
      setHot(0);
      setHotByKey(true);
    } else if (e.key === "End") {
      stop();
      setHot(Math.max(0, n - 1));
      setHotByKey(true);
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
        onClick={() => onOpenChange(!open)}
        onFocus={() => setPillFocus(true)}
        onBlur={() => setPillFocus(false)}
      >
        <span className="picker-model">{modelLabel(choice)}</span>
        {tier && <TierBadge tier={tier.tier} known={tier.known} reveal={pillFocus && !open} />}
        <ChevronDown size={12} />
      </button>

      {open && point && (
        <AnchoredOverlay point={point} onClose={close} onKey={onKey} role="menu" label="Model">
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
                  const ctx = contextHint(row.contextWindow);
                  return (
                    <button
                      key={row.id}
                      className={`picker-item${on ? " active" : ""}${hot === i ? " hot" : ""}`}
                      role="menuitemradio"
                      aria-checked={on}
                      onMouseEnter={() => {
                        setHot(i);
                        setHotByKey(false);
                      }}
                      onClick={() => select(g.id, row.id)}
                    >
                      {on ? <Check size={12} /> : <span className="picker-check" />}
                      <span className="picker-label">{row.label}</span>
                      <span className="ask-grow" />
                      {ctx && <span className="picker-ctx">{ctx}</span>}
                      <TierBadge tier={row.tier} known={row.known} reveal={hotByKey && hot === i} />
                    </button>
                  );
                })}
                {g.needsKey &&
                  (() => {
                    const i = ++index;
                    return (
                      <button
                        className={`picker-item picker-add${hot === i ? " hot" : ""}`}
                        role="menuitem"
                        onMouseEnter={() => {
                          setHot(i);
                          setHotByKey(false);
                        }}
                        onClick={manage}
                      >
                        <span className="picker-check" />
                        Add a Key in Settings…
                      </button>
                    );
                  })()}
              </Fragment>
            ))}
            <div className="picker-foot">
              <button className="linkish" onClick={manage}>
                Manage in Settings › Models…
              </button>
            </div>
          </motion.div>
        </AnchoredOverlay>
      )}
    </>
  );
}
