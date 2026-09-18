// The definition line's grammar (A2 item 3): `term = meaning`, the assumption
// chips' own `=`. Write and parse are one pair, born together (LESSONS 1), and
// they live HERE because both ends need them and they cannot meet anywhere
// else: the palette writes the line through `src/stores/knowledge.ts`, which
// re-exports these two, and prompt.ts reads it back on the way into the user
// message, where a store may never be imported (AGENT-SPEC section 2 rule 2).
// Runtime-free and dependency-free, like every other module under src/agent
// the eval harness also loads.

/** the one separator; kept as a constant so the two halves of the pair can
 * never disagree about what a definition line looks like */
export const DEFINITION_SEP = "=";

/** Read one definition line. Null when either half is empty: an emptied line
 * is a delete, not a definition of nothing. Splits on the FIRST separator, so
 * a meaning may carry its own `=` (`revenue = paid = captured`). */
export function parseDefinition(line: string): { term: string; meaning: string } | null {
  const at = line.indexOf(DEFINITION_SEP);
  if (at < 0) return null;
  const term = line.slice(0, at).trim();
  const meaning = line.slice(at + DEFINITION_SEP.length).trim();
  return term && meaning ? { term, meaning } : null;
}

/** Write one back, in the shape the palette's input reads. */
export function writeDefinition(term: string, meaning: string): string {
  return `${term.trim()} ${DEFINITION_SEP} ${meaning.trim()}`;
}
