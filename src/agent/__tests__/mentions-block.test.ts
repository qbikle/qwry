// The `@` ladder's fifth rung (A3 item 4, AGENT-UX section 16d): a canvas
// block, named by its own question in the quoted form saved queries and
// threads already use. Its own file so the W6 suite next door keeps reading
// as the grammar's, and because everything here is one rung's: the order it
// resolves in (last, under saved query and thread, since it is the only kind
// naming something the user built rather than something the connection has),
// the round trip between what `canonicalToken` writes and what
// `parseMentions` reads back (LESSONS 1), and what a tagged block tells the
// model, which is its question, its statement and the SHAPE of its rows and
// never the rows themselves (DESIGN rule 14: they stand on the canvas).

import { describe, expect, test } from "bun:test";
import {
  canonicalToken,
  MENTION_TEXT_CAP,
  mentionContext,
  mentionsIn,
  mentionTags,
  type BlockRef,
  type CanvasRef,
  type MentionCtx,
} from "../mentions";
import type { SavedQuery } from "../../stores/saved";
import type { Thread } from "../types";

const REVENUE = "can you check the revenue in last month";

const revenueBlock: BlockRef = {
  id: "b1",
  name: REVENUE,
  sql: "SELECT SUM(total_amount) FROM order_v2\nWHERE payment_status = 'paid'",
  columns: ["revenue", "order_count", "currency"],
  rowCount: 4,
};

const note: BlockRef = {
  id: "b2",
  name: "For Friday's finance call",
  text: "For Friday's finance call: the INR figure is the one to quote.",
};

const SAVED: SavedQuery[] = [{ id: "s1", name: "Monthly revenue", sql: "SELECT 1;" }];
const THREADS: Thread[] = [
  { id: "t1", profileId: "p", title: "Monthly revenue", createdAt: "2026-09-06T00:00:00Z" },
];

const CTX: MentionCtx = {
  snapshot: null,
  saved: SAVED,
  threads: THREADS,
  currentThreadId: null,
  blocks: [revenueBlock, note],
};

const kinds = (text: string) => mentionsIn(text, CTX).map((m) => `${m.kind}:${m.token}`);

describe("a canvas block on the ladder", () => {
  test("a block resolves by its name, quoted the way a saved query is", () => {
    expect(canonicalToken("block", revenueBlock)).toBe(`@"${REVENUE}"`);
    const [one] = mentionsIn(`${canonicalToken("block", revenueBlock)} is the USD share growing?`, CTX);
    expect(one.kind).toBe("block");
    expect(one.ref).toEqual(revenueBlock);
    // the span covers the `@` and both quotes, so the pill paints exactly it
    expect(one.span).toEqual([0, REVENUE.length + 3]);
  });

  test("a name doubles its quotes and reads back whole", () => {
    const odd: BlockRef = { id: "b3", name: 'the "paid" rows', sql: null };
    const token = canonicalToken("block", odd);
    expect(token).toBe('@"the ""paid"" rows"');
    const [hit] = mentionsIn(token, { ...CTX, blocks: [odd] });
    expect(hit?.kind).toBe("block");
    expect(hit?.ref).toEqual(odd);
  });

  test("the block is the LAST rung: a saved query of the same name still wins", () => {
    const twin: BlockRef = { id: "b9", name: "Monthly revenue" };
    expect(kinds('@"Monthly revenue"')).toEqual(["saved:\"Monthly revenue\""]);
    expect(mentionsIn('@"Monthly revenue"', { ...CTX, blocks: [twin] })[0].kind).toBe("saved");
  });

  test("a name nothing holds is plain text and the question still runs", () => {
    expect(kinds('@"a block that was deleted"')).toEqual([]);
    expect(mentionsIn(`@"${REVENUE}"`, { ...CTX, blocks: [] })).toEqual([]);
  });

  test("no blocks at all is a rung with nothing on it, never a throw", () => {
    const { blocks: _gone, ...bare } = CTX;
    expect(mentionsIn(`@"${REVENUE}"`, bare)).toEqual([]);
  });

  test("the context carries the question, the statement and the SHAPE, not the rows", () => {
    expect(mentionContext(mentionsIn(`@"${REVENUE}"`, CTX))).toBe(
      `canvas block "${REVENUE}":\n${revenueBlock.sql}\n4 rows: revenue, order_count, currency`,
    );
  });

  test("a note carries its words, and a bare block is one line", () => {
    expect(mentionContext(mentionsIn(`@"${note.name}"`, CTX))).toBe(
      `canvas block "${note.name}":\n${note.text}`,
    );
    const bare: BlockRef = { id: "b4", name: "just a name" };
    expect(mentionContext(mentionsIn('@"just a name"', { ...CTX, blocks: [bare] }))).toBe(
      'canvas block "just a name"',
    );
  });

  test("one row reads as one row", () => {
    const one: BlockRef = { id: "b5", name: "how many", columns: ["n"], rowCount: 1 };
    expect(mentionContext(mentionsIn('@"how many"', { ...CTX, blocks: [one] }))).toBe(
      'canvas block "how many":\n1 row: n',
    );
  });

  test("a long statement is cut and says so", () => {
    const big: BlockRef = { id: "b6", name: "big", sql: `SELECT ${"x".repeat(4000)}` };
    const out = mentionContext(mentionsIn('@"big"', { ...CTX, blocks: [big] }));
    expect(out.endsWith("\n… (truncated)")).toBe(true);
    expect(out.length).toBe('canvas block "big":\n'.length + MENTION_TEXT_CAP + "\n… (truncated)".length);
  });

  test("the same block tagged twice is one line", () => {
    const twice = `@"${REVENUE}" and @"${REVENUE}" again`;
    expect(mentionContext(mentionsIn(twice, CTX)).split("canvas block").length - 1).toBe(1);
  });

  test("the trace names the kind and the token, the `@` already gone", () => {
    expect(mentionTags(mentionsIn(`@"${REVENUE}"`, CTX))).toEqual([
      { kind: "block", token: `"${REVENUE}"` },
    ]);
  });
});

