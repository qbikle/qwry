// What the connection knows, on its way into the user message (A2 item 4):
// the two blocks prompt.ts renders and the synonym merge context.ts does.
//
// The rule every test here is written around: nothing travels that the
// question did not reach for. A hint rides a candidate table, a definition
// rides its own words appearing in the question, a synonym rides the word
// being typed, and an earlier answer rides sharing vocabulary with what is
// being asked. What does not travel leaves no trace of itself in the block,
// because a header with nothing under it is a fact the model has to unlearn.

import { describe, expect, test } from "bun:test";
import {
  HISTORY_CAP,
  KNOWLEDGE_CAP,
  historyMessage,
  knowledgeMessage,
} from "../prompt";
import {
  buildMeta,
  candidateNames,
  candidates,
  questionTokens,
  synonymMap,
  synonymTable,
  synonymsFired,
} from "../context";
import type { HistoryPair, KnowledgeRow } from "../types";
import type { SchemaSnapshot } from "../../stores/schema";
import snapshot from "./fixtures/pagila-snapshot.json";

const pagila = buildMeta(snapshot as unknown as SchemaSnapshot);

const hint = (target: string, text: string): KnowledgeRow => ({ kind: "hint", target, text });
const syn = (target: string, text: string): KnowledgeRow => ({ kind: "synonym", target, text });
const def = (text: string): KnowledgeRow => ({ kind: "definition", target: null, text });

/** the block builder as the loop calls it: the picks and the tokens come from
 * the same question, so a test that changes one changes both */
function block(
  rows: KnowledgeRow[],
  question: string,
  picks: string[],
  synonyms: Record<string, string> = {},
) {
  return knowledgeMessage({
    rows,
    // the picks as the loop hands them over: every name a table answers to
    // against the one the model sees (context.ts candidateNames)
    names: Object.fromEntries(picks.map((p) => [p, p])),
    tokens: questionTokens(question, synonyms),
    fired: synonymsFired(question, synonyms),
  });
}

