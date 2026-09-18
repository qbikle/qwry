// What the user knows and the catalog does not (A2): a hint on a table or a
// column, the names this database's people call it by, and the terms they use.
// Rows belong to a connection and are loaded with it, like its threads and its
// bookmarks; nothing here leaves the machine except into the model's own user
// message (AGENT-SPEC section 4.2).
//
// Two grammars live in this file, each a write/parse pair born together
// (LESSONS 1): the HINT LINE, `<hint> aka <name>, <name>`, which the Structure
// view edits as one text over a hint row and one synonym row per name; and the
// DEFINITION LINE, `term = meaning`, the assumption chips' own grammar, which
// the palette edits as one text over one row. The hint line is written and
// parsed here; the definition line's own pair lives in `src/agent/definitions`
// and is re-exported below, because the loop reads that line back and may not
// import a store. Either way one grammar has one home (LESSONS 1).

import { create } from "zustand";
import { parseDefinition, writeDefinition } from "../agent/definitions";
import {
  agentKnowledgeDelete,
  agentKnowledgeList,
  agentKnowledgeUpsert,
} from "../ipc/commands";
import type { KnowledgeRow } from "../ipc/types";

export type { KnowledgeKind, KnowledgeRow } from "../ipc/types";

/** A hint line's two halves. `hint` is what the line says about the object;
 * `synonyms` are the names its `aka` clause gives it, in the order typed. */
export interface HintLine {
  hint: string;
  synonyms: string[];
}

/** One definition, as the palette shows it: term in the row, meaning in the
 * detail slot. */
export interface Definition {
  id: string;
  term: string;
  meaning: string;
}

/** The object a hint or a synonym hangs on, and the one place that key is
 * spelled. Always schema-qualified, so a target is two segments for a table
 * and three for a column: a bare relation name would let `orders.status` mean
 * either a column of `orders` or a table `status` in schema `orders`, and the
 * rows outlive whichever the catalog holds today. */
export function knowledgeTarget(schema: string, table: string, column?: string): string {
  const rel = `${schema}.${table}`;
  return column ? `${rel}.${column}` : rel;
}

/** The trailing `aka` clause: the LAST ` aka ` followed by comma-separated
 * identifier-shaped names, to the end of the line. Prose that says "aka"
 * mid-sentence keeps it, because what follows is not a list of names. */
const AKA = /(?:^|\s)aka\s+([A-Za-z_][A-Za-z0-9_$]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_$]*)*)\s*$/;

/** Read one hint line. The grammar decides, not the caller: a line that ends
 * in an `aka` clause HAS synonyms, whoever typed it. */
export function parseHintLine(line: string): HintLine {
  const text = line.trim();
  const m = AKA.exec(text);
  if (!m) return { hint: text, synonyms: [] };
  const seen = new Set<string>();
  const synonyms: string[] = [];
  for (const name of m[1].split(",")) {
    const n = name.trim();
    if (n && !seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      synonyms.push(n);
    }
  }
  return { hint: text.slice(0, m.index).trim(), synonyms };
}

/** Write one hint line back. `parseHintLine(writeHintLine(parseHintLine(s)))`
 * equals `parseHintLine(s)` for every string: a stored hint can never end in a
 * clause, because it came through the parse that would have taken one. */
export function writeHintLine({ hint, synonyms }: HintLine): string {
  const h = hint.trim();
  if (!synonyms.length) return h;
  const clause = `aka ${synonyms.join(", ")}`;
  return h ? `${h} ${clause}` : clause;
}

/** The definition grammar is `src/agent/definitions.ts`'s: the palette writes
 * a line here and prompt.ts reads it back into the user message, where a store
 * may never be imported (AGENT-SPEC section 2 rule 2), so the pair lives on
 * the side both can reach and this file passes it on. */
export { parseDefinition, writeDefinition } from "../agent/definitions";

type Rows = readonly KnowledgeRow[] | undefined;

const of = (rows: Rows, kind: KnowledgeRow["kind"], target: string) =>
  (rows ?? []).filter((r) => r.kind === kind && r.target === target);

/** The one line the Structure view shows for a table or a column: the hint it
 * carries plus the names it answers to. Empty when the object has neither. */
