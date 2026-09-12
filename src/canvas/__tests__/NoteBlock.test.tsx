// The note block (A3 item 2): the only block the user writes, and the two
// things about it that are law rather than layout. Its NAME is one
// derivation, used twice (the pill when the note is asked about and the
// detail of its delete confirm), so a note whose first line is a bold
// markdown lead reads as words in both places and never as its markers. Its
// cluster is Copy · Ask · More, three hot and none at rest, `More` holding
// the place actions and the confirm-earning `Delete…` (WRITING rule 2's
// ellipsis contract), which is what keeps the count at three.
//
// The compare picker rides beside it here because it is the other half of the
// same wave's menus: the row is disabled, never hidden, on a machine with one
// connection (DESIGN rule 2's matrix).

import { afterAll, describe, expect, test } from "bun:test";

const mem = new Map<string, string>();
const storage: Storage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => void mem.set(k, v),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};
const inert: unknown = new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : inert),
  set: () => true,
  apply: () => undefined,
});
for (const [k, value] of Object.entries({ window: globalThis, localStorage: storage, document: inert })) {
  if (k in globalThis) continue;
  Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
}

// connections.ts subscribes to Tauri events at import; the mock transport is
// what puts `__TAURI_INTERNALS__` on the window (the store tests' own seam)
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
mockIPC(() => undefined);

const { renderToStaticMarkup } = await import("react-dom/server");
const { NoteBlock, noteName } = await import("../NoteBlock");
const { compareWithMenu } = await import("../compareMenu");
const { useConnections } = await import("../../stores/connections");
type NoteData = import("../../stores/canvas").NoteBlock;

afterAll(clearMocks);

const note = (over: Partial<NoteData> = {}): NoteData => ({
  id: "n1",
  kind: "note",
  text: "**For Friday's finance call:**\n- The INR figure is the one to quote.",
  ...over,
});

const html = (over: Partial<NoteData> = {}, editing = false) =>
  renderToStaticMarkup(
    <NoteBlock
      block={note(over)}
      editing={editing}
      onEdit={() => {}}
      onCommit={() => {}}
      onCancel={() => {}}
      onDelete={() => {}}
    />,
  );

describe("a note's name", () => {
  test("the first line, its markdown markers off", () => {
    expect(noteName("**For Friday's finance call:**\n- one\n- two")).toBe("For Friday's finance call:");
    expect(noteName("## A heading\nbody")).toBe("A heading");
    expect(noteName("- a bullet first")).toBe("a bullet first");
    expect(noteName("1. a numbered first")).toBe("a numbered first");
    expect(noteName("> quoted")).toBe("quoted");
  });

  test("blank lines are skipped, and a note with no words has no name", () => {
    expect(noteName("\n\n  the words  \nmore")).toBe("the words");
    expect(noteName("   \n\n")).toBe("");
    expect(noteName("")).toBe("");
  });

  test("a long first line is capped where a saved query's name is", () => {
    const name = noteName(`${"x".repeat(200)}\nrest`);
    expect(name.length).toBe(81);
    expect(name.endsWith("…")).toBe(true);
  });
});

describe("the note block at rest", () => {
  test("nothing frames it, and its cluster is Copy · Ask · More", () => {
    const out = html();
    expect(out).toContain('class="blk blk-note noq"');
    expect([...out.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "Copy",
      "Ask",
      "More",
    ]);
    // the words, in the answer slot's own voice
    expect(out).toContain("ans-text");
    expect(out).toContain("For Friday");
  });

  test("a note an Ask reply wrote carries the question line; one the user wrote does not", () => {
    expect(html({ question: "is the USD share growing?" })).toContain('class="blk-q"');
    expect(html({ question: "is the USD share growing?" })).not.toContain(" noq");
    expect(html()).toContain(" noq");
  });

  // B3: edit is the same box with the RING added, and the ring is the only
  // thing it adds. The composer's own box brought a `--bg-app` fill and a
  // border that stepped from strong to accent with it, which is a darker card
  // and a jump; `.note-box` is now the note's own (note.css)
  test("in edit it is one box and nothing else: no composer fill, no cluster, no buttons", () => {
    const out = html({}, true);
    expect(out).toContain('class="note-box"');
    expect(out).not.toContain("ask-box");
    expect(out).toContain('aria-label="Note"');
    expect(out).not.toContain("acts-float");
    expect(out).not.toContain("<button");
  });
});

describe("Compare With", () => {
  test("the siblings, the compared one checked", () => {
    useConnections.setState({
      profiles: [
        { id: "p1", name: "staging" },
        { id: "p2", name: "prod" },
        { id: "p3", name: "analytics" },
      ] as never,
    });
    const node = compareWithMenu({ profileId: "p1", comparedTo: "p2", onPick: () => {} });
    expect(node.kind).toBe("submenu");
    const items = node.kind === "submenu" ? node.items : [];
    expect(items.map((i) => (i.kind === "item" ? i.label : ""))).toEqual(["prod", "analytics"]);
    expect(items[0].kind === "item" && items[0].hint).toBeTruthy();
    expect(items[1].kind === "item" && items[1].hint).toBeFalsy();
  });

  test("picking the checked one clears the comparison", () => {
    useConnections.setState({ profiles: [{ id: "p1", name: "a" }, { id: "p2", name: "b" }] as never });
    let picked: string | null | undefined;
    const node = compareWithMenu({ profileId: "p1", comparedTo: "p2", onPick: (id) => (picked = id) });
    const items = node.kind === "submenu" ? node.items : [];
    if (items[0].kind === "item") items[0].onSelect();
    expect(picked).toBe(null);
  });

  test("one connection is a row disabled, never a row hidden", () => {
    useConnections.setState({ profiles: [{ id: "p1", name: "only" }] as never });
    const node = compareWithMenu({ profileId: "p1", comparedTo: null, onPick: () => {} });
    expect(node).toMatchObject({ kind: "item", label: "Compare With", disabled: true });
  });
});
