// Shared right-click menu for a connection — used by the rail and the dashboard
// so both surfaces offer the same actions.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as ipc from "../ipc/commands";
import type { MenuNode } from "../app/overlay/ContextMenu";
import type { Profile } from "../ipc/types";
import { confirmTxRollback, openTxCount, useConnections } from "../stores/connections";

export function connectionMenu(p: Profile, connected: boolean): MenuNode[] {
  const c = useConnections.getState();
  const items: MenuNode[] = [];

  if (connected) {
    items.push({
      kind: "item",
      label: "Open",
      onSelect: () => {
        c.setActive(p.id);
        c.setHome(null);
      },
    });
    items.push({
      kind: "item",
      label: "Disconnect",
      onSelect: () =>
        void (async () => {
          if (await confirmTxRollback(p.id, "Disconnect")) await c.invalidateProfile(p.id);
        })(),
    });
    items.push({
      kind: "item",
      label: "Reconnect",
      onSelect: () =>
        void (async () => {
          if (!(await confirmTxRollback(p.id, "Reconnect"))) return;
          await c.invalidateProfile(p.id);
          await c.connect(p.id);
        })(),
    });
  } else {
    items.push({ kind: "item", label: "Connect", onSelect: () => void c.connect(p.id) });
  }

  items.push({ kind: "sep" });
  items.push({ kind: "item", label: "Edit…", onSelect: () => c.editConnection(p) });
  items.push({
    kind: "item",
    label: "Duplicate",
    onSelect: () =>
      void (async () => {
        await ipc.cloneConnection(p.id, p.dbname);
        await c.loadProfiles();
      })(),
  });
  // password stays redacted on the default action; "with password" is the
  // deliberate second click (locked decision #2)
  items.push({
    kind: "submenu",
    label: "Copy Connection URL",
    items: [
      {
        kind: "item",
        label: "Copy URL",
        onSelect: () => void ipc.connectionUri(p.id, false).then(writeText),
      },
      {
        kind: "item",
        label: "Copy URL with Password",
        onSelect: () => void ipc.connectionUri(p.id, true).then(writeText),
      },
      { kind: "sep" },
      {
        kind: "item",
        label: "Copy psql Command",
        onSelect: () =>
          void writeText(`psql -h ${p.host} -p ${p.port} -U ${p.user} -d ${p.dbname}`),
      },
    ],
  });

  items.push({ kind: "sep" });
  items.push({
    kind: "item",
    label: "Delete",
    danger: true,
    onSelect: () =>
      void (async () => {
        const { confirmDanger } = await import("../stores/danger");
        const txN = openTxCount(p.id);
        const ok = await confirmDanger(
          `Delete Connection “${p.name || p.host}”?`,
          `Removes the saved connection. This cannot be undone.${
            txN > 0
              ? `\nOpen transaction${txN === 1 ? "" : "s"} on ${txN} tab${txN === 1 ? "" : "s"} will be rolled back.`
              : ""
          }`,
          "Delete",
        );
        if (ok) await c.deleteProfile(p.id);
      })(),
  });

  return items;
}
