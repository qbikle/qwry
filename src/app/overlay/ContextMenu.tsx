// Declarative, keyboard-navigable context menu built on the overlay primitive.
// Supports one level of submenus (Copy ▸ formats). Keyboard nav runs through
// the overlay stack's topmost-only `onKey`, so it never fights background
// handlers and stacked menus stay coherent. Mouse + keyboard both work.
//
//   ↑/↓ move · → / Enter open submenu or activate · ← close submenu · Esc close
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { menuIn } from "../../design/springs";
import { AnchoredOverlay } from "./Overlay";
import { MAX_OVERLAY_Z } from "./escStack";
import "./contextmenu.css";

export type MenuNode =
  | {
      kind: "item";
      label: string;
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: "submenu"; label: string; items: MenuNode[] }
  | { kind: "sep" };

/** indices of focusable nodes (items that aren't disabled, + submenus) */
function selectable(items: MenuNode[]): number[] {
  const out: number[] = [];
  items.forEach((it, i) => {
    if (it.kind === "submenu") out.push(i);
    else if (it.kind === "item" && !it.disabled) out.push(i);
  });
  return out;
}

function step(sel: number[], current: number, dir: number): number {
  if (sel.length === 0) return current;
  const idx = sel.indexOf(current);
  const next = idx < 0 ? 0 : (idx + dir + sel.length) % sel.length;
  return sel[next];
}

