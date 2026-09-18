// Shared seed fixtures for the store tests (mirrors the pattern in
// src/agent/providers/__tests__/fixtures.ts): the agent settings baseline and
// the well-formed-but-empty SchemaSnapshot every seed() starts from, so a
// field added to either shape needs one edit instead of one per test file.

import type { SchemaSnapshot, TableInfo } from "../schema";

/** The provider/model every store test seeds before touching the agent
 * store, with no per-connection overrides. */
export function baseAgentSettings() {
  return {
    agentProvider: "claude-code",
    agentModel: "claude-sonnet-5",
    agentByConn: {},
    agentBaseUrls: {},
  };
}

/** A well-formed SchemaSnapshot the tools factory and mention resolver can
 * index without special-casing, defaulting to no tables. */
export function minimalSnapshot(tables: TableInfo[] = []): SchemaSnapshot {
  return {
    tables,
    foreign_keys: [],
    functions: [],
    schemas: ["public"],
    indexes: [],
    enums: [],
    sequences: [],
    extensions: [],
    server_version_num: 160004,
  };
}
