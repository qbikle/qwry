// ask-frames: pixel evidence for the Ask pane (DESIGN.md rules 9 and 13, the
// taste-gate skill). Renders the fixture harness route of the vite dev server
// in headless Chrome and writes one PNG per state × width × theme.
//
//   bun scripts/ask-frames.ts [--out <dir>] [--states a,b] [--widths 320,560]
//                             [--themes dark,light] [--scroll top] [--port 1420]
//                             [--jobs 6]
//
//   --harness  ask (default), palette or structure: which root to drive. The
//              palette is a modal over the window, so it has one width (620)
//              and its own taller frame (states a2-palette,a2-define,
//              a2-checks); the Structure view is a tab's surface at 560,780,
//              1040 (states a2-hint,a2-hint-edit,a2-hint-rest,a2-hint-aka)
//   --out      where the PNGs land; default
//              ~/projects/qwry-agent-lab/docs/research/w2d-frames
//   --states   subset of answer,empty,busy,picker,failure,disconnected,small,
//              pending,retry,strip,threads,scalar,kv,wide,trace,echo,echo-long,
//              starters,starters-fallback,qwrying,qwrying-trail,kv-wide,
//              actions,actions-latest,actions-busy,edit,edit-latest,edit-stack,
//              insight,insight-prose,insight-steps,insight-code,insight-stream,
//              mention-popover,mention-draft,mention-first,mention-echo,
//              mention-trace,result-table,result-sql,result-scalar,failure-cap,
//              answer-actions,followups-end,a2-explain,a2-knowledge-trace,
//              a2-ask-why
//              (default: all forty-seven)
//   --widths   subset of 320,392,560 (default: all three)
//   --themes   subset of dark,light (default: both)
//   --scroll   bottom (default): the pane as it mounts, pinned to the newest content,
//              the footer and composer in view; top: the scroller at the question
//              echo and the thinking strip instead (the 640px card cannot hold the
//              whole live answer, so the two ends are two runs). Frames of a top run
//              carry a -top suffix so the two sets sit side by side. The `strip`,
//              `kv-wide`, `insight*` and `result*` states park at the top by default
//              (the harness's own default for them: their subject sits above the fold);
//              an EXPLICIT `--scroll bottom` reaches the harness as `scroll=bottom`
//              and pins them like every other state, so their footers can be framed
//   --port     the vite dev server to use when one already answers (default 1420);
//              otherwise vite is started on a free port for the run and stopped after
//   --jobs     Chrome processes in flight at once (default 6)
//
// Output: <out>/<state>-<width>-<theme>[-top].png, 2× device scale, a viewport
// of (width + 48) × 688 so the 640px card sits in one gutter of app background.
// Prints the list, exits 1 if any frame is missing or empty.
//
// Each frame is one headless Chrome driven over CDP (--remote-debugging-port=0,
// the port read from the profile's DevToolsActivePort): navigate, poll until
// AskHarness has stamped data-harness-ready (its post-mount effect: picker
// opened, scroller parked), wait SETTLE_MS of real time, Page.captureScreenshot
// at deviceScaleFactor 2, kill. Chrome's own --screenshot path was the flaky
// half of this script: under --virtual-time-budget the shot landed before the
// motion entry springs had advanced (one busy frame in three lost its
// thinking-strip chips) or before the portaled popover's layer had rastered
// (an empty popover box, a missing row), and without a budget it shot before
// the window was sized. A real settle after a DOM-level ready mark produced two
// consecutive runs that were pixel-identical except the busy spinner's phase.
//
// Chrome runs with prefers-reduced-motion forced on: a frame is a still of the
// SETTLED state, so every springs.ts preset is its instant variant and
// tokens.css collapses the CSS transitions, which is the product's own settled
// face, not a harness costume. Motion itself is the dev build's eyeball, never
// a still's. Focus emulation is on (Emulation.setFocusEmulationEnabled): a
// headless page believes it has the window's focus, so the focus rings the
// product paints when a surface focuses something on open (the Threads
// sheet's hot row, the trace's focused step) render in the still instead of
// being dropped by an unfocused document.
//
// The route: /?harness=ask&state=<state>&w=<width>&theme=<theme>[&scroll=top],
// mounted by
// src/main.tsx in DEV builds only (src/harness/AskHarness.tsx). The fixture
// data is src/harness/fixtures.ts: connection `staging` on `auth_new`, a
// five-table schema the starters draw from, and the locked sketch's exchange
// (a sixty-five-character question, three tool chips, one-or-two-sentence
// answer, the result block on its table face with the raw ms float under it,
// three assumption chips, three follow-ups, `1 turn · 20.4 s · Sonnet 5`;
// the collapsed SQL row is the block's second face since W7). busy =
// streaming with a spinner chip; failure = a SQL error with the editable
// field; picker = the answer with the model popover open; disconnected = the
// starters with no session (textarea disabled, pill dimmed); small = the
// starters under a small-tier choice (the one pill that wears a badge).
//
// Round 2 (the sketch's second row; fixtures.interact.ts, fixtures.shell.ts,
// fixtures.anatomy.ts): pending = the answer with one assumption chip off and
// the retry pill over the composer; retry = a retry streaming over the prior
// answer, a running `run` chip in the strip and the Stop face, the old prose,
// grid and footer still on screen; strip = nine tool chips scrolled to 120 so
// both edge fades show (parked at the top by default); threads = the Threads
// sheet over the answer, five threads, the current row .active and the second
// .hot with its delete revealed; scalar = one row × one column as a value
// with its caption; kv = one row × three columns, name over value; wide = six
// rows × twelve columns, the grid scrolling both ways; trace = the answer
// with its drawer open from the footer link, the context step expanded.
//
// Round 3 (the sketch's "Discussion" rows; fixtures.echo.ts,
// fixtures.starters.ts, fixtures.strip.ts): echo = the sketch's discussion
// thread, two exchanges, each question a tinted bubble at the right edge
// (variant B) with the anatomy left; the bottom frame shows the second bubble
// over the composer, the -top frame the first (both at 560-top); echo-long =
// one exchange whose question wraps to five lines inside the bubble at 320;
// starters = the configured empty state over a seeded generated pool at
// cursor 3, so the SECOND triple shows (`Which channels have the highest open
// rate?` · `How many sessions did each platform see this month?` · `Which
// signup sources bring users who build wardrobes?`); starters-fallback = the
// same with no pool: the heuristic twelve over the fixture schema from cursor
// 0, minus the fixture thread's own title (a question already asked in a
// thread of the connection is never a starter), so the triple reads `Which
// users have the most notification histories?` · `How are notification
// histories split by notification type?` · `How many users have no
// notification histories?`, the `empty` state's three since the pool rotates;
// qwrying = a question just sent, the strip holding `qwrying…` alone and the
// Stop face; qwrying-trail = two landed chips and the word trailing them;
// kv-wide = one row × three columns, name over value, a stack at 320 and a
// row of pairs at 560 (parked at the top by default, like strip). Chrome runs
// with reduced motion forced, so the two qwrying frames show the static word
// by design; the sweep is the dev build's eyeball.
//
// W4 (the sketch's "message actions and jumping back" rows; fixtures.actions.ts,
// fixtures.edit.ts): the discussion thread plus a third exchange, a
// ninety-one-character question over a value. actions = the second bubble hot
// (Copy · Restart · Jump Back beside it, forced through data-hot since a still
// cannot hover), the scroller parked at that exchange, the sketch's rest;
// actions-latest = the newest bubble hot at the bottom pin; actions-busy = the
// second bubble hot while the third streams: Restart and Jump Back disabled,
// Copy live, the Stop face; edit = edit mode at the second exchange: its
// question in the focused composer, the exchange gone (variant B), the third
// standing as its dimmed bubble alone; edit-latest = the newest in the
// composer, the first two whole; edit-stack = the second of FOUR exchanges (a
// 41-character follow-up after the third) in the composer, so the third and
// fourth fold together, two dimmed bubbles --sp-2 apart where the thread
// gives 28px, the one still that shows the stack's closed gap. Reduced motion
// means no travel ghost: the textarea holds the text at once.
//
// W5 (the sketch's "rich answer text" rows; fixtures.rich.ts): one exchange
// each over the order_v2 thread on Haiku 4.5, parked at the top by default
// (the text is the subject). insight = `what stood out in orders last month`:
// a lead-in in the trace-kind register over three bullets, each one finding
// with its figure, then the nine-row grid the bullets never restate;
// insight-prose = a which-column question with no run: a sentence, the
// model's own three-column comparison as the readOnly grid, a closing
// sentence with a link whose text is an identifier in code; insight-steps = a
// how-do-I question with no run: the table's comment quoted under the lead-in
// that names it, then the two steps as the one ordered list; insight-code =
// a count over a value with the JSON shape peek found as a non-SQL code block
// in the editor register, the filter it implies a chip; insight-stream = the
// insight exchange mid-stream, every chip landed, the second bullet cut
// mid-sentence, the Stop face.
//
// W6 (the sketch's "@ context tags" rows; fixtures.mentions.ts,
// fixtures.mentions-echo.ts): the discussion thread's first exchange over
// the order_v2 schema on Haiku 4.5. mention-popover = the composer holding
// `which @ord`, focused, the `@` popover standing over the box at its width:
// Tables `order_v2` · `erp_order_cost_snapshot` with their row estimates,
// Columns `order_v2.order_status` · `erp_order_cost_snapshot.order_id` ·
// `.order_ref` with their types (at 320 the table part ellipsizes and the
// column stays whole), Saved Queries `Orders by day`, Threads `how many
// orders were refunded in August`, the first row hot; headless Chrome paints
// no caret, so the box's focus border is the focus evidence (the edit
// states' precedent); mention-draft = the composer holding `compare
// @order_v2 with @"Monthly revenue" for August` with two pills behind the
// glyphs, the second wrapping with its words at 320; mention-echo = the same
// question sent, the bubble wearing both pills (three lines at its cap at
// 320, the second pill split across the wrap at 392, one line at 560), the
// scroller parked at that exchange; mention-trace = its trace open at the
// context step, `tagged order_v2 · "Monthly revenue"` over the block whose
// last lines are the TAGGED BY THE USER block the loop sent.
//
// W7 (the sketch's "consolidate" rows; fixtures.result.ts, fixtures.answer.ts,
// and `mention-first` in fixtures.mentions.ts): result-table = the orders
// exchange with the block hot, the nine-row grid under Copy · Flip · Insert
// and `9 rows · 412.6 ms` under the block, no SQL row anywhere; result-sql =
// the same block flipped to its SQL face, the statement in the editor register
// wrapped at the floor and the flip's glyph now the table; result-scalar = a
// one-row run as its value inside the block's own padding; failure-cap = the
// turn cap's `stopped after 12 turns` over the widest action row the pane has,
// Fix It · Insert SQL · Continue · Ask Differently, which is a rule-13 question
// at 320; answer-actions = the answer's own cluster (Copy · Save Query)
// revealed at the prose's top-right; followups-end = the three-exchange thread
// with ONE follow-up row, under the last answer, the older two carrying none;
// mention-first = `@pipeline_products` as the draft's first token, the frame
// that catches the pill's left edge against the box's.
//
// The first frame runs alone so vite compiles the module graph once; the rest
// run in parallel. Whole run: ~60 s warm for the full matrix.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_OUT = join(homedir(), "projects/qwry-agent-lab/docs/research/w2d-frames");

