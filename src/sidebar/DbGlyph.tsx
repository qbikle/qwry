import { motion } from "motion/react";
import { prefersReducedMotion, spring } from "../design/springs";

/** The lucide database glyph rebuilt as motion pieces so ⇧⌘R can perform
 * "the rebuild" (stores/refreshFx.ts owns the choreography): the whole
 * glyph spins one revolution per spinTurns bump (cumulative target, so each
 * spring starts from rest), then the disc stack splits — lid lifts first,
 * middle ring slips down after it — and the join reverses the stagger so
 * the lid lands last. Offsets are viewBox units (24 grid at 16px render). */
export function DbGlyph({ apart, spinTurns }: { apart: boolean; spinTurns: number }) {
  const d = (n: number) => (prefersReducedMotion() ? 0 : n);
  return (
    <motion.svg
      className="sb-db-icon"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      style={{ overflow: "visible", transformOrigin: "50% 50%" }}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      initial={false}
      animate={{ rotate: spinTurns * 360 }}
      transition={spring.pop}
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
    </motion.svg>
  );
}
