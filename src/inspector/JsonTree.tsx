// Collapsible JSON tree — now with ⌘F search (filter + highlight + hit nav)
// and in-place leaf/key editing. Free, unlike some tools.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Search,
  X,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useInspector } from "../stores/inspector";
import {
  CHILD_CAP,
  SEARCH_NODE_CAP,
  capWindow,
  computeSearch,
  hitBase,
  isPathPrefix,
  pid,
  type Json,
  type Path,
  type SearchResult,
} from "./jsonSearch";
import "./inspector.css";

/** human-readable JSON path: a.b[0].c */
/** hand focus back to the inspector shell (next frame — after the editor's
 *  unmount settles) so ⌘F and the global chords keep their inspector scope */
function refocusInspector(from: HTMLElement): void {
  const box = from.closest(".inspector-fixed") as HTMLElement | null;
  if (!box) return;
  requestAnimationFrame(() => box.focus({ preventScroll: true }));
}

function displayPath(p: Path): string {
  let s = "";
  for (const seg of p) {
    if (typeof seg === "number") s += `[${seg}]`;
    else s += s ? `.${seg}` : seg;
  }
  return s || "$";
}

/** immutable set of a value at a path */
function setIn(root: Json, path: Path, val: Json): Json {
  if (path.length === 0) return val;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = root.slice();
    copy[head as number] = setIn(root[head as number], rest, val);
    return copy;
  }
  const obj = root as { [k: string]: Json };
  return { ...obj, [head]: setIn(obj[head as string], rest, val) };
}

/** rename a key of the object at parentPath, preserving order */
function renameKeyIn(root: Json, parentPath: Path, oldKey: string, newKey: string): Json {
  const parent = parentPath.reduce<Json>((acc, k) => {
    if (acc === null || typeof acc !== "object") return acc;
    return (acc as Record<string, Json>)[k as string];
  }, root);
  if (parent === null || typeof parent !== "object" || Array.isArray(parent)) return root;
  // renaming onto an existing key would silently drop that key's value
  if (newKey !== oldKey && Object.prototype.hasOwnProperty.call(parent, newKey)) return root;
  const rebuilt: Record<string, Json> = {};
  for (const [k, v] of Object.entries(parent as Record<string, Json>)) {
    rebuilt[k === oldKey ? newKey : k] = v;
  }
  return setIn(root, parentPath, rebuilt);
}

/** coerce edited text back to the leaf's original primitive type */
function coerce(original: Json, text: string): { ok: true; value: Json } | { ok: false } {
  if (typeof original === "number") {
    if (text.trim() === "") return { ok: false };
    const n = Number(text);
    return Number.isNaN(n) ? { ok: false } : { ok: true, value: n };
  }
  if (typeof original === "boolean") {
    const t = text.trim().toLowerCase();
    if (t !== "true" && t !== "false") return { ok: false };
    return { ok: true, value: t === "true" };
  }
  if (original === null) {
    if (text === "" || text.toLowerCase() === "null") return { ok: true, value: null };
    return { ok: true, value: text };
  }
  return { ok: true, value: text };
}

interface TreeCtx {
  query: string;
  result: SearchResult;
  currentHit: string | null;
  currentHitPath: Path | null;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
  editable: boolean;
  onEditValue: (path: Path, value: Json) => void;
  onRenameKey: (parentPath: Path, oldKey: string, newKey: string) => void;
}

const Ctx = createContext<TreeCtx | null>(null);