const ALL_STATES = [
  "answer",
  "empty",
  "busy",
  "picker",
  "failure",
  "disconnected",
  "small",
  "pending",
  "retry",
  "strip",
  "threads",
  "scalar",
  "kv",
  "wide",
  "trace",
  "echo",
  "echo-long",
  "starters",
  "starters-fallback",
  "qwrying",
  "qwrying-trail",
  "kv-wide",
  "actions",
  "actions-latest",
  "actions-busy",
  "edit",
  "edit-latest",
  "edit-stack",
  "insight",
  "insight-prose",
  "insight-steps",
  "insight-code",
  "insight-stream",
  "mention-popover",
  "mention-draft",
  "mention-first",
  "mention-echo",
  "mention-trace",
  "result-table",
  "result-sql",
  "result-scalar",
  "failure-cap",
  "answer-actions",
  "followups-end",
  "a4-preview",
  "a4-preview-warn",
  "a4-preview-sql",
  "a4-ran",
  "a4-preview-busy",
  "a4-writes-off",
  "a2-explain",
  "a2-knowledge-trace",
  "a2-ask-why",
] as const;
/** the second root (A2): the palette is a modal over the window, not a pane in
 * a card, so it has one width, its own (`src/harness/PaletteHarness.tsx`) */
const PALETTE_STATES = ["a2-palette", "a2-define", "a2-checks"] as const;
/** the third root (A2 item 2): the hint line lives in the Structure view, a
 * tab's whole width (`src/harness/StructureHarness.tsx`) */
