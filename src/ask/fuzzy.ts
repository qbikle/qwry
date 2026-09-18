// The picker's match (B2 item 2), replacing W7's substring test: the filter's
// characters as a SUBSEQUENCE of the name the user would type, scored so that
// the reading a human means comes out on top. `pflg` has to reach
// `product_flatlay_generations` and `ta` has to reach `tables/`, which a
// substring test cannot do at any price.
//
// Pure and allocation-light by law: the popover calls this once per candidate
// on every keystroke (~200 tables, ~4000 columns), and typing is never
// animated, so the whole pass has to finish inside one frame. `fuzzy.test.ts`
// pins ≤1 ms for 500 rows.
//
// Two tiers stand ABOVE the scored subsequence and are returned flat, so a
// name the user typed the beginning of can never be pushed under a clever
// subsequence: an exact match, then a prefix match. Every prefix match scores
// the SAME, so ties fall through to the caller's own order (tables largest
// first, columns by position, saved queries and threads as their lists hold
// them) exactly as they did before B2.
//
// Inside the subsequence tier the score is the sum of what each matched
// character is worth less what each skipped one costs, and the search is for
// the BEST assignment, not the leftmost one: `ta` against `product_metadata`
// means the `ta` of `metadata` (a run) and not the `t` of `product` with an
// `a` five characters later, and a greedy scan would find only the second.
// That is one small dynamic program per candidate, the fzy/fzf shape: `d[j]`
// the best score whose last matched character sits at j, `m[j]` the same with
// the cost of sliding right folded in, which is what lets the gap penalty
// depend on WHERE the previous character matched.
//
// The weights are fzy's, scaled, with one addition: a filter whose first
// character is the NAME's first character is worth more than any other
// bonus. It is the strongest signal short of a prefix, and it is what makes
// `pflg` mean `pipeline_flatlay_logs` rather than
// `wardrobe_products_flatlay_grid`, whose four word starts would otherwise
// win. The sketch's own `pflg` order is the pin.

/** an exact match (case-insensitive): nothing outranks it */
export const FUZZY_EXACT = 1_000_000;
/** the name STARTS with the whole filter. One score for every prefix match,
 * so the caller's own order breaks the tie */
export const FUZZY_PREFIX = 100_000;
/** an empty filter matches everything at one score: the caller's order is
 * the whole ranking, which is what the sectioned view wants */
export const FUZZY_ANY = 1;

/** the filter's first character IS the name's first character */
const B_HEAD = 210;
/** the character follows the previous match with no gap: a contiguous run is
 * worth more than any single boundary */
const B_RUN = 100;
/** the character opens a word: after `_`, a dot, a slash, a space or a dash */
const B_WORD = 80;
/** the upper half of a camel step (`MonthlyRevenue`) */
const B_CAMEL = 70;
/** per character skipped BEFORE the first match, and per character skipped
 * between two matches: small enough to break near-ties only */
const GAP_LEADING = 0.5;
const GAP_INNER = 1;

/** Every subsequence match is reported above zero, because zero is the answer
 * to "no match". The gaps are the only negative term and cost at most
 * `GAP_INNER` per character of the name, so this floor clears them. */
const FLOOR = 200;

/** how much of a long name the subsequence search walks. A name longer than
 * this ellipsized in its 28px row long ago; the cost is bounded, the floor
 * above stays above the worst gap penalty, and the tail that cannot be read
 * is not searched */
export const FUZZY_MAX_LEN = 160;

/** what ends a word inside a name: `_` in an identifier, `.` in a path, `/`
 * in a category, and the spaces and dashes of a saved query's or a thread's
 * own title */
const SEP = /[_\-./:\s]/;

const NEG = -1e9;

/** Scratch rows for the dynamic program, grown once and reused: one call per
 * candidate per keystroke, and four allocations each would be most of the
 * budget. Single-threaded and never held across a call, so the function is
 * still pure in everything a caller can observe. */
const scratch = {
  size: 0,
  dPrev: new Float64Array(0),
  mPrev: new Float64Array(0),
  d: new Float64Array(0),
  m: new Float64Array(0),
};

function fit(n: number): void {
  if (scratch.size >= n) return;
  scratch.size = n;
  scratch.dPrev = new Float64Array(n);
  scratch.mPrev = new Float64Array(n);
  scratch.d = new Float64Array(n);
  scratch.m = new Float64Array(n);
}

/** what position j is worth before the run bonus, read off the ORIGINAL name
 * (a camel step is invisible once lowercased) */
function wordBonus(name: string, j: number): number {
  if (j === 0) return B_HEAD;
  const prev = name[j - 1];
  if (SEP.test(prev)) return B_WORD;
  const at = name[j];
  return prev !== prev.toUpperCase() && at !== at.toLowerCase() ? B_CAMEL : 0;
}

/** Is `q` a subsequence of `c`? The cheap reject, run before the dynamic
 * program: most candidates fail here and cost one scan. */
function subsequence(q: string, c: string): boolean {
  let i = 0;
  for (let j = 0; j < c.length && i < q.length; j++) if (c[j] === q[i]) i++;
  return i === q.length;
}

/** How well `name` answers `query`: 0 for no match, `FUZZY_ANY` for an empty
 * query, `FUZZY_PREFIX` and `FUZZY_EXACT` for the two tiers, else the best
 * assignment of the query's characters, always above zero. */
export function fuzzyScore(query: string, name: string): number {
  if (query.length === 0) return FUZZY_ANY;
  if (name.length === 0 || query.length > name.length) return 0;
  const q = query.toLowerCase();
  const whole = name.toLowerCase();
  if (q === whole) return FUZZY_EXACT;
  if (whole.startsWith(q)) return FUZZY_PREFIX;

  const c = whole.length > FUZZY_MAX_LEN ? whole.slice(0, FUZZY_MAX_LEN) : whole;
  if (q.length > c.length || !subsequence(q, c)) return 0;

  // the bonuses read the original casing, but only when lowercasing kept the
  // length (a few scripts change it, and misaligned indices would score the
  // wrong characters); otherwise the camel step is simply invisible
  const raw = whole.length === name.length ? name : whole;

  const n = q.length;
  const len = c.length;
  fit(len);
  let { d, m, dPrev, mPrev } = scratch;
  let best = NEG;

  for (let i = 0; i < n; i++) {
    const want = q[i];
    const last = i === n - 1;
    best = NEG;
    let slide = NEG;
    for (let j = 0; j < len; j++) {
      let here = NEG;
      if (c[j] === want) {
        const bonus = wordBonus(raw, j);
        if (i === 0) here = bonus - j * GAP_LEADING;
        else if (j > 0) {
          // one step right of the previous match, or any earlier position
          // with the slide's accumulated gap already paid
          const joined = dPrev[j - 1] <= NEG ? NEG : dPrev[j - 1] + (bonus > B_RUN ? bonus : B_RUN);
          const gapped = mPrev[j - 1] <= NEG ? NEG : mPrev[j - 1] + bonus;
          here = joined > gapped ? joined : gapped;
        }
        if (here > best) best = here;
      }
      d[j] = here;
      // m carries the cost of reaching j from wherever the best match stands,
      // so the NEXT character's gap is priced by distance, not by count
      slide = slide <= NEG ? here : Math.max(here, slide - GAP_INNER);
      m[j] = slide;
    }
    if (last) break;
    const td = dPrev;
    const tm = mPrev;
    dPrev = d;
    mPrev = m;
    d = td;
    m = tm;
  }

  // the last character pays no trailing gap: a match early in a long name is
  // not worse for the tail it did not use
  return best <= NEG ? 0 : FLOOR + best;
}
