// The environment a `claude -p` child gets from the harness (EVAL.md section
// 3): the twin of agent_claude.rs's child_env_carries_the_login_and_nothing_else.
// The harness's shell carries the credentials that built `--dsn`; the child
// must see the allowlist and nothing else (AGENT-SPEC section 8.3), through
// the real spawn, not a view of it.

import { describe, expect, test } from "bun:test";
import { ENV_PASSTHROUGH, childEnv, createNodePlatform } from "../platform.node";

const SENTINEL = "QWRY_TEST_SENTINEL";

async function withStray<T>(fn: () => Promise<T>): Promise<T> {
  process.env.ANTHROPIC_API_KEY = "sk-test-must-not-leak";
  process.env[SENTINEL] = "s3cr3t";
  try {
    return await fn();
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env[SENTINEL];
  }
}

describe("the harness's child environment", () => {
  test("carries the login and nothing else", async () => {
    await withStray(async () => {
      const env = childEnv();
      const keys = Object.keys(env);
      expect(keys).toContain("PATH");
      expect(keys).toContain("HOME");
      expect(keys).not.toContain("ANTHROPIC_API_KEY");
      expect(keys).not.toContain(SENTINEL);
      for (const k of keys) expect(ENV_PASSTHROUGH).toContain(k);
    });
  });

  test("a spawned child sees neither a stray key nor the shell's secrets", async () => {
    await withStray(async () => {
      const platform = createNodePlatform({ toolsFor: () => undefined, claudeBin: "/bin/sh" });
      const proc = platform.spawn(
        "claude",
        ["-c", `printf '%s\\n' "K=$ANTHROPIC_API_KEY" "S=$${SENTINEL}" "H=$HOME"`],
        "",
      );
      const lines: string[] = [];
      for await (const line of proc.lines) lines.push(line);
      const { code } = await proc.exit;
      expect(code).toBe(0);
      expect(lines).toContain("K=");
      expect(lines).toContain("S=");
      expect(lines).toContain(`H=${process.env.HOME}`);
    });
  });
});