function Highlight({ text }: { text: string }) {
  const ctx = useContext(Ctx)!;
  const q = ctx.query;
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="jt-mark">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

function KeyLabel({
  k,
  path,
  parentPath,
  isArrayItem,
}: {
  k: string;
  path: Path;
  parentPath: Path;
  isArrayItem: boolean;
}) {
  const ctx = useContext(Ctx)!;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(k);
  const canEdit = ctx.editable && !isArrayItem;

  if (editing) {
    return (
      <input
        className="jt-edit jt-key-edit"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
          if (e.key === "Enter") {
            refocusInspector(e.currentTarget);
            if (draft && draft !== k) ctx.onRenameKey(parentPath, k, draft);
            setEditing(false);
          }
          if (e.key === "Escape") {
            refocusInspector(e.currentTarget);
            setDraft(k);
            setEditing(false);
          }
        }}
        onBlur={() => {
          if (draft && draft !== k) ctx.onRenameKey(parentPath, k, draft);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <span
      className={`jt-key${canEdit ? " editable" : ""}`}
      title={canEdit ? `${displayPath(path)}\nclick to rename key` : displayPath(path)}
      onClick={
        canEdit
          ? (e) => {
              e.stopPropagation();
              setDraft(k);
              setEditing(true);
            }
          : undefined
      }
    >
      <Highlight text={k} />:
    </span>
  );
}

function Leaf({ value, path }: { value: Json; path: Path }) {
  const ctx = useContext(Ctx)!;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState(false);

  const cls =
    value === null
      ? "jt-null"
      : typeof value === "string"
        ? "jt-str"
        : typeof value === "number"
          ? "jt-num"
          : "jt-bool";
  const display = value === null ? "null" : typeof value === "string" ? value : JSON.stringify(value);

  const begin = () => {
    setDraft(value === null ? "" : typeof value === "string" ? value : String(value));
    setErr(false);
    setEditing(true);
  };
  const commit = (): boolean => {
    const c = coerce(value, draft);
    if (!c.ok) {
      setErr(true);
      return false;
    }
    if (c.value !== value) ctx.onEditValue(path, c.value);
    setEditing(false);
    return true;
  };

  if (editing) {
    return (
      <input
        className={`jt-edit${err ? " err" : ""}`}
        autoFocus
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setErr(false);
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
          if (e.key === "Enter") {
            // refocus only when the edit actually closes — an invalid value
            // keeps the input (and its error state) focused
            const el = e.currentTarget;
            if (commit()) refocusInspector(el);
          }
          if (e.key === "Escape") {
            refocusInspector(e.currentTarget);
            setEditing(false);
          }
        }}
        onBlur={commit}
      />
    );
  }

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.altKey) {
      void writeText(displayPath(path));
      return;
    }
    if (ctx.editable) begin();
    else void writeText(typeof value === "string" ? value : JSON.stringify(value));
  };

  return (
    <span
      className={`${cls}${ctx.editable ? " editable" : ""}`}
      onClick={onClick}
      title={ctx.editable ? "click to edit · ⌥-click copies path" : "click to copy · ⌥-click for path"}
    >
      {typeof value === "string" ? <Highlight text={display} /> : display}
    </span>
  );
}

