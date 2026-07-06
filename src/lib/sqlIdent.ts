// SQL identifier quoting for GENERATED SQL (tree menus, copy-as-INSERT,
// browse queries). Quote-when-needed so common output stays readable, but a
// mixed-case / reserved-word / exotic identifier can never silently case-fold
// to a different object.

/** PG reserved keywords (reserved + can't-be-column classes) that force quoting */
const RESERVED = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric",
  "authorization", "between", "bigint", "binary", "bit", "boolean", "both",
  "case", "cast", "check", "coalesce", "collate", "collation", "column",
  "concurrently", "constraint", "create", "cross", "current_catalog",
  "current_date", "current_role", "current_schema", "current_time",
  "current_timestamp", "current_user", "default", "deferrable", "desc",
  "distinct", "do", "else", "end", "except", "exists", "extract", "false",
  "fetch", "for", "foreign", "freeze", "from", "full", "grant", "greatest",
  "group", "grouping", "having", "ilike", "in", "initially", "inner",
  "intersect", "interval", "into", "is", "isnull", "join", "lateral",
  "leading", "least", "left", "like", "limit", "localtime", "localtimestamp",
  "natural", "not", "notnull", "null", "nullif", "offset", "on", "only", "or",
  "order", "outer", "overlaps", "placing", "primary", "references",
  "returning", "right", "select", "session_user", "similar", "some",
  "symmetric", "table", "tablesample", "then", "to", "trailing", "true",
  "union", "unique", "user", "using", "values", "variadic", "verbose", "when",
  "where", "window", "with",
]);

/** quote an identifier when it wouldn't survive unquoted */
export const qi = (name: string): string =>
  /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name)
    ? name
    : `"${name.replace(/"/g, '""')}"`;

/** schema-qualified reference; public stays bare for readability */
export const qualify = (schema: string, name: string): string =>
  schema === "public" ? qi(name) : `${qi(schema)}.${qi(name)}`;

/** "schema.name" (as stored in editability maps) → quoted reference */
export const qualifyDotted = (dotted: string): string => {
  const i = dotted.indexOf(".");
  return i === -1 ? qi(dotted) : qualify(dotted.slice(0, i), dotted.slice(i + 1));
};
