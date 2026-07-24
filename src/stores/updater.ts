// Auto-update over GitHub Releases — the store owns the whole lifecycle:
// quiet periodic checks, one toast per new version, download progress,
// relaunch. Signature verification (minisign) happens inside the plugin
// against the pubkey baked into tauri.conf.json.
import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 5000;
/** no download event for this long = the connection stalled — reqwest has
 * no default timeout, so without this the toast would hang un-dismissable */
const STALL_MS = 90_000;

interface UpdaterState {
  /** installed = the new version is on disk but the app didn't relaunch
   * (user declined the exit guard, or relaunch itself failed) — the next
   * launch runs it either way */
  phase: "idle" | "available" | "downloading" | "installed" | "error";
  version: string | null;
  /** 0..1 while downloading; total size can be unknown → stays 0 */
  progress: number;
  error: string | null;
  dismiss: () => void;
  install: () => Promise<void>;
}

// the plugin handle lives outside the store (a Rust-side Resource, not
// serializable state); replaced handles are close()d — they leak otherwise
let pending: Update | null = null;
// "Later" silences THIS version until the next launch; a newer release
// still toasts. Also set once a version is INSTALLED — never re-offer it.
let dismissedVersion: string | null = null;
// bumped to orphan an in-flight download (stall watchdog): the orphan's
// events, error, and above all its relaunch are dead on arrival
let installGen = 0;

export const useUpdater = create<UpdaterState>()((set, get) => ({
  phase: "idle",
  version: null,
  progress: 0,
  error: null,

  dismiss: () => {
    // only Later-on-available skips the version; dismissing an ERROR must
    // leave the 4h retry armed, and "installed" is already dismissed-forever
    if (get().phase === "available") {
      dismissedVersion = get().version;
      if (pending) {
        void pending.close();
        pending = null;
      }
    }
    set({ phase: "idle", error: null });
  },

  install: async () => {
    const u = pending;
    if (!u || get().phase === "downloading") return;
    // a relaunch is a process death — run the exact Quit ceremony (flush
    // the tab persist, confirm staged-edit/draft/transaction loss) BEFORE
    // the download, so declining costs nothing
    const { prepareExit } = await import("./exitGuard");
    const confirmed = await prepareExit("Update");
    if (!confirmed) return;
    if (get().phase === "downloading") return; // re-read after the await
    // the handle may have died during the guard dialog: a 4h check can
    // swap-and-close it, and the toast's Later sits ABOVE the dialog
    if (pending !== u) return;
    const gen = ++installGen;
    set({ phase: "downloading", progress: 0, error: null });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (gen !== installGen) return;
        installGen++;
        set({ phase: "error", error: "download stalled. Check the connection and try again" });
      }, STALL_MS);
    };
    armWatchdog();
    try {
      let total = 0;
      let got = 0;
      await u.downloadAndInstall((e) => {
        if (gen !== installGen) return;
        armWatchdog();
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          got += e.data.chunkLength;
          if (total > 0) set({ progress: Math.min(got / total, 1) });
        }
      });
      clearTimeout(watchdog);
      // installed on disk from here down — never offer this version again
      dismissedVersion = u.version;
      // an orphan must never null a handle it doesn't own: after a stall
      // the 4h check may have re-armed pending with a FRESH handle
      if (pending === u) pending = null;
      if (gen !== installGen) return; // stalled-out orphan finished: no surprise relaunch
      // re-guard before the relaunch, but only for work staged DURING the
      // download — the first confirm discarded nothing, so an unchanged
      // census auto-passes instead of re-asking the identical question
      if (!(await prepareExit("Update", confirmed))) {
        set({ phase: "installed" });
        return;
      }
      try {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch {
        // the update IS installed; only the restart failed — say that, and
        // never re-download over it
        set({ phase: "installed" });
      }
    } catch (e) {
      clearTimeout(watchdog);
      if (gen === installGen) set({ phase: "error", error: String(e) });
    }
  },
}));

async function checkForUpdate(): Promise<void> {
  if (useUpdater.getState().phase === "downloading") return;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const u = await check();
    // re-read after the await: a click may have started a download while
    // this check was in flight — its state must not be stomped
    if (useUpdater.getState().phase === "downloading") {
      if (u) void u.close();
      return;
    }
    if (u?.available && u.version !== dismissedVersion) {
      if (pending && pending !== u) void pending.close();
      pending = u;
      useUpdater.setState({ phase: "available", version: u.version, error: null });
    } else if (u) {
      void u.close();
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
