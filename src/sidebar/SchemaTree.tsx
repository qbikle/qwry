import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  FunctionSquare,
  Globe,
  Grid2x2,
  KeyRound,
  Layers,
  ListChecks,
  ListOrdered,
  Pin,
  Puzzle,
  Table2,
} from "lucide-react";
import { copyCue } from "../lib/copyCue";
import { useResults } from "../stores/results";
import { useTabs } from "../stores/tabs";
import { useConnections } from "../stores/connections";
import {
  useSchema,
  type ColumnInfo,
  type EnumInfo,
  type ExtInfo,
  type FuncInfo,
  type SeqInfo,
  type TableInfo,
} from "../stores/schema";
import { qualify } from "../lib/sqlIdent";
import { ContextMenu, type MenuNode } from "../app/overlay/ContextMenu";
import "./sidebar.css";
import "./sidebar-tree.css";

function fuzzyMatch(needle: string, hay: string): boolean {
  let i = 0;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  for (const ch of h) {
    if (ch === n[i]) i++;
    if (i === n.length) return true;
  }
  return n.length === 0;
}

// icon elements hoisted once — thousands of rows re-creating 2 SVG trees per
// filter keystroke was pure churn (React elements are immutable; reuse is safe)
const SCHEMA_OPEN = <ChevronDown size={12} />;
const SCHEMA_CLOSED = <ChevronRight size={12} />;
const TWIST_OPEN = <ChevronDown size={12} />;
const TWIST_CLOSED = <ChevronRight size={12} />;
const VIEW_ICON = <Eye size={12} className="tree-icon view" />;
const TABLE_ICON = <Table2 size={12} className="tree-icon" />;
const MATVIEW_ICON = <Layers size={12} className="tree-icon matview" />;
const PARTITIONED_ICON = <Grid2x2 size={12} className="tree-icon partitioned" />;
const FOREIGN_ICON = <Globe size={12} className="tree-icon foreign" />;
const FUNC_ICON = <FunctionSquare size={12} className="tree-obj-icon func" />;
const SEQ_ICON = <ListOrdered size={12} className="tree-obj-icon seq" />;
const ENUM_ICON = <ListChecks size={12} className="tree-obj-icon enum" />;
const EXT_ICON = <Puzzle size={12} className="tree-obj-icon ext" />;
const PIN_ICON = <Pin size={12} className="tree-pin-glyph" />;
const PK_ICON = <KeyRound size={12} className="tree-col-pk" />;

/** relkind → glyph: matview/foreign/partitioned read differently at a glance */
function tableIcon(kind: TableInfo["kind"]) {
  switch (kind) {
    case "v":
      return VIEW_ICON;
    case "m":
      return MATVIEW_ICON;
    case "p":
      return PARTITIONED_ICON;
    case "f":
      return FOREIGN_ICON;
    default:
      return TABLE_ICON;
  }
}

type SectionKind = "funcs" | "seqs" | "enums";

type TreeRow =
  | { kind: "pin-header"; count: number }
  | { kind: "schema"; schema: string; count: number; open: boolean }
  | { kind: "table"; t: TableInfo; open: boolean; pinned: boolean; nested: boolean }
  | { kind: "col"; t: TableInfo; c: ColumnInfo; pk: boolean; pinnedCtx: boolean }
  | { kind: "parts"; t: TableInfo; count: number; open: boolean }
  | { kind: "section"; schema: string; sec: SectionKind; count: number; open: boolean }
  | { kind: "func"; f: FuncInfo }
  | { kind: "seq"; q: SeqInfo }
  | { kind: "enum"; e: EnumInfo }
  | { kind: "ext-header"; count: number; open: boolean }
  | { kind: "ext"; x: ExtInfo };