const STRUCTURE_STATES = ["a2-hint", "a2-hint-edit", "a2-hint-rest", "a2-hint-aka"] as const;
const ALL_WIDTHS = [320, 392, 560] as const;
const PALETTE_WIDTHS = [620] as const;
const STRUCTURE_WIDTHS = [560, 780, 1040] as const;
/** the palette's list and the Structure view both run longer than an answer:
 * their windows are taller */
const PALETTE_H = 900;
const STRUCTURE_H = 900;
const ALL_THEMES = ["dark", "light"] as const;
const SCROLLS = ["bottom", "top"] as const;
type Scroll = (typeof SCROLLS)[number];
type State =
  | (typeof ALL_STATES)[number]
  | (typeof PALETTE_STATES)[number]
  | (typeof STRUCTURE_STATES)[number];
type Width =
  | (typeof ALL_WIDTHS)[number]
  | (typeof PALETTE_WIDTHS)[number]
  | (typeof STRUCTURE_WIDTHS)[number];
type Theme = (typeof ALL_THEMES)[number];

/** the harness card is 640 tall inside one --sp-6 gutter on every side */
const CARD_H = 640;
const MARGIN = 24;

// ---- args -------------------------------------------------------------------

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function subset<T extends string | number>(raw: string | undefined, all: readonly T[], what: string): T[] {
  if (!raw) return [...all];
  const picked = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out: T[] = [];
  for (const p of picked) {
    const hit = all.find((a) => String(a) === p);
    if (hit === undefined) {
      console.error(`ask-frames: unknown ${what} "${p}" (choose from ${all.join(", ")})`);
      process.exit(2);
    }
    out.push(hit);
  }
  return out;
}

