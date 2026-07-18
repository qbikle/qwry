// Builders for the cached-mapping payloads fed back to the Rust edit pipeline
// (perf batch A/B): the schema snapshot + the EditabilityMap the frontend
// already fetched carry everything the backend used to re-derive with
// prepare()+pg_class+pg_attribute round trips — over a bastion each trip is
// 100-500ms. A hint the backend judges incomplete falls back to full
// server-side derivation, and stale hints are caught by verify-then-commit
// (matched≠1 → rollback) or a schema-shaped SQL error (→ rollback + the
// frontend's auto-repair refetch). Never a silent wrong write.

import type { EditabilityMap, EditMapHint, TableIdentityHint } from "../ipc/types";
import type { SchemaSnapshot } from "../stores/schema";

const identityCache = new WeakMap<SchemaSnapshot, TableIdentityHint[]>();

/** oid → identity for every snapshot table — memoized per snapshot object.
 * Tables whose pk names can't all resolve to attnums are omitted (a partial
 * pk hint would lie); so are tables from a pre-generated-column cached
 * snapshot (`generated` missing — the hint couldn't mark those read-only).
 * The backend falls back to catalog on any oid miss. */
export function tableIdentityHints(snap: SchemaSnapshot): TableIdentityHint[] {
  const cached = identityCache.get(snap);
  if (cached) return cached;
  const hints: TableIdentityHint[] = [];
  for (const t of snap.tables) {
    const pk_attnums: number[] = [];
    let ok = true;
    for (const name of t.pk) {
      const col = t.columns.find((c) => c.name === name);
      if (!col) {
        ok = false;
        break;
      }
      pk_attnums.push(col.attnum);
    }
    if (!ok) continue;
    const generated_attnums: number[] = [];
    const identity_always_attnums: number[] = [];
    for (const col of t.columns) {
      if (col.generated === undefined || col.identity === undefined) {
        ok = false;
        break;
      }
      if (col.generated !== "") generated_attnums.push(col.attnum);
      if (col.identity === "a") identity_always_attnums.push(col.attnum);
    }
    if (!ok) continue;
    hints.push({
      table_oid: t.table_oid,
      schema: t.schema,
      name: t.name,
      pk_attnums,
      relkind: t.kind,
      generated_attnums,
      identity_always_attnums,
    });
  }
  identityCache.set(snap, hints);
  return hints;
}

/** Full plan-path mapping: the result's EditabilityMap + real column names
 * resolved from the snapshot. Returns null when any needed name can't be
 * resolved — the caller then omits the hint and the backend derives. */
export function buildEditMapHint(
  map: EditabilityMap,
  snap: SchemaSnapshot | undefined,
): EditMapHint | null {
  if (!snap) return null;
  const byOid = new Map(snap.tables.map((t) => [t.table_oid, t]));
  const columns: EditMapHint["columns"] = [];
  for (const c of map.columns) {
    let name: string | null = null;
    if (!c.is_ctid && c.table_oid > 0 && c.attnum > 0) {
      const t = byOid.get(c.table_oid);
      const ref = map.table_refs[c.table_oid];
      // identity check: the snapshot table must BE the table the map saw
      // (same oid + same schema/name) — a snapshot from a different database
      // (oid collision) or a renamed table must never donate column names
      if (!t || !ref || t.schema !== ref.schema || t.name !== ref.name) return null;
      name = t.columns.find((col) => col.attnum === c.attnum)?.name ?? null;
      // a mapped column we can't name → the whole hint is unusable (the
      // backend would need a catalog trip anyway; let it own the derivation)
      if (name === null) return null;
    }
    columns.push({
      col: c.col,
      table_oid: c.table_oid,
      attnum: c.attnum,
      editable: c.editable,
      type_name: c.type_name,
      cast: c.cast,
      is_ctid: c.is_ctid,
      name,
    });
  }
  return { columns, pk_cols: map.pk_cols, table_refs: map.table_refs };
}