const rowKey = (r: TreeRow): string => {
  switch (r.kind) {
    case "pin-header":
      return "pinh";
    case "schema":
      return `s:${r.schema}`;
    // a pinned table renders twice (strip + schema) — keys must not collide
    case "table":
      return r.pinned ? `pt:${r.t.table_oid}` : `t:${r.t.table_oid}`;
    case "col":
      return `${r.pinnedCtx ? "pc" : "c"}:${r.t.table_oid}:${r.c.attnum}`;
    case "parts":
      return `pp:${r.t.table_oid}`;
    case "section":
      return `sec:${r.schema}:${r.sec}`;
    // args disambiguate overloads
    case "func":
      return `fn:${r.f.schema}.${r.f.name}(${r.f.args})`;
    case "seq":
      return `sq:${r.q.schema}.${r.q.name}`;
    case "enum":
      return `en:${r.e.schema}.${r.e.name}`;
    case "ext-header":
      return "exth";
    case "ext":
      return `ex:${r.x.name}`;
  }
};

const SchemaRow = memo(function SchemaRow(p: {
  schema: string;
  count: number;
  open: boolean;
  onToggle: (schema: string, open: boolean) => void;
}) {
  return (
    <div className="tree-schema" onClick={() => p.onToggle(p.schema, p.open)}>
      {p.open ? SCHEMA_OPEN : SCHEMA_CLOSED}
      <span>{p.schema}</span>
      <span className="tree-count">{p.count}</span>
    </div>
  );
});

