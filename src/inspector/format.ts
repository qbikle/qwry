// Structured-value detection + JSON syntax highlighting for the inspector.

/** parse a Postgres array literal ({a,b,"c d",NULL,{1,2}}) into a JS array */
export function parsePgArray(text: string): unknown[] {
  let i = 0;
  const s = text;

  function parseArray(): unknown[] {
    const arr: unknown[] = [];
    i++; // {
    while (i < s.length && s[i] !== "}") {
      while (s[i] === " ") i++;
      arr.push(parseElem());
      while (s[i] === " ") i++;
      if (s[i] === ",") i++;
    }
    i++; // }
    return arr;
  }
  function parseElem(): unknown {
    if (s[i] === "{") return parseArray();
    if (s[i] === '"') {
      i++;
      let out = "";
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\") {
          i++;
          out += s[i++];
        } else out += s[i++];
      }
      i++; // closing "
      return out;
    }
    const start = i;
    while (i < s.length && s[i] !== "," && s[i] !== "}") i++;
    const tok = s.slice(start, i).trim();
    return tok.toUpperCase() === "NULL" ? null : tok;
  }

  try {
    return parseArray();
  } catch {
    return [];
  }
}

export const isArrayType = (t?: string) => !!t && (t.startsWith("_") || t.endsWith("[]"));

/** serialize a JS value back to a Postgres array literal ({a,"b c",NULL,{1,2}}).
 * Strings are always quoted (valid for any element type; PG coerces on cast). */
export function jsToPgArray(v: unknown): string {
  const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const elem = (e: unknown): string => {
    if (e === null || e === undefined) return "NULL";
    if (Array.isArray(e)) return jsToPgArray(e);
    if (typeof e === "number" || typeof e === "boolean") return String(e);
    if (typeof e === "object") return quote(JSON.stringify(e));
    return quote(String(e));
  };
  if (!Array.isArray(v)) return JSON.stringify(v);
  return `{${v.map(elem).join(",")}}`;
}

/** if a cell is structured (JSON or a PG array), return it parsed; else undefined */
export function structuredValue(value: string | null | undefined, typeName?: string): unknown | undefined {
  if (value == null) return undefined;
  const t = value.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      /* not JSON — maybe a PG array below */
    }
  }
  if (isArrayType(typeName) && t.startsWith("{") && t.endsWith("}")) {
    return parsePgArray(t);
  }
  return undefined;
}