describe("the KNOWLEDGE block", () => {
  test("a hint travels for a candidate table and for a column of one, and no other", () => {
    const rows = [
      hint("film", "one row per title, not per copy"),
      hint("film.rating", "MPAA; peek it, the values are not what you think"),
      hint("staff", "two rows, both fake"),
      hint("nowhere.gone", "a table this snapshot no longer has"),
    ];
    const out = block(rows, "how many films are there?", ["film", "actor"]);
    expect(out.hints).toEqual(["film", "film.rating"]);
    expect(out.text).toBe(
      "KNOWLEDGE:\n" +
        "film  -- one row per title, not per copy\n" +
        "film.rating  -- MPAA; peek it, the values are not what you think",
    );
  });

  test("a definition travels when the question carries its words, and not otherwise", () => {
    const rows = [def("active buyer = a customer who rented in the last 30 days")];
    const asked = block(rows, "how many active buyers last month?", ["customer"]);
    expect(asked.definitions).toEqual(["active buyer"]);
    expect(asked.text).toBe(
      "KNOWLEDGE:\nactive buyer: a customer who rented in the last 30 days",
    );
    // one of the two words is not enough: the term is the whole phrase
    expect(block(rows, "how many buyers?", ["customer"]).text).toBe("");
  });

  test("a synonym travels as the word against the object it names", () => {
    const synonyms = { purchases: "payment" };
    const out = block([syn("payment", "purchases")], "purchases last month", ["payment"], synonyms);
    expect(out.synonyms).toEqual(["purchases"]);
    expect(out.text).toBe("KNOWLEDGE:\npurchases -> payment");
  });

  test("a synonym for a table the message does not name teaches nothing", () => {
    // the prefilter pins a live target, so a target missing here is a stale
    // one: naming a table the model cannot see is worse than silence
    const out = block([syn("gone", "purchases")], "purchases last month", ["payment"], {
      purchases: "gone",
    });
    expect(out.text).toBe("");
    expect(out.synonyms).toEqual([]);
  });

  test("objects first, then vocabulary: hints, synonyms, definitions", () => {
    const rows = [
      hint("payment", "one row per settled rental"),
      syn("payment", "purchases"),
      def("last month = the calendar month before this one"),
    ];
    const out = block(rows, "purchases last month", ["payment"], { purchases: "payment" });
    expect(out.text.split("\n").slice(1)).toEqual([
      "payment  -- one row per settled rental",
      "purchases -> payment",
      "last month: the calendar month before this one",
    ]);
  });

  test("nothing to add is no block at all, not an empty header", () => {
    expect(block([], "how many films?", ["film"])).toEqual({
      text: "",
      hints: [],
      definitions: [],
      synonyms: [],
    });
    // rows the question never reached for count as nothing
    expect(block([hint("staff", "two rows")], "how many films?", ["film"]).text).toBe("");
  });

  test("the cap drops whole rows, oldest first, and the names say what survived", () => {
    const long = "x".repeat(200);
    const rows = Array.from({ length: 12 }, (_, i) => hint("film", `${i} ${long}`));
    const out = block(rows, "how many films?", ["film"]);
    expect(out.text.length).toBeLessThanOrEqual(KNOWLEDGE_CAP);
    const lines = out.text.split("\n").slice(1);
    // whole lines: every survivor is exactly the row that was written
    for (const line of lines) expect(line).toMatch(/^film {2}-- \d+ x{200}$/);
    // and the survivors are the newest, the oldest having gone first
    const kept = lines.map((l) => Number(/-- (\d+)/.exec(l)?.[1]));
    expect(kept).toEqual([...kept].sort((a, b) => a - b));
    expect(kept[kept.length - 1]).toBe(11);
    expect(out.hints).toHaveLength(lines.length);
  });

  test("one row longer than the cap is no block, never a halved sentence", () => {
    const out = block([hint("film", "y".repeat(KNOWLEDGE_CAP + 1))], "films?", ["film"]);
    expect(out.text).toBe("");
    expect(out.hints).toEqual([]);
  });

  test("a definition whose term the store put in `target` is read, not dropped", () => {
    const row: KnowledgeRow = {
      kind: "definition",
      target: "active buyer",
      text: "a customer who rented in the last 30 days",
    };
    const out = block([row], "active buyers this week", []);
    expect(out.text).toBe("KNOWLEDGE:\nactive buyer: a customer who rented in the last 30 days");
  });

  test("a hint of several lines is one line: the block is a list of facts", () => {
    const out = block([hint("film", "one row per title\nnot per copy")], "films?", ["film"]);
    expect(out.text).toBe("KNOWLEDGE:\nfilm  -- one row per title not per copy");
  });
});

const pair = (question: string, sql: string): HistoryPair => ({ question, sql });

describe("the EARLIER ANSWERS block", () => {
  // newest first, the order appdb returns
  const PAIRS: HistoryPair[] = [
    pair("how many rentals were late in august", "SELECT count(*) FROM rental WHERE late"),
    pair("which staff member took the most payments", "SELECT staff_id FROM payment"),
    pair("what did rentals look like last year", "SELECT date_trunc('month', rental_date) FROM rental"),
    pair("how many categories are there", "SELECT count(*) FROM category"),
  ];

  test("the questions that share the asked words travel, oldest first", () => {
    const out = historyMessage("how many rentals were late last year?", PAIRS);
    expect(out.questions).toEqual([
      "what did rentals look like last year",
      "how many rentals were late in august",
    ]);
    expect(out.text).toBe(
      "EARLIER ANSWERS ON THIS DATABASE:\n" +
        "Q: what did rentals look like last year\n" +
        "SQL: SELECT date_trunc('month', rental_date) FROM rental\n" +
        "Q: how many rentals were late in august\n" +
        "SQL: SELECT count(*) FROM rental WHERE late",
    );
  });

  test("at most three, however many share a word", () => {
    const many = Array.from({ length: 9 }, (_, i) => pair(`rentals question ${i}`, `SELECT ${i}`));
    expect(historyMessage("rentals", many).questions).toHaveLength(3);
  });

  test("a question is never its own earlier answer: a Restart must look again", () => {
    const asked = "how many categories are there";
    const out = historyMessage(asked, PAIRS);
    expect(out.questions).not.toContain(asked);
  });

  test("nothing in common is no block", () => {
    expect(historyMessage("what is the busiest store?", [PAIRS[3]]).text).toBe("");
    expect(historyMessage("anything", []).text).toBe("");
  });

  test("a statement travels on one line, whatever shape it was written in", () => {
    const out = historyMessage("rentals", [pair("rentals by month", "SELECT 1\n  FROM rental\n")]);
    expect(out.text).toEndWith("SQL: SELECT 1 FROM rental");
  });

  test("the cap drops whole pairs, oldest first", () => {
    const long = "z".repeat(700);
    const many = [
      pair("rentals newest", `SELECT '${long}'`),
      pair("rentals middle", `SELECT '${long}'`),
      pair("rentals oldest", `SELECT '${long}'`),
    ];
    const out = historyMessage("rentals", many);
    expect(out.text.length).toBeLessThanOrEqual(HISTORY_CAP);
    expect(out.questions).toEqual(["rentals middle", "rentals newest"]);
  });
});

