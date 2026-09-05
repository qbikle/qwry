// The display strip (DESIGN rule 14): the answer slot shows interpretation
// only; the grid, the SQL row and the chips hold the data. Fixtures are the
// two texts the W2 taste pass photographed rendering raw under a grid that
// already showed them: the `breakdown.## Answer` block (two turns' text
// concatenated, a markdown table, a fence, quoted-sentence assumptions) and a
// bulleted Assumptions list. Property tests: whatever blocks are mixed in,
// nothing with its own slot survives and the prose does, unchanged.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { answerText, footerStatus, renderInline } from "../display";
import { parseAssumptions } from "../extract";

const W2_BREAKDOWN = `I found the notification_history table which has a sent_at timestamp. Let me get the monthly breakdown.## Answer

Here are the notification histories added each month in 2026:

| month | notification_count |
|-------|-------------------:|
| 2026-01-01 | 491528 |
| 2026-02-01 | 3062 |
| 2026-08-01 | 2949786 |
| 2026-09-01 | 327759 |

Total: **4,647,023** notifications this year, with a large spike in August.

\`\`\`sql
SELECT date_trunc('month', sent_at)::date AS month, COUNT(*) AS notification_count
FROM notification_history
WHERE sent_at >= '2026-01-01' AND sent_at < '2027-01-01'
GROUP BY 1
ORDER BY 1
\`\`\`

Assumptions: "Added" was interpreted as the \`sent_at\` timestamp, the only timestamp column on the table; "This year" means calendar year 2026`;

const W2_BULLETED = `Counted by \`sent_at\`, the only timestamp on the table. 4.65M this year, 2.95M of it in August.

\`\`\`sql
SELECT count(*) FROM notification_history
\`\`\`

**Assumptions:**
- "Added" refers to the sent_at column.
- Deleted users are excluded.
- "This year" means 2026.

---
## Notes
1. The August spike is real.`;

const html = (s: string) => renderToStaticMarkup(createElement("span", null, ...renderInline(s)));

describe("answerText", () => {
  test("the W2 breakdown block keeps its prose and loses every slot the anatomy owns", () => {
    const out = answerText(W2_BREAKDOWN);
    expect(out).not.toContain("## Answer");
    expect(out).not.toContain("#");
    expect(out).not.toContain("|");
    expect(out).not.toContain("```");
    expect(out).not.toContain("SELECT");
    expect(out).not.toMatch(/assumptions/i);
    expect(out).not.toContain("calendar year");
    expect(out).toContain("Let me get the monthly breakdown.");
    expect(out).toContain("Here are the notification histories added each month in 2026:");
    expect(out).toContain("Total: **4,647,023** notifications this year, with a large spike in August.");
    expect(out.endsWith("August.")).toBe(true);
  });

  test("the bulleted Assumptions list goes with its header, and so do the rule and heading after it", () => {
    const out = answerText(W2_BULLETED);
    expect(out).toBe(
      "Counted by `sent_at`, the only timestamp on the table. 4.65M this year, 2.95M of it in August.\n\nThe August spike is real.",
    );
  });

  test("what the display strips is exactly what the chips parse", () => {
    // the same span: every stated assumption lands once, as a chip
    expect(parseAssumptions(W2_BREAKDOWN)).toHaveLength(2);
    expect(parseAssumptions(W2_BULLETED)).toEqual([
      '"Added" refers to the sent_at column',
      "Deleted users are excluded",
      '"This year" means 2026',
    ]);
    for (const label of parseAssumptions(W2_BULLETED)) {
      expect(answerText(W2_BULLETED)).not.toContain(label);
    }
  });

  test("an unterminated fence disappears while it streams", () => {
    expect(answerText("Counted by sent_at.\n\n```sql\nSELECT count(*) FR")).toBe("Counted by sent_at.");
    expect(answerText("Counted by sent_at.\n\n```")).toBe("Counted by sent_at.");
  });

  test("a table without leading pipes still goes, a lone dash stays", () => {
    const out = answerText("Two months stand out.\n\nmonth | count\n--- | ---\n2026-08 | 2949786\n\nA - B is fine.");
    expect(out).toBe("Two months stand out.\n\nA - B is fine.");
  });

  test("list markers and links flatten to their text", () => {
    expect(answerText("- first\n2. second\n* [docs](https://x.y)\n![img](https://x.y/a.png)")).toBe(
      "first\nsecond\ndocs",
    );
  });

  test("plain prose is returned as written", () => {
    const s = "Counted by `sent_at`, the only timestamp on the table. 4.65M this year, **2.95M** of it in August.";
    expect(answerText(s)).toBe(s);
    expect(answerText("")).toBe("");
    expect(answerText("   \n\n  ")).toBe("");
  });
});

