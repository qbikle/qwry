// The Threads sheet's time column: the calendar picks the register (today a
// distance, yesterday the word, older the date), never a 24-hour clock.

import { describe, expect, test } from "bun:test";
import { threadTime } from "../threadTime";

// a Saturday afternoon, local time
const NOW = new Date(2026, 8, 5, 14, 30, 0);
const at = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) =>
  new Date(y, mo, d, h, mi, s).toISOString();

describe("threadTime", () => {
  test("today reads as a distance", () => {
    expect(threadTime(at(2026, 8, 5, 14, 29, 30), NOW)).toBe("just now");
    expect(threadTime(at(2026, 8, 5, 14, 18), NOW)).toBe("12m ago");
    expect(threadTime(at(2026, 8, 5, 11, 30), NOW)).toBe("3h ago");
    expect(threadTime(at(2026, 8, 5, 0, 5), NOW)).toBe("14h ago");
  });

  test("the previous calendar day is yesterday, however many hours ago", () => {
    expect(threadTime(at(2026, 8, 4, 23, 50), new Date(2026, 8, 5, 0, 10))).toBe("yesterday");
    expect(threadTime(at(2026, 8, 4, 8, 0), NOW)).toBe("yesterday");
  });

  test("older threads carry their date, and the year only when it differs", () => {
    expect(threadTime(at(2026, 8, 2), NOW)).toBe("Sep 2");
    expect(threadTime(at(2026, 7, 30), NOW)).toBe("Aug 30");
    expect(threadTime(at(2025, 11, 31), NOW)).toBe("Dec 31, 2025");
  });

  test("a month boundary still reads yesterday", () => {
    expect(threadTime(at(2026, 7, 31, 9, 0), new Date(2026, 8, 1, 9, 0))).toBe("yesterday");
  });

  test("a future or clock-skewed stamp never goes negative", () => {
    expect(threadTime(at(2026, 8, 5, 15, 0), NOW)).toBe("just now");
  });

  test("an unparseable stamp renders nothing rather than NaN", () => {
    expect(threadTime("not a date", NOW)).toBe("");
  });
});
