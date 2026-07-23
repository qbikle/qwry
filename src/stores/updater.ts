// Auto-update over GitHub Releases — the store owns the whole lifecycle:
// quiet periodic checks, one toast per new version, download progress,
// relaunch. Signature verification (minisign) happens inside the plugin
// against the pubkey baked into tauri.conf.json.
import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 5000;

interface UpdaterState {
  phase: "idle" | "available" | "downloading" | "error";
  version: string | null;
  /** 0..1 while downloading; total size can be unknown → stays 0 */
  progress: number;
  error: string | null;
  dismiss: () => void;
  install: () => Promise<void>;
}

// the plugin handle lives outside the store (not serializable state)
let pending: Update | null = null;
// "Later" silences THIS version until the next launch; a newer release
// still toasts
let dismissedVersion: string | null = null;

export const useUpdater = create<UpdaterState>()((set, get) => ({
  phase: "idle",
  version: null,
  progress: 0,
  error: null,

  dismiss: () => {
    dismissedVersion = get().version;
    set({ phase: "idle", error: null });
  },

  install: async () => {
    const u = pending;
    if (!u || get().phase === "downloading") return;
    set({ phase: "downloading", progress: 0, error: null });
    try {
      let total = 0;
      let got = 0;
      await u.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          got += e.data.chunkLength;
          if (total > 0) set({ progress: Math.min(got / total, 1) });
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      set({ phase: "error", error: String(e) });
    }
  },
}));

async function checkForUpdate(): Promise<void> {
  // never mid-download, never re-toast a version the user said Later to
  const s = useUpdater.getState();
  if (s.phase === "downloading") return;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const u = await check();
    if (u?.available && u.version !== dismissedVersion) {
      pending = u;
      useUpdater.setState({ phase: "available", version: u.version, error: null });
    }
  } catch {
    // offline / rate-limited / endpoint missing — quiet, next tick retries
  }
}

// dev builds run against the local tree, an update offer would be noise
if (typeof window !== "undefined" && !import.meta.env.DEV) {
  setTimeout(() => void checkForUpdate(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void checkForUpdate(), CHECK_EVERY_MS);
}