const OUT = resolve(flag("out") ?? DEFAULT_OUT);
/** which root to drive: the Ask pane, or the palette's own (A2) */
const HARNESS = flag("harness") ?? "ask";
if (HARNESS !== "ask" && HARNESS !== "palette" && HARNESS !== "structure") {
  console.error(`ask-frames: unknown harness "${HARNESS}" (choose from ask, palette, structure)`);
  process.exit(2);
}
const PALETTE = HARNESS === "palette";
const STRUCTURE = HARNESS === "structure";
const ROOT_STATES = PALETTE ? PALETTE_STATES : STRUCTURE ? STRUCTURE_STATES : ALL_STATES;
const ROOT_WIDTHS = PALETTE ? PALETTE_WIDTHS : STRUCTURE ? STRUCTURE_WIDTHS : ALL_WIDTHS;
const STATES = subset<State>(flag("states"), ROOT_STATES, "state");
const WIDTHS = subset<Width>(flag("widths"), ROOT_WIDTHS, "width");
const THEMES = subset<Theme>(flag("themes"), ALL_THEMES, "theme");
const SCROLL = subset<Scroll>(flag("scroll"), SCROLLS, "scroll")[0] ?? "bottom";
/** `--scroll bottom` written out overrides the harness's own top-parking states */
const SCROLL_EXPLICIT = flag("scroll") !== undefined;
const PORT = Number(flag("port") ?? 1420);
const JOBS = Math.max(1, Number(flag("jobs") ?? 6));
/** a frame that has not been captured by then is a failure */
const FRAME_CAP_MS = 45_000;
/** real time between the harness's ready mark and the shot: fonts, the
 * portaled popover's layer and the grid's ResizeObserver pass land inside it */
const SETTLE_MS = 700;
/** AskHarness stamps this in its post-mount effect */
const READY = 'document.documentElement.dataset.harnessReady === "1"';

// ---- the dev server -----------------------------------------------------------