const TableRow = memo(function TableRow(p: {
  t: TableInfo;
  open: boolean;
  pinned: boolean;
  nested: boolean;
  onBrowse: (t: TableInfo) => void;
  onSelect: (t: TableInfo) => void;
  onMenu: (e: React.MouseEvent, t: TableInfo) => void;
  onToggleCols: (oid: number, pinned: boolean) => void;
}) {
  const t = p.t;
  const kindNote =
    t.kind === "v"
      ? "view"
      : t.kind === "m"
        ? "materialized view"
        : t.kind === "p"
          ? "partitioned table"
          : t.kind === "f"
            ? "foreign table"
            : null;
  return (
    <div
      className={`tree-table${p.nested ? " nested" : ""}`}
      title={`${t.comment ? `${t.comment}\n` : ""}${kindNote ? `${kindNote} · ` : ""}${t.columns.length} columns${t.pk.length ? ` · pk: ${t.pk.join(", ")}` : ""}\nclick: browse · double-click: SELECT in editor`}
      onClick={() => p.onBrowse(t)}
      onDoubleClick={() => p.onSelect(t)}
      onContextMenu={(e) => p.onMenu(e, t)}
    >
      <button
        className="iconbtn tree-twist"
        title="Columns"
        onClick={(e) => {
          e.stopPropagation(); // expand, don't browse
          p.onToggleCols(t.table_oid, p.pinned);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {p.open ? TWIST_OPEN : TWIST_CLOSED}
      </button>
      {tableIcon(t.kind)}
      <span className="tree-name">{t.name}</span>
      {p.pinned && PIN_ICON}
    </div>
  );
});

const ColRow = memo(function ColRow(p: {
  c: ColumnInfo;
  pk: boolean;
  onCopy: (name: string) => void;
  onInsert: (name: string) => void;
}) {
  const c = p.c;
  return (
    <div
      className="tree-col"
      title={`${c.comment ? `${c.comment}\n` : ""}${c.type}${c.not_null ? " · not null" : ""}${c.default ? ` · default ${c.default}` : ""}\nclick: copy name · double-click: insert into editor`}
      onClick={() => p.onCopy(c.name)}
      onDoubleClick={() => p.onInsert(c.name)}
    >
      {p.pk && PK_ICON}
      <span className="tree-col-name">{c.name}</span>
      <span className="tree-col-type">{c.type}</span>
    </div>
  );
});

/** collapsible "N partitions" node under a parent table */
const PartsRow = memo(function PartsRow(p: {
  oid: number;
  count: number;
  open: boolean;
  onToggle: (oid: number) => void;
}) {
  return (
    <div className="tree-parts" onClick={() => p.onToggle(p.oid)}>
      {p.open ? TWIST_OPEN : TWIST_CLOSED}
      <span>
        {p.count} partition{p.count === 1 ? "" : "s"}
      </span>
    </div>
  );
});

const SECTION_LABEL: Record<SectionKind, string> = {
  funcs: "Functions",
  seqs: "Sequences",
  enums: "Enums",
};

const SectionRow = memo(function SectionRow(p: {
  schema: string;
  sec: SectionKind;
  count: number;
  open: boolean;
  onToggle: (schema: string, sec: SectionKind) => void;
}) {
  return (
    <div className="tree-section" onClick={() => p.onToggle(p.schema, p.sec)}>
      {p.open ? TWIST_OPEN : TWIST_CLOSED}
      <span>{SECTION_LABEL[p.sec]}</span>
      <span className="tree-count">{p.count}</span>
    </div>
  );
});

const FuncRow = memo(function FuncRow(p: {
  f: FuncInfo;
  onCopy: (name: string) => void;
  onInsert: (name: string) => void;
}) {
  const f = p.f;
  return (
    <div
      className="tree-obj"
      title={`${f.name}(${f.args})${f.returns ? ` → ${f.returns}` : ""}\nclick: copy name · double-click: insert into editor`}
      onClick={() => p.onCopy(f.name)}
      onDoubleClick={() => p.onInsert(f.name)}
    >
      {FUNC_ICON}
      <span className="tree-obj-name">{f.name}</span>
    </div>
  );
});

const SeqRow = memo(function SeqRow(p: {
  q: SeqInfo;
  onCopy: (name: string) => void;
  onInsert: (name: string) => void;
}) {
  const q = p.q;
  return (
    <div
      className="tree-obj"
      title={`sequence${q.data_type ? ` · ${q.data_type}` : ""}\nclick: copy name · double-click: insert into editor`}
      onClick={() => p.onCopy(q.name)}
      onDoubleClick={() => p.onInsert(qualify(q.schema, q.name))}
    >
      {SEQ_ICON}
      <span className="tree-obj-name">{q.name}</span>
    </div>
  );
});

const EnumRow = memo(function EnumRow(p: { e: EnumInfo; onCopy: (name: string) => void }) {
  const e = p.e;
  const labels =
    e.labels.length > 12
      ? `${e.labels.slice(0, 12).join(" · ")} … (+${e.labels.length - 12})`
      : e.labels.join(" · ");
  return (
    <div
      className="tree-obj"
      title={`enum: ${labels}\nclick: copy name`}
      onClick={() => p.onCopy(e.name)}
    >
      {ENUM_ICON}
      <span className="tree-obj-name">{e.name}</span>
      <span className="tree-obj-detail">{e.labels.length}</span>
    </div>
  );
});

const ExtRow = memo(function ExtRow(p: { x: ExtInfo; onCopy: (name: string) => void }) {
  const x = p.x;
  return (
    <div
      className="tree-obj ext"
      title={`extension ${x.name} ${x.version} · schema ${x.schema}\nclick: copy name`}
      onClick={() => p.onCopy(x.name)}
    >
      {EXT_ICON}
      <span className="tree-obj-name">{x.name}</span>
      <span className="tree-obj-detail">{x.version}</span>
    </div>
  );
});

/** persisted pins: table identity as {schema, name} pairs (never a dotted
 * string), per profile — same localStorage precedent as active-tab restore */
type PinRef = { schema: string; name: string };
const pinsKey = (profileId: string) => `qwry.pins.${profileId}`;

function loadPins(profileId: string): PinRef[] {
  try {
    const raw = localStorage.getItem(pinsKey(profileId));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (p): p is PinRef =>
        !!p && typeof (p as PinRef).schema === "string" && typeof (p as PinRef).name === "string",
    );
  } catch {
    return [];
  }
}

export function SchemaTree({ profileId }: { profileId: string }) {
  const snapshot = useSchema((s) => s.snapshots[profileId]);
  const loading = useSchema((s) => s.loading[profileId]);
  const error = useSchema((s) => s.errors[profileId]);
  const [filterInput, setFilterInput] = useState("");
  /** debounced (80ms) copy of the filter — the tree rebuilds on this */
  const [filter, setFilter] = useState("");
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({ public: true });
  const [openTables, setOpenTables] = useState<Record<number, boolean>>({});
  /** pinned-strip copies keep their own expand state (distinct row keys) */
  const [openPinnedTables, setOpenPinnedTables] = useState<Record<number, boolean>>({});
  const [openParts, setOpenParts] = useState<Record<number, boolean>>({});
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  /** null = never toggled → follows the filter's auto-open */
  const [extsOpen, setExtsOpen] = useState<boolean | null>(null);
  const [pins, setPins] = useState<PinRef[]>(() => loadPins(profileId));
  const [menu, setMenu] = useState<{ x: number; y: number; table: TableInfo } | null>(null);

  // pins are per profile — reload when the rail switches connections
  useEffect(() => {
    setPins(loadPins(profileId));
  }, [profileId]);

  useEffect(() => {
    if (filterInput === "") {
      setFilter("");
      return;
    }
    const t = setTimeout(() => setFilter(filterInput), 80);
    return () => clearTimeout(t);
  }, [filterInput]);

  const bySchema = useMemo(() => {
    const m = new Map<string, TableInfo[]>();
    if (!snapshot) return m;
    for (const t of snapshot.tables) {
      if (filter && !fuzzyMatch(filter, t.name)) continue;
      const arr = m.get(t.schema);
      if (arr) arr.push(t);
      else m.set(t.schema, [t]);
    }
    return m;
  }, [snapshot, filter]);

  // partitions/inheritance children grouped under their parent (only parents
  // that actually exist in the snapshot — an orphan renders top-level)
  const childrenByParent = useMemo(() => {
    const m = new Map<number, TableInfo[]>();
    if (!snapshot) return m;
    const oids = new Set(snapshot.tables.map((t) => t.table_oid));
    for (const t of snapshot.tables) {
      if (t.parent_oid && oids.has(t.parent_oid)) {
        const arr = m.get(t.parent_oid);
        if (arr) arr.push(t);
        else m.set(t.parent_oid, [t]);
      }
    }
    return m;
  }, [snapshot]);

  // per-schema object sections (user-schema functions only — the snapshot's
  // function list also carries the merged pg_catalog set for completion)
  const objsBySchema = useMemo(() => {
    const m = new Map<string, { funcs: FuncInfo[]; seqs: SeqInfo[]; enums: EnumInfo[] }>();
    if (!snapshot) return m;
    const bucket = (schema: string) => {
      let b = m.get(schema);
      if (!b) {
        b = { funcs: [], seqs: [], enums: [] };
        m.set(schema, b);
      }
      return b;
    };
    const userSchemas = new Set(snapshot.schemas);
    for (const f of snapshot.functions) {
      if (!userSchemas.has(f.schema)) continue;
      if (filter && !fuzzyMatch(filter, f.name)) continue;
      bucket(f.schema).funcs.push(f);
    }
    for (const q of snapshot.sequences ?? []) {
      if (filter && !fuzzyMatch(filter, q.name)) continue;
      bucket(q.schema).seqs.push(q);
    }
    for (const e of snapshot.enums) {
      if (filter && !fuzzyMatch(filter, e.name)) continue;
      bucket(e.schema).enums.push(e);
    }
    return m;
  }, [snapshot, filter]);

  const pinnedTables = useMemo(() => {
    if (!snapshot) return [];
    const out: TableInfo[] = [];
    for (const p of pins) {
      const t = snapshot.tables.find((x) => x.schema === p.schema && x.name === p.name);
      if (t) out.push(t); // dropped tables keep their pin but don't render
    }
    return out;
  }, [snapshot, pins]);

  // the visible tree flattened to one row list, virtualized like the grid —
  // a 2k-table schema previously rendered every row on each filter keystroke
  const treeRows = useMemo(() => {
    const out: TreeRow[] = [];
    const pushCols = (t: TableInfo, pinnedCtx: boolean) => {
      for (const c of t.columns)
        out.push({ kind: "col", t, c, pk: t.pk.includes(c.name), pinnedCtx });
    };
    // pinned strip (hidden while filtering — matches render in place below)
    if (!filter && pinnedTables.length > 0) {
      out.push({ kind: "pin-header", count: pinnedTables.length });
      for (const t of pinnedTables) {
        const tOpen = !!openPinnedTables[t.table_oid];
        out.push({ kind: "table", t, open: tOpen, pinned: true, nested: false });
        if (tOpen) pushCols(t, true);
      }
    }
    const pushTable = (t: TableInfo, nested: boolean) => {
      const tOpen = !!openTables[t.table_oid];
      out.push({ kind: "table", t, open: tOpen, pinned: false, nested });
      if (tOpen) pushCols(t, false);
      // partitions nest under their parent, collapsed by default (recursion
      // covers subpartitioning); while filtering the tree is flat instead —
      // a matching partition must be visible without walking its ancestors
      if (!filter) {
        const kids = childrenByParent.get(t.table_oid);
        if (kids && kids.length > 0) {
          const pOpen = !!openParts[t.table_oid];
          out.push({ kind: "parts", t, count: kids.length, open: pOpen });
          if (pOpen) for (const k of kids) pushTable(k, true);
        }
      }
    };
    // schemas that hold tables OR objects after filtering
    const schemas = new Set<string>([...bySchema.keys(), ...objsBySchema.keys()]);
    for (const schema of [...schemas].sort()) {
      const tables = bySchema.get(schema) ?? [];
      const shown = filter
        ? tables
        : tables.filter((t) => !(t.parent_oid && childrenByParent.has(t.parent_oid)));
      const objs = objsBySchema.get(schema);
      const secCounts: [SectionKind, number][] = [
        ["funcs", objs?.funcs.length ?? 0],
        ["seqs", objs?.seqs.length ?? 0],
        ["enums", objs?.enums.length ?? 0],
      ];
      if (shown.length === 0 && secCounts.every(([, n]) => n === 0)) continue;
      const open = openSchemas[schema] ?? !!filter;
      out.push({ kind: "schema", schema, count: tables.length, open });
      if (!open) continue;
      for (const t of shown) pushTable(t, false);
      for (const [sec, count] of secCounts) {
        if (count === 0) continue;
        const sOpen = openSections[`${schema}:${sec}`] ?? !!filter;
        out.push({ kind: "section", schema, sec, count, open: sOpen });
        if (!sOpen) continue;
        if (sec === "funcs") for (const f of objs!.funcs) out.push({ kind: "func", f });
        else if (sec === "seqs") for (const q of objs!.seqs) out.push({ kind: "seq", q });
        else for (const e of objs!.enums) out.push({ kind: "enum", e });
      }
    }
    // extensions live at the database level, not inside a schema
    const exts = (snapshot?.extensions ?? []).filter((x) => !filter || fuzzyMatch(filter, x.name));
    if (exts.length > 0) {
      const open = extsOpen ?? !!filter;
      out.push({ kind: "ext-header", count: exts.length, open });
      if (open) for (const x of exts) out.push({ kind: "ext", x });
    }
    return out;
  }, [
    bySchema,
    objsBySchema,
    childrenByParent,
    pinnedTables,
    openSchemas,
    openTables,
    openPinnedTables,
    openParts,
    openSections,
    extsOpen,
    filter,
    snapshot,
  ]);

  // the scroll container is an ancestor (.sb-tables) — find it once the list
  // mounts and anchor the virtualizer with the list's offset inside it
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [listOffset, setListOffset] = useState(0);
  const hasTree = !!snapshot;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) {
      setScrollEl(null);
      return;
    }
    let el: HTMLElement | null = list.parentElement;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "overlay") break;
      el = el.parentElement;
    }
    setScrollEl(el);
    if (!el) return;
    const scroll = el;
    const measure = () =>
      setListOffset(
        list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop,
      );
    measure();
    // zoom resizes the filter input above the list — a one-shot offset goes
    // stale and every virtual row lands shifted; re-measure when it resizes
    const ro = new ResizeObserver(measure);
    if (list.previousElementSibling) ro.observe(list.previousElementSibling);
    return () => ro.disconnect();
  }, [hasTree]);

  const rowVirt = useVirtualizer({
    count: treeRows.length,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => {
      const kind = treeRows[i]?.kind;
      return kind === "col" ? 21 : 24;
    },
    getItemKey: (i) => rowKey(treeRows[i]),
    overscan: 12,
    scrollMargin: listOffset,
  });

  const browseTable = useCallback((t: TableInfo) => {
    void import("../stores/browser").then(({ useBrowser }) =>
      useBrowser.getState().openTable(t),
    );
  }, []);

  const insertSelect = useCallback((t: TableInfo) => {
    // quoted ref — a mixed-case/reserved name must never case-fold to a
    // DIFFERENT table when this SQL runs
    const ref = qualify(t.schema, t.name);
    // open the SELECT in a fresh query tab (sets editor sql) and run it
    useTabs.getState().newTab(`SELECT * FROM ${ref} LIMIT 100`);
    void useResults.getState().run();
  }, []);

  const openTableMenu = useCallback((e: React.MouseEvent, t: TableInfo) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, table: t });
  }, []);

  const toggleSchema = useCallback((schema: string, open: boolean) => {
    setOpenSchemas((s) => ({ ...s, [schema]: !open }));
  }, []);

  const toggleTableCols = useCallback((oid: number, pinned: boolean) => {
    if (pinned) setOpenPinnedTables((o) => ({ ...o, [oid]: !o[oid] }));
    else setOpenTables((o) => ({ ...o, [oid]: !o[oid] }));
  }, []);

  const toggleParts = useCallback((oid: number) => {
    setOpenParts((o) => ({ ...o, [oid]: !o[oid] }));
  }, []);

  const toggleSection = useCallback(
    (schema: string, sec: SectionKind) => {
      setOpenSections((s) => {
        const key = `${schema}:${sec}`;
        // under a filter sections default open — the first click must close
        return { ...s, [key]: !(s[key] ?? !!filter) };
      });
    },
    [filter],
  );

  const copyName = useCallback((name: string) => void copyCue(name), []);

  const insertText = useCallback((text: string) => {
    void import("../editor/SqlEditor").then(({ editorInsert }) => {
      // table tab active → no editor mounted; a silent
      // no-op reads as broken, so seed a fresh query tab
      if (editorInsert.current) editorInsert.current(text);
      else useTabs.getState().newTab(text);
    });
  }, []);

  const isPinned = useCallback(
    (t: TableInfo) => pins.some((p) => p.schema === t.schema && p.name === t.name),
    [pins],
  );

  const togglePin = useCallback(
    (t: TableInfo) => {
      setPins((cur) => {
        const next = cur.some((p) => p.schema === t.schema && p.name === t.name)
          ? cur.filter((p) => !(p.schema === t.schema && p.name === t.name))
          : [...cur, { schema: t.schema, name: t.name }];
        try {
          localStorage.setItem(pinsKey(profileId), JSON.stringify(next));
        } catch {
          // quota/private-mode failure only loses persistence, not the session pin
        }
        return next;
      });
    },
    [profileId],
  );

  const retry = () => {
    const { sessions } = useConnections.getState();
    if (sessions[profileId]) void useSchema.getState().fetch(profileId, sessions[profileId]);
  };

  // stale-while-revalidate: only show the loading message when there is no
  // snapshot yet — a ⌘R refresh must not blank the whole tree
  if (loading && !snapshot) return <div className="tree-msg">Loading schema…</div>;
  if (!snapshot) {
    // a silently empty sidebar lies — say WHY and offer a retry
    if (error)
      return (
        <div className="tree-msg tree-error">
          <div>Schema load failed:</div>
          <div className="tree-error-msg">{error}</div>
          <button className="btnish" onClick={retry}>
            Retry
          </button>
        </div>
      );
    return null;
  }

  const tableMenu = (t: TableInfo): MenuNode[] => {
    const ref = qualify(t.schema, t.name);
    return [
      { kind: "item", label: "Browse", onSelect: () => browseTable(t) },
      { kind: "item", label: "Open SELECT in Editor", onSelect: () => insertSelect(t) },
      { kind: "sep" },
      {
        kind: "item",
        label: isPinned(t) ? "Unpin Table" : "Pin Table",
        onSelect: () => togglePin(t),
      },
      { kind: "sep" },
      { kind: "item", label: "Copy Name", onSelect: () => void copyCue(t.name, "Copied table name") },
      {
        kind: "item",
        label: "Copy Qualified Name",
        onSelect: () => void copyCue(ref, "Copied qualified name"),
      },
      {
        kind: "item",
        label: "Copy SELECT",
        onSelect: () => void copyCue(`SELECT * FROM ${ref} LIMIT 100`, "Copied SELECT"),
      },
      { kind: "sep" },
      {
        kind: "item",
        label: "Refresh Schema",
        onSelect: () => {
          const { sessions } = useConnections.getState();
          if (sessions[profileId]) void useSchema.getState().fetch(profileId, sessions[profileId]);
        },
      },
    ];
  };

  return (
    <div className="schema-tree">
      <input
        className="tree-filter"
        placeholder="Filter tables…  ⌥⌘F"
        value={filterInput}
        onChange={(e) => setFilterInput(e.target.value)}
        id="schema-filter"
      />
      <div
        ref={listRef}
        className="tree-vlist"
        style={{ height: rowVirt.getTotalSize() }}
      >
        {rowVirt.getVirtualItems().map((vr) => {
          const row = treeRows[vr.index];
          if (!row) return null;
          return (
            <div
              key={vr.key}
              data-index={vr.index}
              ref={rowVirt.measureElement}
              className="tree-vrow"
              style={{ transform: `translateY(${vr.start - listOffset}px)` }}
            >
              {row.kind === "pin-header" ? (
                <div className="tree-pin-header">
                  {PIN_ICON}
                  <span>Pinned</span>
                  <span className="tree-count">{row.count}</span>
                </div>
              ) : row.kind === "schema" ? (
                <SchemaRow
                  schema={row.schema}
                  count={row.count}
                  open={row.open}
                  onToggle={toggleSchema}
                />
              ) : row.kind === "table" ? (
                <TableRow
                  t={row.t}
                  open={row.open}
                  pinned={row.pinned}
                  nested={row.nested}
                  onBrowse={browseTable}
                  onSelect={insertSelect}
                  onMenu={openTableMenu}
                  onToggleCols={toggleTableCols}
                />
              ) : row.kind === "col" ? (
                <ColRow c={row.c} pk={row.pk} onCopy={copyName} onInsert={insertText} />
              ) : row.kind === "parts" ? (
                <PartsRow
                  oid={row.t.table_oid}
                  count={row.count}
                  open={row.open}
                  onToggle={toggleParts}
                />
              ) : row.kind === "section" ? (
                <SectionRow
                  schema={row.schema}
                  sec={row.sec}
                  count={row.count}
                  open={row.open}
                  onToggle={toggleSection}
                />
              ) : row.kind === "func" ? (
                <FuncRow f={row.f} onCopy={copyName} onInsert={insertText} />
              ) : row.kind === "seq" ? (
                <SeqRow q={row.q} onCopy={copyName} onInsert={insertText} />
              ) : row.kind === "enum" ? (
                <EnumRow e={row.e} onCopy={copyName} />
              ) : row.kind === "ext-header" ? (
                <div
                  className="tree-section top"
                  onClick={() => setExtsOpen((o) => !(o ?? !!filter))}
                >
                  {row.open ? TWIST_OPEN : TWIST_CLOSED}
                  <span>Extensions</span>
                  <span className="tree-count">{row.count}</span>
                </div>
              ) : (
                <ExtRow x={row.x} onCopy={copyName} />
              )}
            </div>
          );
        })}
      </div>
      {treeRows.length === 0 &&
        (filter ? (
          // filter no-match is a dead end without a way back — offer it
          <div className="tree-empty">
            <span>No tables match “{filterInput}”</span>
            <button className="btnish" onClick={() => setFilterInput("")}>
              Clear Filter
            </button>
          </div>
        ) : (
          <div className="tree-empty">
            <span>No tables in this database yet</span>
          </div>
        ))}
      {menu && (
        <ContextMenu
          point={menu}
          items={tableMenu(menu.table)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
