// Per-profile usage counts for completion ranking. localStorage-backed for now
// (appdb-backed persistence can replace transparently later).

const KEY = "qwry.completion.usage";

let counts: Record<string, number> | null = null;

function load(): Record<string, number> {
  if (!counts) {
    try {
      counts = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    } catch {
      counts = {};
    }
  }
  return counts!;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function bumpUsage(kind: string, name: string) {
  const c = load();
  const k = `${kind}:${name}`;
  c[k] = (c[k] ?? 0) + 1;
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      localStorage.setItem(KEY, JSON.stringify(load()));
    }, 1500);
  }
}

/** 0..2-ish logarithmic boost */
export function usageBoost(kind: string, name: string): number {
  const n = load()[`${kind}:${name}`] ?? 0;
  return n === 0 ? 0 : Math.min(2, Math.log10(1 + n));
}