async function answering(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function freePort(): number {
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = srv.port;
  srv.stop(true);
  return port;
}

/** processes still bound to the port after the spawn was killed (bunx may
 * have handed vite to node); killed so a run never leaks a server */
function killPort(port: number) {
  const r = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`]);
  const pids = r.stdout.toString().split("\n").map((s) => s.trim()).filter(Boolean);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      // already gone
    }
  }
}

async function ensureServer(): Promise<{ port: number; stop: () => void }> {
  if (await answering(PORT)) return { port: PORT, stop: () => {} };
  const port = freePort();
  const log = Bun.file(join(OUT, "vite.log"));
  const proc = Bun.spawn(["bunx", "vite", "--port", String(port), "--strictPort"], {
    cwd: ROOT,
    stdout: log,
    stderr: log,
  });
  const stop = () => {
    proc.kill();
    killPort(port);
  };
  process.on("SIGINT", () => {
    stop();
    process.exit(130);
  });
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (await answering(port)) {
      console.log(`ask-frames: vite started on ${port} (log: ${join(OUT, "vite.log")})`);
      return { port, stop };
    }
    await Bun.sleep(250);
  }
  stop();
  console.error(`ask-frames: vite did not answer on ${port} within 40 s; see ${join(OUT, "vite.log")}`);
  process.exit(1);
}

// ---- frames -------------------------------------------------------------------

interface Frame {
  state: State;
  w: Width;
  theme: Theme;
  file: string;
}

const frames: Frame[] = [];
for (const state of STATES)
  for (const w of WIDTHS)
    for (const theme of THEMES)
      frames.push({
        state,
        w,
        theme,
        file: join(OUT, `${state}-${w}-${theme}${SCROLL === "top" ? "-top" : ""}.png`),
      });

interface Cdp {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
}

/** the page target of a Chrome started with --remote-debugging-port=0 */
async function connect(profile: string, deadline: number): Promise<Cdp> {
  const portFile = join(profile, "DevToolsActivePort");
  let port = 0;
  while (Date.now() < deadline && port === 0) {
    if (existsSync(portFile)) port = Number(readFileSync(portFile, "utf8").split("\n")[0]) || 0;
    if (port === 0) await Bun.sleep(50);
  }
  if (port === 0) throw new Error("DevToolsActivePort never appeared");
  let target: { webSocketDebuggerUrl: string } | undefined;
  while (Date.now() < deadline && !target) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      target = list.find((t) => t.type === "page");
    } catch {
      // not listening yet
    }
    if (!target) await Bun.sleep(50);
  }
  if (!target) throw new Error("no page target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("devtools socket refused"));
  });
  let id = 0;
  const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (d.id === undefined) return;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.error) p.rej(new Error(d.error.message));
    else p.res(d.result);
  };
  return {
    send: (method, params = {}) =>
      new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
      }),
    close: () => ws.close(),
  };
}

async function shoot(base: string, f: Frame): Promise<boolean> {
  const url = PALETTE
    ? `${base}/?harness=palette&state=${f.state}&theme=${f.theme}`
    : STRUCTURE
      ? `${base}/?harness=structure&state=${f.state}&w=${f.w}&theme=${f.theme}`
      : `${base}/?harness=ask&state=${f.state}&w=${f.w}&theme=${f.theme}` +
        (SCROLL === "top" || SCROLL_EXPLICIT ? `&scroll=${SCROLL}` : "");
  const width = f.w + 2 * MARGIN;
  const height = (PALETTE ? PALETTE_H : STRUCTURE ? STRUCTURE_H : CARD_H) + 2 * MARGIN;
  const profile = mkdtempSync(join(tmpdir(), "ask-frames-"));
  const proc = Bun.spawn(
    [
      CHROME,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-prefers-reduced-motion",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      `--window-size=${width},${height}`,
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const deadline = Date.now() + FRAME_CAP_MS;
  let cdp: Cdp | null = null;
  try {
    rmSync(f.file, { force: true });
    cdp = await connect(profile, deadline);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await cdp.send("Page.enable");
    // the page believes it is the focused window, so :focus-visible paints
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await cdp.send("Page.navigate", { url });
    let ready = false;
    while (Date.now() < deadline && !ready) {
      const r = (await cdp.send("Runtime.evaluate", { expression: READY, returnByValue: true })) as {
        result?: { value?: unknown };
      };
      ready = r.result?.value === true;
      if (!ready) await Bun.sleep(100);
    }
    if (!ready) throw new Error("harness never became ready");
    await Bun.sleep(SETTLE_MS);
    const shot = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
    const bytes = Buffer.from(shot.data, "base64");
    if (bytes.length === 0) return false;
    writeFileSync(f.file, bytes);
    return true;
  } catch (e) {
    console.error(`ask-frames: ${f.state}-${f.w}-${f.theme}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    cdp?.close();
    proc.kill();
    await proc.exited;
    rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  if (!existsSync(CHROME)) {
    console.error(`ask-frames: Chrome not found at ${CHROME}`);
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const server = await ensureServer();
  const base = `http://localhost:${server.port}`;
  const started = Date.now();
  const ok = new Map<string, boolean>();

  try {
    // one frame alone warms vite's module graph; then the pool
    const [first, ...rest] = frames;
    if (first) ok.set(first.file, await shoot(base, first));
    let next = 0;
    const worker = async () => {
      while (next < rest.length) {
        const f = rest[next++];
        ok.set(f.file, await shoot(base, f));
      }
    };
    await Promise.all(Array.from({ length: Math.min(JOBS, rest.length) }, worker));
  } finally {
    server.stop();
  }

  const missing = frames.filter((f) => !ok.get(f.file));
  for (const f of frames) console.log(`${ok.get(f.file) ? "ok     " : "MISSING"} ${f.file}`);
  console.log(
    `ask-frames: ${frames.length - missing.length}/${frames.length} frames in ${((Date.now() - started) / 1000).toFixed(1)} s → ${OUT}`,
  );
  if (missing.length > 0) process.exit(1);
}

await main();
