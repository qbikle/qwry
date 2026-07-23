// Connection identity colors — pure data, importable from stores and design
// code without dragging component modules (lucide, css) into their graphs.
import type { Profile } from "../ipc/types";

export const AVATAR_PALETTE = [
  "#5b8cff",
  "#3ecf8e",
  "#f5a623",
  "#ff5c69",
  "#c792ea",
  "#22b8cf",
  "#ff8a65",
];

/** stable slot from the profile id — index-derived slots meant deleting or
 * reordering an UNRELATED profile shifted this one's color, which under
 * Match Connection retinted the whole app (action at a distance). The hash
 * pins a colorless profile's identity for its lifetime. */
function hashSlot(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % AVATAR_PALETTE.length;
}

/** a profile's identity color: explicit choice, else its stable hash slot.
 * The index parameter is retained for call-site compatibility but no longer
 * feeds the color. */
export const avatarColor = (p: Profile, _i = 0) =>
  p.color || AVATAR_PALETTE[hashSlot(p.id)];
