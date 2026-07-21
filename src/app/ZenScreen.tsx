import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { prefersReducedMotion } from "../design/springs";
import "./app.css";

/** quotes + small thoughts for the zero-tab zen screen — DB-flavored calm */
const THOUGHTS = [
  "The best query is the one you didn’t have to run.",
  "NULL is not nothing. It’s the unknown, politely labeled.",
  "Somewhere, a sequential scan is becoming an index scan.",
  "An empty result set is still an answer.",
  "Normalize until it hurts, denormalize until it works.",
  "The schema you have is a letter from your past self.",
  "Every table was once an idea someone believed in.",
  "ROLLBACK is just the database forgiving you.",
  "A transaction is a promise. COMMIT keeps it.",
  "Rest. The autovacuum is working so you don’t have to.",
  "Deleted tabs, like deleted rows, live on in the WAL of memory.",
  "EXPLAIN before you assume.",
  "The planner already knows. Ask it.",
  "Zero tabs. Zero pending edits. Inner peace.",
  "Even a LEFT JOIN keeps what matters on the left.",
  "Breathe in. VACUUM FULL. Breathe out.",
  "There is no cloud — just someone else’s Postgres.",
  "Your indexes are only as good as your WHERE clauses.",
  "A slow query is a story about your data waiting to be read.",
  "SELECT calm FROM chaos WHERE focus IS NOT NULL;",
  "May your deadlocks be brief and your keys foreign.",
  "The empty page is the fastest page.",
  "First, make it correct. The grid never lies.",
  "Somewhere between BEGIN and COMMIT, everything is possible.",
  "Idle in transaction is a state of mind. Don’t stay in it.",
];

/** monochrome flow-field: a sheet of thin drifting lines, amplitude breathing
 * through a center envelope — pure canvas, ~1ms/frame, dies with the screen */
function Waves() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let dpr = 1;
    const fit = () => {
      const host = canvas.parentElement;
      if (!host) return;
      dpr = window.devicePixelRatio || 1;
      w = host.clientWidth;
      h = host.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // resizing the backing store WIPES the canvas, and ResizeObserver fires
      // AFTER this frame's rAF draw — repaint now or the sheet blanks for the
      // whole duration of a panel slide (inspector ⌘I)
      paint();
    };

    // monochrome: the theme's foreground, whisper-thin
    const fg = getComputedStyle(document.documentElement).getPropertyValue("--fg").trim() || "#ccc";

    const LINES = 42;
    const STEP = 5;
    let t = 0;
    let raf = 0;

    const paint = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 0.7;
      const midLine = (LINES - 1) / 2;
      const spacing = Math.min(9, (h * 0.55) / LINES);
      for (let i = 0; i < LINES; i++) {
        // lines near the sheet's center are brighter; edges fade to nothing
        const d = (i - midLine) / midLine;
        const alpha = 0.02 + 0.09 * Math.exp(-d * d * 3.2);
        ctx.strokeStyle = fg;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        const yBase = h * 0.46 + (i - midLine) * spacing;
        for (let x = 0; x <= w; x += STEP) {
          // three incommensurate sines → fluid, never-repeating drift
          const wave =
            Math.sin(x * 0.0062 + t * 1.7 + i * 0.32) * 16 +
            Math.sin(x * 0.0113 - t * 1.1 + i * 0.18) * 9 +
            Math.sin(x * 0.0027 + t * 0.6 - i * 0.09) * 22;
          // amplitude envelope: calm at the edges, alive in the middle,
          // slowly breathing as a whole
          const ex = Math.exp(-(((x - w / 2) / (w * 0.33)) ** 2));
          const breathe = 0.75 + 0.25 * Math.sin(t * 0.5 + i * 0.05);
          const y = yBase + wave * ex * breathe;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    const draw = () => {
      t += 0.0045;
      paint();
      raf = requestAnimationFrame(draw);
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    // prefers-reduced-motion: the sheet renders once, statically — no drift
    // loop. Tracks the live OS setting so flipping it mid-session applies.
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const start = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      paint();
    };
    if (mq?.matches) paint();
    else start();
    const onMotionPref = (e: MediaQueryListEvent) => (e.matches ? stop() : start());
    mq?.addEventListener?.("change", onMotionPref);

    return () => {
      cancelAnimationFrame(raf);
      mq?.removeEventListener?.("change", onMotionPref);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="zen-canvas" />;
}

/** zero-tab zen: flowing monochrome lines, a rotating thought, the way back */
export function ZenScreen() {
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * THOUGHTS.length));

  useEffect(() => {
    const t = setInterval(
      () =>
        setIdx(
          (i) => (i + 1 + Math.floor(Math.random() * (THOUGHTS.length - 1))) % THOUGHTS.length,
        ),
      14_000,
    );
    return () => clearInterval(t);
  }, []);

  return (
    <div className="zen">
      <Waves />
      <div className="zen-center">
        <div className="zen-quote-box">
          <AnimatePresence mode="wait">
            <motion.p
              key={idx}
              className="zen-quote"
              // collapses under prefers-reduced-motion like the spring
              // presets (read per render — the quote swaps every 14s)
              initial={prefersReducedMotion() ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={prefersReducedMotion() ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={
                prefersReducedMotion()
                  ? { duration: 0 }
                  : { duration: 0.8, ease: "easeOut" }
              }
            >
              {THOUGHTS[idx]}
            </motion.p>
          </AnimatePresence>
        </div>
        <div className="zen-keys">
          {(
            [
              ["⌘T", "new tab"],
              ["⌘K", "command palette"],
              ["⌘Y", "query history"],
              ["⌘?", "all shortcuts"],
            ] as const
          ).map(([k, label]) => (
            <div key={k} className="zen-key-row">
              <kbd>{k}</kbd>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