describe("renderInline", () => {
  test("bold and code become elements, nothing else does", () => {
    expect(html("Counted by `sent_at`, **2.95M** in August, *not* a list, [x](y)")).toBe(
      "<span>Counted by <code>sent_at</code>, <b>2.95M</b> in August, *not* a list, [x](y)</span>",
    );
  });

  test("an empty string renders no node at all, so the live region stays :empty", () => {
    expect(renderInline("")).toEqual([]);
    expect(html("")).toBe("<span></span>");
  });

  test("unbalanced markers stay literal", () => {
    expect(html("a ** b ` c")).toBe("<span>a ** b ` c</span>");
    expect(html("**bold** and `x`")).toBe("<span><b>bold</b> and <code>x</code></span>");
  });
});

describe("footerStatus", () => {
  test("the status register with a space before every unit", () => {
    expect(footerStatus(1, 20_400, "Sonnet 5")).toBe("1 turn · 20.4 s · Sonnet 5");
    expect(footerStatus(3, 1_861.9, "Haiku 4.5")).toBe("3 turns · 1.9 s · Haiku 4.5");
  });

  test("a reloaded thread knows neither its turns nor its time, so it prints neither", () => {
    expect(footerStatus(0, 0, "Sonnet 5")).toBe("Sonnet 5");
    expect(footerStatus(0, 20_400, "Sonnet 5")).toBe("20.4 s · Sonnet 5");
  });
});

// ---- properties -------------------------------------------------------------

/** deterministic LCG so a failing seed is reproducible */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const PROSE = [
  "Counted by `sent_at`, the only timestamp on the table.",
  "4.65M this year, **2.95M** of it in August.",
  "Two months stand out; the rest are flat.",
  "The spike follows the campaign launch.",
];
const NOISE = [
  "```sql\nSELECT count(*) FROM t\n```",
  "```\nSELECT 1\n```",
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "a | b\n--- | ---\n1 | 2",
  "## Answer",
  "# Result",
  "---",
  "***",
  "Assumptions: Added = sent_at; This Year = 2026",
  "**Assumptions:**\n- one\n- two",
  "Assumptions: none",
];

function compose(seed: number): { raw: string; prose: string[] } {
  const r = rng(seed);
  const parts: string[] = [];
  const prose: string[] = [];
  const n = 2 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    if (r() < 0.5) {
      const p = PROSE[Math.floor(r() * PROSE.length)];
      prose.push(p);
      parts.push(p);
    } else {
      parts.push(NOISE[Math.floor(r() * NOISE.length)]);
    }
  }
  return { raw: parts.join(r() < 0.5 ? "\n\n" : "\n"), prose };
}

describe("properties", () => {
  test("no fence, table, heading, rule or Assumptions line survives; idempotent", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { raw } = compose(seed);
      const out = answerText(raw);
      expect(out, `seed ${seed}`).not.toContain("```");
      expect(out, `seed ${seed}`).not.toMatch(/^[ \t]*\|/m);
      expect(out, `seed ${seed}`).not.toMatch(/^[ \t]*#{1,6}[ \t]/m);
      expect(out, `seed ${seed}`).not.toMatch(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/m);
      expect(out, `seed ${seed}`).not.toMatch(/assumptions[*_]*\s*:/i);
      expect(out, `seed ${seed}`).not.toContain("SELECT");
      expect(answerText(out), `seed ${seed}`).toBe(out);
    }
  });

  test("prose survives verbatim, in order, when a blank line separates it from the noise", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const parts: string[] = [];
      const prose: string[] = [];
      const n = 2 + Math.floor(r() * 5);
      for (let i = 0; i < n; i++) {
        if (r() < 0.5) {
          const p = PROSE[Math.floor(r() * PROSE.length)];
          prose.push(p);
          parts.push(p);
        } else {
          parts.push(NOISE[Math.floor(r() * NOISE.length)]);
        }
      }
      const out = answerText(parts.join("\n\n"));
      let at = 0;
      for (const p of prose) {
        const i = out.indexOf(p, at);
        expect(i, `seed ${seed}: ${JSON.stringify(p)} missing from ${JSON.stringify(out)}`).toBeGreaterThanOrEqual(0);
        at = i + p.length;
      }
    }
  });

  test("renderInline round-trips: the concatenated text of the nodes is the input", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const { raw } = compose(seed);
      const text = answerText(raw);
      if (seen.has(text)) continue;
      seen.add(text);
      const nodes = renderInline(text);
      const joined = nodes
        .map((n) =>
          typeof n === "string"
            ? n
            : (() => {
                const el = n as { type: string; props: { children: string } };
                return el.type === "b" ? `**${el.props.children}**` : `\`${el.props.children}\``;
              })(),
        )
        .join("");
      expect(joined, `seed ${seed}`).toBe(text);
    }
  });
});