export function hintLineFor(rows: Rows, target: string): string {
  return writeHintLine({
    hint: of(rows, "hint", target)[0]?.text ?? "",
    synonyms: of(rows, "synonym", target).map((r) => r.text),
  });
}

/** This connection's definitions, oldest first. A row whose text no longer
 * parses is dropped rather than shown half-read. */
export function definitionsOf(rows: Rows): Definition[] {
  const out: Definition[] = [];
  for (const r of rows ?? []) {
    if (r.kind !== "definition") continue;
    const d = parseDefinition(r.text);
    if (d) out.push({ id: r.id, ...d });
  }
  return out;
}

interface KnowledgeState {
  /** rows per connection, oldest first (the order the prompt's capped
   * KNOWLEDGE block drops from) */
  rows: Record<string, KnowledgeRow[]>;
  load: (profileId: string) => Promise<void>;
}

export const useKnowledge = create<KnowledgeState>()((set) => ({
  rows: {},

  load: async (profileId) => {
    const rows = await agentKnowledgeList(profileId);
    set((s) => ({ rows: { ...s.rows, [profileId]: rows } }));
  },
}));

const held = (profileId: string) => useKnowledge.getState().rows[profileId] ?? [];

/** Save a table's or a column's whole line: the hint and its `aka` clause are
 * one text on screen and one gesture here. An emptied line deletes everything
 * the object carried, which is how a hint and a synonym are both removed. */
export async function saveHintLine(profileId: string, target: string, line: string): Promise<void> {
  // the rows this line stands for, read before the first await (LESSONS 3)
  const rows = held(profileId);
  const hintRow = of(rows, "hint", target)[0];
  const synRows = of(rows, "synonym", target);
  const next = parseHintLine(line);

  if (!next.hint && hintRow) await agentKnowledgeDelete(hintRow.id);
  else if (next.hint && next.hint !== hintRow?.text) {
    await agentKnowledgeUpsert({
      id: hintRow?.id ?? crypto.randomUUID(),
      profile_id: profileId,
      kind: "hint",
      target,
      text: next.hint,
    });
  }

  // a name the line no longer gives goes; one it already had keeps its row, so
  // re-typing the same clause is not the same fact written again
  const kept = new Set(next.synonyms.map((w) => w.toLowerCase()));
  for (const r of synRows) {
    if (!kept.has(r.text.toLowerCase())) await agentKnowledgeDelete(r.id);
  }
  const had = new Map(synRows.map((r) => [r.text.toLowerCase(), r]));
  for (const word of next.synonyms) {
    const row = had.get(word.toLowerCase());
    if (row?.text === word) continue;
    await agentKnowledgeUpsert({
      id: row?.id ?? crypto.randomUUID(),
      profile_id: profileId,
      kind: "synonym",
      target,
      text: word,
    });
  }
  await useKnowledge.getState().load(profileId);
}

/** The definition this connection holds for a term, whatever case it was
 * typed in: a term is one fact, not one per capitalisation. */
const definitionFor = (profileId: string, term: string) =>
  definitionsOf(held(profileId)).find((d) => d.term.toLowerCase() === term.trim().toLowerCase());

/** Save `term = meaning`. A term already defined is rewritten where it stands,
 * so defining it twice leaves one row, as the palette's list shows. */
export async function saveDefinition(
  profileId: string,
  term: string,
  meaning: string,
): Promise<void> {
  const existing = definitionFor(profileId, term);
  await agentKnowledgeUpsert({
    id: existing?.id ?? crypto.randomUUID(),
    profile_id: profileId,
    kind: "definition",
    target: null,
    text: writeDefinition(term, meaning),
  });
  await useKnowledge.getState().load(profileId);
}

/** Clear a definition: the palette's `term` with an emptied meaning. Unknown
 * terms are not an error, because the gesture is "this is not defined". */
export async function removeDefinition(profileId: string, term: string): Promise<void> {
  const existing = definitionFor(profileId, term);
  if (!existing) return;
  await agentKnowledgeDelete(existing.id);
  await useKnowledge.getState().load(profileId);
}
