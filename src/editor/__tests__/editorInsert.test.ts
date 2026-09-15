// The Insert seam (D1 item 1): the Ask pane's Insert appends a whole
// statement to the query tab instead of splitting whatever the caret was
// sitting inside. Two things are under test: the arithmetic of the append
// (where it lands, what precedes it, where the caret ends up), and the same
// arithmetic applied to a real CodeMirror document, so the spec this seam
// dispatches is checked against the buffer it changes and not only against
// itself. The view is the one thing not stood up: `scrollIntoView` and focus
// are the view's to keep, and a headless doc cannot hold either.
//
// SqlEditor is a component module: importing it pulls the stores, which paint
// the theme onto `document` and register Tauri listeners at load. The shims
// below are agent-writes.test.ts's, for the same reason.

import { describe, expect, test } from "bun:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { EditorState } from "@codemirror/state";

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
for (const k of ["window", "localStorage", "document", "navigator"].filter((k) => !(k in globalThis))) {
  Object.defineProperty(globalThis, k, {
    value: k === "window" ? globalThis : k === "localStorage" ? storage : inert,
    configurable: true,
    writable: true,
  });
}
mockIPC(() => undefined);

const { appendInsert } = await import("../SqlEditor");

const STMT = "SELECT count(*) FROM order_v2;";

/** the append as the seam dispatches it: the last two characters of the doc
 * are all it reads, which is what the editor does with a live buffer */
const append = (doc: string, text = STMT) => {
  const state = EditorState.create({ doc });
  const len = state.doc.length;
  const spec = appendInsert(len, state.doc.sliceString(Math.max(0, len - 2), len), text);
  const next = state.update({
    changes: { from: spec.from, insert: spec.insert },
    selection: { anchor: spec.anchor },
  }).state;
  return { doc: next.doc.toString(), anchor: next.selection.main.anchor, spec };
};

describe("the pane's Insert appends", () => {
  test("an empty tab takes the statement alone, with no leading newline", () => {
    const out = append("");
    expect(out.doc).toBe(STMT);
    expect(out.spec.insert).toBe(STMT);
    expect(out.anchor).toBe(0);
  });

  test("a tab with text takes it after one blank line", () => {
    const out = append("SELECT 1;");
    expect(out.doc).toBe(`SELECT 1;\n\n${STMT}`);
    expect(out.spec.insert.startsWith("\n\n")).toBe(true);
  });

  test("a buffer that already ends in newlines gets one blank line, never three", () => {
    expect(append("SELECT 1;\n").doc).toBe(`SELECT 1;\n\n${STMT}`);
    expect(append("SELECT 1;\n\n").doc).toBe(`SELECT 1;\n\n${STMT}`);
    // more than one blank line was the user's own spacing: nothing is taken away
    expect(append("SELECT 1;\n\n\n").doc).toBe(`SELECT 1;\n\n\n${STMT}`);
  });

  test("the caret lands on the statement's first character, never on its end", () => {
    const out = append("SELECT 1;");
    expect(out.anchor).toBe("SELECT 1;\n\n".length);
    expect(out.doc.slice(out.anchor)).toBe(STMT);
    expect(out.anchor).toBeLessThan(out.doc.length);
  });

  test("where the caret was is not where the statement goes", () => {
    // the caret sits in the middle of the buffer, the state a user leaves a
    // tab in; the append reads the doc's END and nothing else
    const state = EditorState.create({ doc: "SELECT 1;\nSELECT 2;", selection: { anchor: 4 } });
    const len = state.doc.length;
    const spec = appendInsert(len, state.doc.sliceString(len - 2, len), STMT);
    expect(spec.from).toBe(len);
    const next = state.update({
      changes: { from: spec.from, insert: spec.insert },
      selection: { anchor: spec.anchor },
    }).state;
    expect(next.doc.toString()).toBe(`SELECT 1;\nSELECT 2;\n\n${STMT}`);
    expect(next.doc.sliceString(next.selection.main.anchor)).toBe(STMT);
  });

  test("a multi-line statement arrives whole", () => {
    const multi = "UPDATE order_v2\nSET payment_status = 'paid'\nWHERE id = 90312;";
    const out = append("SELECT 1;", multi);
    expect(out.doc).toBe(`SELECT 1;\n\n${multi}`);
    expect(out.doc.slice(out.anchor)).toBe(multi);
  });

  // the pane has two Inserts, the block's cluster and the failure block's
  // field, and both are one call (ResultBlock `insertSql`). What they ask the
  // editor for is the END, so the two can never drift into two landings
  test("the pane's one seam asks the editor for the end, the sidebar's for the caret", async () => {
    const editor = await import("../SqlEditor");
    const { insertSql } = await import("../../ask/ResultBlock");
    const asked: [string, string | undefined][] = [];
    const was = editor.editorInsert.current;
    editor.editorInsert.current = (text, where) => void asked.push([text, where]);
    insertSql(STMT, "a tab");
    await until(() => asked.length > 0);
    expect(asked).toEqual([[STMT, "end"]]);

    // the sidebar's own gesture is unchanged: no second argument, the caret
    editor.editorInsert.current(" quantity");
    expect(asked[1]).toEqual([" quantity", undefined]);
    editor.editorInsert.current = was;
  });
});

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(pred()).toBe(true);
};