function Node({
  k,
  value,
  path,
  parentPath,
  isArrayItem,
  depth,
}: {
  k: string | null;
  value: Json;
  path: Path;
  parentPath: Path;
  isArrayItem: boolean;
  depth: number;
}) {
  const ctx = useContext(Ctx)!;
  const id = pid(path);
  const [open, setOpen] = useState(depth < 2);
  // per-container render cap — a 50k-element array must not mount 50k nodes
  const [shown, setShown] = useState(CHILD_CAP);
  // transient growth of a ⌘F hit-revealed window (expander clicks); applies
  // only while the cursor stays in the same block — never pins a giant window
  const [hitExtra, setHitExtra] = useState<{ base: number; prev: number; next: number } | null>(
    null,
  );
  const isContainer = value !== null && typeof value === "object";
  const rowRef = useRef<HTMLDivElement>(null);
  const { registerRef } = ctx;

  useEffect(() => {
    registerRef(id, rowRef.current);
    return () => registerRef(id, null);
    // isContainer is a dep: a container↔leaf morph (edit changed the node
    // kind) swaps the DOM element under the same id — re-register, or ⌘F
    // scroll targets a detached element
  }, [id, registerRef, isContainer]);

  // searching hides non-matching subtrees and force-opens matched ancestors
  if (ctx.query && !ctx.result.visible.has(id)) return null;
  const effectiveOpen = ctx.query ? ctx.result.forceOpen.has(id) || open : open;
  const isHit = ctx.currentHit === id;

  const keyEl =
    k !== null ? (
      <KeyLabel k={k} path={path} parentPath={parentPath} isArrayItem={isArrayItem} />
    ) : null;

  if (isContainer) {
    const isArr = Array.isArray(value);
    const objKeys = isArr ? null : Object.keys(value as Record<string, Json>);
    const total = isArr ? (value as Json[]).length : (objKeys as string[]).length;

    let children: React.ReactNode = null;
    if (effectiveOpen) {
      // candidate child keys — under search, only the visible ones (filtered
      // HERE so hidden children never mount a component at all)
      let keys: (string | number)[];
      if (ctx.query) {
        keys = [];
        if (isArr) {
          for (let i = 0; i < total; i++)
            if (ctx.result.visible.has(pid([...path, i]))) keys.push(i);
        } else {
          for (const ok of objKeys as string[])
            if (ctx.result.visible.has(pid([...path, ok]))) keys.push(ok);
        }
      } else {
        keys = isArr ? Array.from({ length: total }, (_, i) => i) : (objKeys as string[]);
      }

      // ⌘F hit-nav must reach past the cap — re-window to a bounded slice
      // around the hit (never mount the whole prefix up to it)
      let hitIdx: number | null = null;
      const hp = ctx.currentHitPath;
      if (hp && isPathPrefix(path, hp)) {
        const at = keys.indexOf(hp[path.length]);
        if (at >= 0) hitIdx = at;
      }
      const block = hitIdx != null ? hitBase(hitIdx) : null;
      const extra = hitExtra && block != null && hitExtra.base === block ? hitExtra : null;
      const win = capWindow(keys.length, shown, hitIdx, extra?.prev ?? 0, extra?.next ?? 0);
      const shownKeys =
        win.start === 0 && win.end === keys.length ? keys : keys.slice(win.start, win.end);

      children = (
        <div className="jt-children">
          {win.before > 0 && (
            <button
              className="jt-more"
              onClick={(e) => {
                e.stopPropagation();
                if (block != null)
                  setHitExtra({
                    base: block,
                    prev: (extra?.prev ?? 0) + CHILD_CAP,
                    next: extra?.next ?? 0,
                  });
              }}
            >
              Show Previous {Math.min(CHILD_CAP, win.before).toLocaleString()} ·{" "}
              {win.before.toLocaleString()} above
            </button>
          )}
          {shownKeys.map((ck) => (
            <Node
              key={ck}
              k={String(ck)}
              value={
                isArr
                  ? (value as Json[])[ck as number]
                  : (value as Record<string, Json>)[ck as string]
              }
              path={[...path, ck]}
              parentPath={path}
              isArrayItem={isArr}
              depth={depth + 1}
            />
          ))}
          {win.after > 0 && (
            // never silently hide — an explicit expander says what's left
            <button
              className="jt-more"
              onClick={(e) => {
                e.stopPropagation();
                if (win.mode === "hit" && block != null)
                  setHitExtra({
                    base: block,
                    prev: extra?.prev ?? 0,
                    next: (extra?.next ?? 0) + CHILD_CAP,
                  });
                else setShown(win.end + CHILD_CAP);
              }}
            >
              Show Next {Math.min(CHILD_CAP, win.after).toLocaleString()} ·{" "}
              {win.after.toLocaleString()} remaining
            </button>
          )}
        </div>
      );
    }

    return (
      <div className="jt-node">
        <div
          ref={rowRef}
          className={`jt-line${isHit ? " jt-hit" : ""}`}
          onClick={() => setOpen(!open)}
        >
          {effectiveOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {keyEl}
          <span
            className="jt-brace"
            onClick={(e) => {
              e.stopPropagation();
              if (e.altKey) void writeText(displayPath(path));
              else void writeText(JSON.stringify(value, null, 2));
            }}
          >
            {isArr ? `[${total}]` : `{${total}}`}
          </span>
        </div>
        {children}
      </div>
    );
  }

  return (
    <div ref={rowRef} className={`jt-line jt-leaf${isHit ? " jt-hit" : ""}`}>
      <span className="jt-pad" />
      {keyEl}
      <Leaf value={value} path={path} />
    </div>
  );
}

export function JsonTree({
  json,
  editable = false,
  onChange,
}: {
  json: Json;
  editable?: boolean;
  onChange?: (next: Json) => void;
}) {
  const [input, setInput] = useState("");
  /** debounced copy of `input` — the walk runs on this, not per keystroke */
  const [query, setQuery] = useState("");
  const [hitIdx, setHitIdx] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());

  // search debounce (120ms); clearing applies instantly
  useEffect(() => {
    if (input === "") {
      setQuery("");
      setHitIdx(0);
      return;
    }
    const t = setTimeout(() => {
      setQuery(input);
      setHitIdx(0);
    }, 120);
    return () => clearTimeout(t);
  }, [input]);

  const result = useMemo(() => computeSearch(json, query), [json, query]);
  const hits = result.hits;

  // clamp hit cursor when the result set changes
  useEffect(() => {
    setHitIdx((i) => (hits.length === 0 ? 0 : Math.min(i, hits.length - 1)));
  }, [hits.length]);

  const currentHit = query && hits.length > 0 ? hits[hitIdx] : null;
  const currentHitPath = useMemo(
    () => (currentHit ? (JSON.parse(currentHit) as Path) : null),
    [currentHit],
  );

  // scroll the active hit into view
  useEffect(() => {
    if (!currentHit) return;
    refs.current.get(currentHit)?.scrollIntoView({ block: "nearest" });
  }, [currentHit]);

  // ⌘F focuses the search box — but ONLY when the user is already in the
  // inspector; a mounted JSON cell must not steal ⌘F from the editor/grid
  // (the search input stays clickable as the mouse entry point).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        // never claim ⌘F from inside the collapsed (invisible) panel
        if (!useInspector.getState().open) return;
        const within = (el: unknown) =>
          el instanceof Element && !!el.closest(".inspector-fixed");
        if (!within(e.target) && !within(document.activeElement)) return;
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const step = (dir: 1 | -1) => {
    if (hits.length === 0) return;
    setHitIdx((i) => (i + dir + hits.length) % hits.length);
  };

  const registerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  }, []);

  const ctx: TreeCtx = {
    query,
    result,
    currentHit,
    currentHitPath,
    registerRef,
    editable,
    onEditValue: (path, value) => onChange?.(setIn(json, path, value)),
    onRenameKey: (parentPath, oldKey, newKey) =>
      onChange?.(renameKeyIn(json, parentPath, oldKey, newKey)),
  };

  return (
    <div className="json-tree">
      <div className="jt-search">
        <Search size={12} className="jt-search-icon" />
        <input
          ref={searchRef}
          placeholder="Search keys and values… ⌘F"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
            if (e.key === "Escape") {
              // first Esc clears; second hands focus back to the tree so
              // grid/global keys work again without a mouse trip
              if (input) setInput("");
              else refocusInspector(e.currentTarget);
            }
          }}
        />
        {input && (
          <>
            <span className="jt-hitcount">
              {/* debounce pending — the walk hasn't run for THIS input yet;
                  showing the previous query's count would be a lie */}
              {input !== query ? "…" : hits.length === 0 ? "0/0" : `${hitIdx + 1}/${hits.length}`}
            </span>
            <button className="iconbtn jt-nav" title="Previous ⇧↩" onClick={() => step(-1)}>
              <ArrowUp size={12} />
            </button>
            <button className="iconbtn jt-nav" title="Next ↩" onClick={() => step(1)}>
              <ArrowDown size={12} />
            </button>
            <button className="iconbtn jt-nav" title="Clear" onClick={() => setInput("")}>
              <X size={12} />
            </button>
          </>
        )}
      </div>
      {query !== "" && result.capped && (
        <div className="jt-capnote">
          search capped at {SEARCH_NODE_CAP.toLocaleString()} nodes · matches beyond may be
          missing
        </div>
      )}
      {/* rows scroll in their own container so the search bar is a fixed
          header by STRUCTURE — the sticky+mask approach fought the body's
          padding and let rows paint above the bar */}
      <div className="jt-scroll">
        <Ctx.Provider value={ctx}>
          <Node k={null} value={json} path={[]} parentPath={[]} isArrayItem={false} depth={0} />
        </Ctx.Provider>
      </div>
    </div>
  );
}