export function ContextMenu({
  point,
  items,
  onClose,
  layerClassName,
}: {
  point: { x: number; y: number };
  items: MenuNode[];
  onClose: () => void;
  layerClassName?: string;
}) {
  const sel = selectable(items);
  const [active, setActive] = useState<number>(sel[0] ?? -1);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [subActive, setSubActive] = useState(0);
  const [subPoint, setSubPoint] = useState<{ x: number; y: number; leftEdge: number } | null>(
    null,
  );
  const itemEls = useRef<(HTMLDivElement | null)[]>([]);

  const subItems =
    openSub !== null && items[openSub]?.kind === "submenu"
      ? (items[openSub] as { items: MenuNode[] }).items
      : [];
  const subSel = selectable(subItems);

  const openSubmenu = (i: number) => {
    setOpenSub(i);
    setActive(i);
    setSubActive(selectable((items[i] as { items: MenuNode[] }).items)[0] ?? 0);
  };

  // anchor the submenu to the right edge of its parent item
  useLayoutEffect(() => {
    if (openSub === null) {
      setSubPoint(null);
      return;
    }
    const el = itemEls.current[openSub];
    if (el) {
      const r = el.getBoundingClientRect();
      setSubPoint({ x: r.right - 3, y: r.top - 5, leftEdge: r.left });
    }
  }, [openSub]);

  // long menus scroll — keyboard nav must keep the active row visible
  useEffect(() => {
    itemEls.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const activate = (node: MenuNode | undefined) => {
    if (node?.kind === "item" && !node.disabled) {
      node.onSelect();
      onClose();
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const stop = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    if (openSub !== null) {
      // the submenu filter input owns the keyboard while focused — the parent's
      // nav state indexes the UNFILTERED list, so Enter here would activate
      // whatever sat at the stale index instead of the visible match
      const ae = document.activeElement;
      if (ae instanceof HTMLElement && ae.classList.contains("ctx-search")) return;
      if (e.key === "ArrowDown") {
        stop();
        setSubActive((c) => step(subSel, c, 1));
      } else if (e.key === "ArrowUp") {
        stop();
        setSubActive((c) => step(subSel, c, -1));
      } else if (e.key === "ArrowLeft") {
        stop();
        setOpenSub(null);
      } else if (e.key === "Enter") {
        stop();
        activate(subItems[subActive]);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      stop();
      setActive((c) => step(sel, c, 1));
    } else if (e.key === "ArrowUp") {
      stop();
      setActive((c) => step(sel, c, -1));
    } else if (e.key === "ArrowRight" || e.key === "Enter") {
      const node = items[active];
      if (node?.kind === "submenu") {
        stop();
        openSubmenu(active);
      } else if (node?.kind === "item") {
        stop();
        activate(node);
      }
    }
  };

  return (
    <AnchoredOverlay
      point={point}
      onClose={onClose}
      onKey={onKey}
      layerClassName={layerClassName}
    >
      {(layerZ) => (
        <>
          <motion.div
            className="ctx-menu"
            role="menu"
            {...menuIn}
            // the submenu anchor is a one-shot rect — scrolling the parent
            // would leave it floating detached, so close it instead
            onScroll={() => setOpenSub(null)}
          >
            {items.map((it, i) => {
              if (it.kind === "sep") return <div key={i} className="ctx-sep" />;
              const isSub = it.kind === "submenu";
              const danger = it.kind === "item" && it.danger;
              const disabled = it.kind === "item" && it.disabled;
              const hot = i === active && (openSub === null || openSub === i);
              return (
                <div
                  key={i}
                  ref={(el) => {
                    itemEls.current[i] = el;
                  }}
                  className={`ctx-item${hot ? " hot" : ""}${danger ? " danger" : ""}${disabled ? " disabled" : ""}`}
                  role="menuitem"
                  aria-disabled={disabled || undefined}
                  aria-haspopup={isSub || undefined}
                  onMouseEnter={() => {
                    if (disabled) return;
                    setActive(i);
                    if (isSub) openSubmenu(i);
                    else setOpenSub(null);
                  }}
                  // keep the menu focusless (WKWebView buttons grab focus oddly)
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (disabled) return;
                    if (isSub) openSubmenu(i);
                    else activate(it);
                  }}
                >
                  <span className="ctx-label">{it.label}</span>
                  {it.kind === "item" && it.hint && (
                    <span className="ctx-hint">{it.hint}</span>
                  )}
                  {isSub && (
                    <span className="ctx-arrow">
                      <ChevronRight size={13} />
                    </span>
                  )}
                </div>
              );
            })}
          </motion.div>

          {openSub !== null && subPoint && (
            <SubPanel
              point={subPoint}
              items={subItems}
              active={subActive}
              // above the parent layer's full-screen catcher (dynamic z from the
              // overlay stack) or the submenu is mouse-dead; ties at the ceiling
              // resolve by DOM order — the portal mounts after the layer
              z={layerZ != null ? Math.min(layerZ + 1, MAX_OVERLAY_Z) : undefined}
              onHover={setSubActive}
              onActivate={activate}
            />
          )}
        </>
      )}
    </AnchoredOverlay>
  );
}

/** A submenu panel — positioned + clamped, but no backdrop/stack of its own;
 *  the parent ContextMenu owns close + keyboard. Portaled above the parent. */
function SubPanel({
  point,
  items,
  active,
  z,
  onHover,
  onActivate,
}: {
  point: { x: number; y: number; leftEdge: number };
  items: MenuNode[];
  active: number;
  /** parent layer z + 1 — must beat the parent's full-screen click catcher */
  z?: number;
  onHover: (i: number) => void;
  onActivate: (node: MenuNode) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // custom positioning: stay ATTACHED to the parent item's right edge and
  // SLIDE vertically to fit — the generic clamp's edge-flip sent a tall panel
  // way above the item, visually detached from what opened it
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const M = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left =
      point.x + w <= window.innerWidth - M
        ? point.x
        : Math.max(M, point.leftEdge - w + 3); // no room right → left of the menu
    const top = Math.max(M, Math.min(point.y, window.innerHeight - h - M));
    setPos({ left, top });
  }, [point, items.length]);
  const rowEls = useRef<(HTMLDivElement | null)[]>([]);
  const [query, setQuery] = useState("");
  const searchEl = useRef<HTMLInputElement>(null);
  // scrollIntoView must clear the sticky search input or keyboard nav hides
  // the active row under it — measured (zoom-safe), ~34px incl. margins
  const [stickyH, setStickyH] = useState(34);

  // a "Referenced by" on user_id can list dozens of tables — filter + scroll
  const itemCount = items.filter((it) => it.kind === "item").length;
  const searchable = itemCount > 12;

  useLayoutEffect(() => {
    if (searchEl.current) setStickyH(searchEl.current.offsetHeight + 6);
  }, [searchable]);
  const q = query.trim().toLowerCase();
  const visible: [MenuNode, number][] = items
    .map((it, i): [MenuNode, number] => [it, i])
    .filter(
      ([it]) =>
        !q || (it.kind === "item" && it.label.toLowerCase().includes(q)),
    );

  useEffect(() => {
    rowEls.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return createPortal(
    <div
      ref={ref}
      className="ctx-subpanel"
      style={{
        position: "fixed",
        left: pos?.left ?? point.x,
        top: pos?.top ?? point.y,
        visibility: pos ? "visible" : "hidden",
        zIndex: z,
      }}
    >
      <motion.div className="ctx-menu" role="menu" {...menuIn}>
        {searchable && (
          <input
            ref={searchEl}
            className="ctx-search"
            placeholder={`Filter ${itemCount}…`}
            value={query}
            autoFocus
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // portals bubble through the REACT tree — without this, typing
              // here reaches the grid underneath and seeds a cell editor
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                const first = visible.find(([it]) => it.kind === "item");
                if (first) onActivate(first[0]);
              }
            }}
          />
        )}
        {visible.map(([it, i]) => {
          if (it.kind === "sep") return <div key={i} className="ctx-sep" />;
          // submenus only nest items/sep (one level)
          if (it.kind !== "item") return null;
          return (
            <div
              key={i}
              ref={(el) => {
                rowEls.current[i] = el;
              }}
              className={`ctx-item${i === active ? " hot" : ""}${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}`}
              style={searchable ? { scrollMarginTop: stickyH } : undefined}
              role="menuitem"
              aria-disabled={it.disabled || undefined}
              onMouseEnter={() => !it.disabled && onHover(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => !it.disabled && onActivate(it)}
            >
              <span className="ctx-label">{it.label}</span>
              {it.hint && <span className="ctx-hint">{it.hint}</span>}
            </div>
          );
        })}
        {q && visible.every(([it]) => it.kind !== "item") && (
          <div className="ctx-empty">no matches</div>
        )}
      </motion.div>
    </div>,
    document.body,
  );
}
