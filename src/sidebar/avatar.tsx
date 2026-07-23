import {
  Anchor,
  Beaker,
  Box,
  Cloud,
  Database,
  Flame,
  Ghost,
  Globe,
  HardDrive,
  Layers,
  Leaf,
  Rocket,
  Server,
  Snowflake,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { Profile } from "../ipc/types";
import { avatarColor } from "../design/avatarColor";
export { AVATAR_PALETTE, avatarColor } from "../design/avatarColor";
import "./avatar.css";

/** readable glyph colour for a given avatar background */
function textOn(hex: string): string {
  const m = hex.replace("#", "");
  const f = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.62 ? "#16181d" : "#ffffff";
}

/** curated icon set selectable as an avatar glyph (`icon:<name>`) */
export const AVATAR_ICONS: Record<string, LucideIcon> = {
  database: Database,
  server: Server,
  "hard-drive": HardDrive,
  cloud: Cloud,
  globe: Globe,
  layers: Layers,
  box: Box,
  leaf: Leaf,
  flame: Flame,
  zap: Zap,
  snowflake: Snowflake,
  ghost: Ghost,
  beaker: Beaker,
  rocket: Rocket,
  anchor: Anchor,
};

export const autoInitial = (p: Profile) =>
  (p.name.trim()[0] || p.host[0] || "?").toUpperCase();

/** colored squircle showing the connection's glyph (icon / emoji / letter) */
export function Avatar({ profile, index = 0, size = 40 }: { profile: Profile; index?: number; size?: number }) {
  const color = avatarColor(profile, index);
  const glyph = profile.glyph?.trim();
  const radius = Math.round(size * 0.32);

  let inner: React.ReactNode;
  if (glyph?.startsWith("icon:")) {
    const Icon = AVATAR_ICONS[glyph.slice(5)] ?? Database;
    inner = <Icon size={Math.round(size * 0.5)} strokeWidth={2.2} />;
  } else if (glyph) {
    inner = <span style={{ fontSize: Math.round(size * 0.42) }}>{glyph}</span>;
  } else {
    inner = <span style={{ fontSize: Math.round(size * 0.42) }}>{autoInitial(profile)}</span>;
  }

  return (
    <span
      className="qa-avatar"
      style={{ background: color, color: textOn(color), width: size, height: size, borderRadius: radius }}
    >
      {inner}
    </span>
  );
}
