// When a thread was started, in the status register, for the Threads sheet:
// today reads as a distance (`just now`, `12m ago`, `3h ago`, the history
// panel's own form), yesterday is the word, anything older is its date
// (`Sep 2`; `Sep 2, 2025` once the year differs). The calendar decides the
// register, not a 24-hour clock: a thread from 23:50 read at 00:10 is
// `yesterday`, the way Notes and Finder say it. Pure: `now` is a parameter so
// the shape is testable and the fixture harness can pin it.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function threadTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  if (sameDay(t, now)) {
    const s = Math.max(0, Math.floor((now.getTime() - t.getTime()) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(t, yesterday)) return "yesterday";
  const date = `${MONTHS[t.getMonth()]} ${t.getDate()}`;
  return t.getFullYear() === now.getFullYear() ? date : `${date}, ${t.getFullYear()}`;
}