// A whole canvas is the ladder's SEVENTH kind (B2 landed the rung, B3 gave it
// its own kind): one pill species and one LayoutGrid glyph still serve a
// canvas and a block, because both name something the user built, but the two
// send different things. A block is CONTEXT (its statement, the shape of its
// rows); a canvas is a DESTINATION, and where an answer goes is stated once,
// by the CANVAS block the loop appends, so the tag writes no context line at
// all (DESIGN rule 14). The rung is APPENDED under the block's, so no
// collision that already had an answer got a new one.

describe("a whole canvas on the seventh rung", () => {
  const CANVASES: CanvasRef[] = [
    { id: "cv1", title: "August finance" },
    { id: "cv2", title: "Canvas" },
  ];
  const WITH: MentionCtx = { ...CTX, canvases: CANVASES };
  const august = CANVASES[0];

  test("a canvas resolves by its title, quoted the way a block is", () => {
    expect(canonicalToken("canvas", august)).toBe('@"August finance"');
    const [one] = mentionsIn('@"August finance" this week', WITH);
    expect(one.kind).toBe("canvas");
    expect(one.ref).toEqual(august);
    expect(one.span).toEqual([0, 17]);
  });

  test("canonicalToken and parseMentions are a pair over a hostile title", () => {
    const odd: CanvasRef = { id: "cv3", title: 'the "August" canvas' };
    const token = canonicalToken("canvas", odd);
    expect(token).toBe('@"the ""August"" canvas"');
    const [one] = mentionsIn(`${token} please`, { ...CTX, canvases: [odd] });
    expect(one.kind).toBe("canvas");
    expect(one.ref).toEqual(odd);
    expect(one.span).toEqual([0, token.length]);
  });

  test("the canvas rung is under the block's: a block of the same title wins", () => {
    const twin: BlockRef = { id: "b7", name: "August finance" };
    expect(mentionsIn('@"August finance"', { ...WITH, blocks: [twin] })[0].ref).toEqual(twin);
  });

  test("a saved query of the same title still wins over both", () => {
    const named: MentionCtx = { ...WITH, saved: [{ id: "s9", name: "August finance", sql: "SELECT 9;" }] };
    expect(mentionsIn('@"August finance"', named)[0].kind).toBe("saved");
  });

  test("a canvas sends no context line: the CANVAS block names it, once", () => {
    expect(mentionContext(mentionsIn('@"August finance"', WITH))).toBe("");
    expect(mentionTags(mentionsIn('@"August finance"', WITH))).toEqual([
      { kind: "canvas", token: '"August finance"' },
    ]);
  });

  test("a block beside a canvas still sends its own line, and only that", () => {
    const both = `@"August finance" beside @"${REVENUE}"`;
    expect(mentionContext(mentionsIn(both, WITH))).toStartWith(`canvas block "${REVENUE}"`);
    expect(mentionContext(mentionsIn(both, WITH))).not.toContain("August finance");
  });

  test("a title no open canvas has is plain text and the question still runs", () => {
    expect(mentionsIn('@"Returns by city"', WITH)).toEqual([]);
    expect(mentionsIn('@"August finance"', CTX)).toEqual([]);
  });

  test("`@canvases/` reaches the same tag as the bare quoted form", () => {
    const [one] = mentionsIn('@canvases/"August finance"', WITH);
    expect(one.token).toBe('"August finance"');
    expect(one.kind).toBe("canvas");
    expect(one.ref).toEqual(august);
  });
});
