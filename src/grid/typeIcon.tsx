import {
  Binary,
  Braces,
  Brackets,
  Calendar,
  Clock,
  Fingerprint,
  Hash,
  Tag,
  ToggleLeft,
  Type,
  type LucideIcon,
} from "lucide-react";
import { isArrayType } from "../inspector/format";

export interface TypeGlyph {
  Icon: LucideIcon;
  /** css color (a --syn-* / --fg-* token) so icons read as a family */
  color: string;
}

// pg type names as tokio-postgres reports them (short forms) + a few spelled-out
// variants that show up via format_type / introspection
const NUM = new Set([
  "int2", "int4", "int8", "smallint", "integer", "bigint",
  "float4", "float8", "real", "double precision",
  "numeric", "decimal", "money", "oid",
  "serial", "bigserial", "smallserial",
]);
const TEXT = new Set([
  "text", "varchar", "character varying", "char", "character", "bpchar", "name", "citext",
]);
const BOOL = new Set(["bool", "boolean"]);
const TIMEY = new Set([
  "time", "timetz", "time with time zone",
  "timestamp", "timestamptz", "timestamp with time zone", "timestamp without time zone",
  "interval",
]);
const JSONY = new Set(["json", "jsonb"]);

/** map a pg type_name to a small colored glyph for the column header.
 * null when the type is unknown (e.g. editability map not yet loaded). */
export function typeIcon(t?: string): TypeGlyph | null {
  if (!t) return null;
  if (isArrayType(t)) return { Icon: Brackets, color: "var(--syn-keyword)" };
  const n = t.toLowerCase();
  if (JSONY.has(n)) return { Icon: Braces, color: "var(--syn-type)" };
  if (NUM.has(n)) return { Icon: Hash, color: "var(--syn-number)" };
  if (BOOL.has(n)) return { Icon: ToggleLeft, color: "var(--syn-prop)" };
  if (n === "uuid") return { Icon: Fingerprint, color: "var(--syn-prop)" };
  if (n === "bytea") return { Icon: Binary, color: "var(--fg-muted)" };
  if (n === "date") return { Icon: Calendar, color: "var(--syn-operator)" };
  if (TIMEY.has(n)) return { Icon: Clock, color: "var(--syn-operator)" };
  if (TEXT.has(n)) return { Icon: Type, color: "var(--syn-string)" };
  return { Icon: Tag, color: "var(--fg-muted)" };
}
