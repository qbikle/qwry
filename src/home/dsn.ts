// postgres:// DSN parser for paste-to-create. Regex-based (not new URL()):
// WHATWG URL handling of non-special schemes varies across engines.
export interface ParsedDsn {
  user?: string;
  password?: string;
  host?: string;
  port?: number;
  dbname?: string;
  sslmode?: "prefer" | "require" | "disable";
}

const DSN_RE =
  /^\s*postgres(?:ql)?:\/\/(?:([^:@/?#]*)(?::([^@/?#]*))?@)?(\[[^\]]+\]|[^:/?#@]+)?(?::(\d+))?(?:\/([^?#]*))?(?:\?([^#]*))?\s*$/;

export const looksLikeDsn = (s: string) => /^\s*postgres(ql)?:\/\//.test(s);

export function parseDsn(raw: string): ParsedDsn | null {
  const m = DSN_RE.exec(raw);
  if (!m) return null;
  const dec = (s: string | undefined) => {
    if (s == null || s === "") return undefined;
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  let sslmode: ParsedDsn["sslmode"];
  const sslRaw = new URLSearchParams(m[6] ?? "").get("sslmode");
  if (sslRaw === "prefer" || sslRaw === "require" || sslRaw === "disable") sslmode = sslRaw;
  else if (sslRaw === "allow") sslmode = "prefer";
  // verify-ca / verify-full → closest supported mode (qwry's require = encrypt, no verify)
  else if (sslRaw === "verify-ca" || sslRaw === "verify-full") sslmode = "require";

  return {
    user: dec(m[1]),
    password: dec(m[2]),
    host: m[3]?.replace(/^\[|\]$/g, ""),
    port: m[4] ? Number(m[4]) : undefined,
    dbname: dec(m[5]),
    sslmode,
  };
}
