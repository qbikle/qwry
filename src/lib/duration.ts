// The status register's one shape for elapsed time (WRITING.md: `12 rows ·
// 3.1 ms`, a space before every unit). Extracted from ResultsPane so the Ask
// answer prints `1861.9 ms`, never the raw float, and both surfaces move
// together.

/** `3.1 ms`, `1861.9 ms` */
export const msText = (ms: number): string => `${ms.toFixed(1)} ms`;

/** `20.4 s`, for spans the footer states in seconds */
export const secondsText = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
