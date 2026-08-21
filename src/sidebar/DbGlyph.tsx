import { motion } from "motion/react";
import { prefersReducedMotion, spring } from "../design/springs";

/** The lucide database glyph rebuilt as three motion pieces so the disc
 * stack can split apart while a heal runs and clap back together on the
 * verdict (stores/refreshFx.ts owns the choreography). Split: the lid lifts
 * first, the middle ring slips down after it; join reverses the stagger so
 * the lid lands last. Offsets are viewBox units (24 grid at 16px render). */
export function DbGlyph({ apart }: { apart: boolean }) {
  const d = (n: number) => (prefersReducedMotion() ? 0 : n);
  return (
    <svg
      className="sb-db-icon"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      style={{ overflow: "visible" }}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <motion.path
        d="M3 12A9 3 0 0 0 21 12"
        animate={{ y: apart ? 2.5 : 0 }}
        transition={{ ...(apart ? spring.pop : spring.snappy), delay: apart ? d(0.06) : 0 }}
      />
      <motion.ellipse
        cx="12"
        cy="5"
        rx="9"
        ry="3"
        animate={{ y: apart ? -3.5 : 0 }}
        transition={{ ...(apart ? spring.pop : spring.snappy), delay: apart ? 0 : d(0.06) }}
      />
    </svg>
  );
}