describe("synonyms reach the table the prefilter would have missed", () => {
  const rows = [syn("payment", "Purchases"), syn("customer.email", "contact"), syn("payment", "purchases")];

  test("the map is the user's words, lowercased, first row winning", () => {
    expect(synonymMap(rows)).toEqual({ purchases: "payment", contact: "customer.email" });
    expect(synonymMap([def("a = b")])).toEqual({});
  });

  test("only the words the question typed fire, once each, in reading order", () => {
    const map = synonymMap(rows);
    expect(synonymsFired("contact and purchases and purchases again", map)).toEqual([
      { word: "contact", target: "customer.email" },
      { word: "purchases", target: "payment" },
    ]);
    expect(synonymsFired("how many films?", map)).toEqual([]);
  });

  test("a target names its own table, a column names its owner, a ghost names nothing", () => {
    expect(synonymTable(pagila, "payment")).toBe("payment");
    expect(synonymTable(pagila, "customer.email")).toBe("customer");
    expect(synonymTable(pagila, "gone")).toBe(null);
    expect(synonymTable(pagila, "gone.column")).toBe(null);
  });

  test("the word puts its table in front of the lexical picks", () => {
    const question = "how many purchases last month?";
    const bare = candidates(question, pagila);
    const withSyn = candidates(question, pagila, undefined, [], { purchases: "payment" });
    expect(withSyn[0]).toBe("payment");
    expect(bare[0]).not.toBe("payment");
    // the picks give way rather than being dropped, as a tag's do
    expect(withSyn).toContain(bare[0]);
    expect(withSyn.length).toBeLessThanOrEqual(22);
  });

  test("a column's synonym brings its table, and a stale one costs the question nothing", () => {
    expect(candidates("who is the contact?", pagila, undefined, [], { contact: "customer.email" })[0]).toBe(
      "customer",
    );
    expect(candidates("how many films?", pagila, undefined, [], { films: "gone" })).toEqual(
      candidates("how many films?", pagila),
    );
  });

  test("a user's word means what the user said, over the static map", () => {
    // `purchase` is SYN's own word for `order`; here it names a table instead
    expect(questionTokens("purchase count").has("order")).toBe(true);
    expect(questionTokens("purchase count", { purchase: "payment" }).has("order")).toBe(false);
  });

  test("no synonyms, no change: the measured picks are the picks", () => {
    for (const q of ["how many films?", "which actor appears most", "revenue by month"]) {
      expect(candidates(q, pagila, undefined, [], {})).toEqual(candidates(q, pagila));
    }
  });

  // the store mints every target schema-qualified while the model sees the
  // bare display name: without the map between them nothing a user writes
  // ever reaches a message (the A2 integration's own bug)
  test("a stored target is qualified and still meets the pick it names", () => {
    const names = candidateNames(pagila, ["film", "payment"]);
    expect(names["public.film"]).toBe("film");
    const out = knowledgeMessage({
      rows: [
        hint("public.film", "one row per title, not per copy"),
        hint("public.film.rating", "MPAA"),
        hint("public.staff", "two rows, both fake"),
      ],
      names,
      tokens: questionTokens("how many films?"),
      fired: synonymsFired("how many purchases?", { purchases: "public.payment" }),
    });
    // the block prints the model's own name for the thing, never the key
    expect(out.text).toBe(
      "KNOWLEDGE:\n" +
        "film  -- one row per title, not per copy\n" +
        "film.rating  -- MPAA\n" +
        "purchases -> payment",
    );
    expect(out.hints).toEqual(["film", "film.rating"]);
    expect(synonymTable(pagila, "public.customer.email")).toBe("customer");
  });
});
