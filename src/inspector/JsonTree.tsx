// Collapsible JSON tree — now with ⌘F search (filter + highlight + hit nav)
// and in-place leaf/key editing. Free, unlike some tools.
import {
  createContext,
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
import "./inspector.css";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Path = (string | number)[];

/** stable unique id for a node (used for visibility/refs/hit cursor) */
const pid = (p: Path) => JSON.stringify(p);

/** human-readable JSON path: a.b[0].c */
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

interface SearchResult {
  visible: Set<string>;
  forceOpen: Set<string>;
  hits: string[];
}

function computeSearch(json: Json, query: string): SearchResult {
  const q = query.toLowerCase();
  const visible = new Set<string>();
  const forceOpen = new Set<string>();
  const hits: string[] = [];
  if (!q) return { visible, forceOpen, hits };

  // `forced` = an ancestor key matched, so this whole subtree stays visible
  function walk(value: Json, path: Path, key: string | number | null, forced: boolean): boolean {
    const id = pid(path);
    const keyMatch = key !== null && String(key).toLowerCase().includes(q);
    const isObj = value !== null && typeof value === "object";

    if (keyMatch) hits.push(id);

    let childMatch = false;
    if (isObj) {
      const entries = Array.isArray(value)
        ? value.map((v, i) => [i, v] as const)
        : Object.entries(value as Record<string, Json>);
      for (const [ck, cv] of entries) {
        if (walk(cv as Json, [...path, ck], ck, forced || keyMatch)) childMatch = true;
      }
    }

    let valMatch = false;
    if (!isObj) {
      const s = value === null ? "null" : String(value);
      valMatch = s.toLowerCase().includes(q);
      if (valMatch && !keyMatch) hits.push(id);
    }

    const selfMatch = keyMatch || valMatch;
    if (forced || selfMatch || childMatch) {
      visible.add(id);
      // open this container if a descendant matched, or to reveal a matched
      // key's own subtree
      if (isObj && (childMatch || keyMatch || forced)) forceOpen.add(id);
      return true;
    }
    return false;
  }
  walk(json, [], null, false);
  return { visible, forceOpen, hits };
}

interface TreeCtx {
  query: string;
  result: SearchResult;
  currentHit: string | null;
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
          e.stopPropagation();
          if (e.key === "Enter") {
            if (draft && draft !== k) ctx.onRenameKey(parentPath, k, draft);
            setEditing(false);
          }
          if (e.key === "Escape") {
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
  const commit = () => {
    const c = coerce(value, draft);
    if (!c.ok) {
      setErr(true);
      return;
    }
    if (c.value !== value) ctx.onEditValue(path, c.value);
    setEditing(false);
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
          e.stopPropagation();
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
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
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ctx.registerRef(id, rowRef.current);
    return () => ctx.registerRef(id, null);
  });

  // searching hides non-matching subtrees and force-opens matched ancestors
  if (ctx.query && !ctx.result.visible.has(id)) return null;
  const isContainer = value !== null && typeof value === "object";
  const effectiveOpen = ctx.query ? ctx.result.forceOpen.has(id) || open : open;
  const isHit = ctx.currentHit === id;

  const keyEl =
    k !== null ? (
      <KeyLabel k={k} path={path} parentPath={parentPath} isArrayItem={isArrayItem} />
    ) : null;

  if (isContainer) {
    const isArr = Array.isArray(value);
    const entries = isArr
      ? (value as Json[]).map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, Json>);
    return (
      <div className="jt-node">
        <div
          ref={rowRef}
          className={`jt-line${isHit ? " jt-hit" : ""}`}
          onClick={() => setOpen(!open)}
        >
          {effectiveOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {keyEl}
          <span
            className="jt-brace"
            onClick={(e) => {
              e.stopPropagation();
              if (e.altKey) void writeText(displayPath(path));
              else void writeText(JSON.stringify(value, null, 2));
            }}
          >
            {isArr ? `[${entries.length}]` : `{${entries.length}}`}
          </span>
        </div>
        {effectiveOpen && (
          <div className="jt-children">
            {entries.map(([ck, cv]) => (
              <Node
                key={ck}
                k={ck}
                value={cv}
                path={[...path, isArr ? Number(ck) : ck]}
                parentPath={path}
                isArrayItem={isArr}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
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
  const [query, setQuery] = useState("");
  const [hitIdx, setHitIdx] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());

  const result = useMemo(() => computeSearch(json, query), [json, query]);
  const hits = result.hits;

  // clamp hit cursor when the result set changes
  useEffect(() => {
    setHitIdx((i) => (hits.length === 0 ? 0 : Math.min(i, hits.length - 1)));
  }, [hits.length]);

  const currentHit = query && hits.length > 0 ? hits[hitIdx] : null;

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

  const ctx: TreeCtx = {
    query,
    result,
    currentHit,
    registerRef: (id, el) => {
      if (el) refs.current.set(id, el);
      else refs.current.delete(id);
    },
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
          placeholder="Search keys & values… ⌘F"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHitIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
            if (e.key === "Escape") setQuery("");
          }}
        />
        {query && (
          <>
            <span className="jt-hitcount">
              {hits.length === 0 ? "0/0" : `${hitIdx + 1}/${hits.length}`}
            </span>
            <button className="jt-nav" title="Previous (⇧⏎)" onClick={() => step(-1)}>
              <ArrowUp size={12} />
            </button>
            <button className="jt-nav" title="Next (⏎)" onClick={() => step(1)}>
              <ArrowDown size={12} />
            </button>
            <button className="jt-nav" title="Clear" onClick={() => setQuery("")}>
              <X size={12} />
            </button>
          </>
        )}
      </div>
      <Ctx.Provider value={ctx}>
        <Node k={null} value={json} path={[]} parentPath={[]} isArrayItem={false} depth={0} />
      </Ctx.Provider>
    </div>
  );
}
