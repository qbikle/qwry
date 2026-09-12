// A tagged DRAWING (C2b): the one ref whose content is not a sentence. The
// grammar has to do two things with it and nothing else - say in the TAGGED
// block where the picture IS, and hand the loop the sheets to render - and
// both halves are read out of the same tags, in the same order, deduped by
// the same key, so the words and the pictures of one question can never
// disagree about what was tagged (DESIGN rule 14).
//
// The line is worded by the ROUTE and not by the wire, because the same wire
// carries a picture on one run and nothing on the next: `claude -p` reaches a
// drawing only through `canvas_read`, and that tool is offered only to a run
// with a canvas target. A line promising an attachment on a run that carries
// none is the silent drop maintainer call 3 forbids, and it is the model that
// pays for it (see also providers/__tests__/images.test.ts for the route
// itself, and canvas-read-block.test.ts for what the tool answers).

import { describe, expect, test } from "bun:test";
import {
  canonicalToken,
  mentionContext,
  mentionDrawings,
  mentionsIn,
  type BlockRef,
  type MentionCtx,
} from "../mentions";

const drawing: BlockRef = { id: "d1f2a3b4", name: "Drawing 2", drawing: true, canvasId: "cv-1" };
const note: BlockRef = { id: "b2", name: "Friday's call", text: "the INR figure is the one to quote" };

const CTX: MentionCtx = {
  snapshot: null,
  saved: [],
  threads: [],
  currentThreadId: null,
  blocks: [drawing, note],
};

const tag = (ref: BlockRef) => canonicalToken("block", ref);

describe("a drawing on the ladder", () => {
  test("on a wire that carries one, the line says the picture came with it", () => {
    const tags = mentionsIn(`what did i draw in ${tag(drawing)}`, CTX);
    expect(mentionContext(tags, "message")).toBe(
      'canvas block "Drawing 2":\na drawing, attached as an image',
    );
    expect(mentionDrawings(tags)).toEqual([{ id: "d1f2a3b4", canvasId: "cv-1" }]);
  });

  test("on the tool route, the line hands the model the door and its handle", () => {
    const tags = mentionsIn(`what did i draw in ${tag(drawing)}`, CTX);
    expect(mentionContext(tags, "tool")).toBe(
      'canvas block "Drawing 2":\na drawing: call canvas_read with block_id d1f2 to see it',
    );
  });

  test("with no route at all, the line says so rather than promising a picture", () => {
    const tags = mentionsIn(`what did i draw in ${tag(drawing)}`, CTX);
    const said = mentionContext(tags, "none");
    expect(said).toBe('canvas block "Drawing 2":\na drawing; its picture cannot travel on this connection');
    expect(said).not.toContain("attached");
  });

  test("a tag with no ink sends nothing, and says nothing about a picture", () => {
    const tags = mentionsIn(`${tag(note)} what is the number`, CTX);
    expect(mentionContext(tags, "message")).not.toContain("image");
    expect(mentionDrawings(tags)).toEqual([]);
  });

  test("one drawing tagged twice is one picture, the way its line is one line", () => {
    const tags = mentionsIn(`${tag(drawing)} vs ${tag(drawing)}`, CTX);
    expect(
      mentionContext(tags, "message")
        .split("\n")
        .filter((l) => l.startsWith("canvas block")),
    ).toHaveLength(1);
    expect(mentionDrawings(tags)).toHaveLength(1);
  });

  test("drawings come back in the order they were typed, and only from blocks", () => {
    const second: BlockRef = { id: "d2", name: "Drawing 3", drawing: true, canvasId: "cv-1" };
    const ctx: MentionCtx = { ...CTX, blocks: [drawing, second, note] };
    const tags = mentionsIn(`${tag(second)} beside ${tag(drawing)} and ${tag(note)}`, ctx);
    expect(mentionDrawings(tags).map((d) => d.id)).toEqual(["d2", "d1f2a3b4"]);
  });

  test("a ref remembered before this wave has no canvas, so it names none", () => {
    const old: BlockRef = { id: "d3", name: "Drawing 9", drawing: true };
    const ctx: MentionCtx = { ...CTX, blocks: [old] };
    const tags = mentionsIn(`${tag(old)} what is this`, ctx);
    expect(mentionDrawings(tags)).toEqual([{ id: "d3" }]);
  });
});
