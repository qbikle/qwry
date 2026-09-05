// Captured provider output, used as test fixtures. Everything here was recorded
// in W0 against a real server and slimmed to the fields the adapters read; the
// values are otherwise verbatim, so a shape change in a provider shows up as a
// failing test rather than as a silent behaviour change in the app.
//
// Raw captures:
//   qwry-agent-lab/docs/research/w0-provider-presets.md section 0
//   qwry-agent-lab/docs/research/w0-claude-p-transport.md sections 3, 7, 8

/** llama-server 0.2.0 running LFM2.5-2.6B: one forced `describe_tables`
 * call. Note the reasoning_content deltas before the call, the tool-call id
 * that is neither a uuid nor `call_...`, and the arguments arriving as eight
 * fragments that only parse once concatenated. */
export const LLAMA_TOOLCALL_CHUNKS: readonly string[] = [
  "{\"choices\":[{\"finish_reason\":null,\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":null}}]}",
  "{\"choices\":[{\"finish_reason\":null,\"index\":0,\"delta\":{\"reasoning_content\":\"The\"}}]}",
  "{\"choices\":[{\"finish_reason\":null,\"index\":0,\"delta\":{\"reasoning_content\":\" user\"}}]}",
  "{\"choices\":[{\"finish_reason\":null,\"index\":0,\"delta\":{\"reasoning_content\":\" wants\"}}]}",
  "{\"choices\":[{\"finish_reason\":null,\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"pg65tsgq9aOPnNSqFvFQmr5iSQVQqeyj\",\"type\":\"function\",\"function\":{\"name\":\"describe_tables\",\"arguments\":\"{\"}}]}}]}",
  "{\"choices\":[{\"finish_reason\":null,\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"names\\\":[\\\"\"}}]}}]}",
  "{\"choices\":[{\"finish_reason\":null,\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"users\"}}]}}]}",
  "{\"choices\":[{\"finish_reason\":null,\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\",\"}}]}}]}",
  "{\"choices\":[{\"finish_reason\":null,\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\" \\\"\"}}]}}]}",
  "{\"choices\":[{\"finish_reason\":null,\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"orders\"}}]}}]}",
  "{\"choices\":[{\"finish_reason\":null,\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"]\"}}]}}]}",
  "{\"choices\":[{\"finish_reason\":null,\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"}\"}}]}}]}",
  "{\"choices\":[{\"finish_reason\":\"tool_calls\",\"index\":0,\"delta\":{}}]}",
];

/** `claude -p --output-format stream-json --verbose --include-partial-messages`
 * driving two MCP tool calls to an answer. The capture's server was named
 * `qwrylab`; the name and the tool prefix are rewritten to `qwry` here, which
 * is what the adapter's config and allowlist use. */
export const CLAUDE_STREAM_JSON: readonly string[] = [
  "{\"type\":\"system\",\"subtype\":\"init\",\"tools\":[\"mcp__qwry__describe_table\",\"mcp__qwry__describe_tables\",\"mcp__qwry__list_tables\",\"mcp__qwry__peek_values\",\"mcp__qwry__run_sql\"],\"mcp_servers\":[{\"name\":\"qwry\",\"status\":\"connected\"}],\"model\":\"claude-haiku-4-5\",\"session_id\":\"a0ad2909-06b1-44e7-b450-1053561d74dc\"}",
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"msg_011CeiugL1CbdgKKgvjjumLq\"}}}",
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"\",\"estimated_tokens\":50}}}",
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"\",\"estimated_tokens\":null}}}",
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_011CeiugL1CbdgKKgvjjumLq\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"\"}]}}",
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_011CeiugL1CbdgKKgvjjumLq\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01V1kFzHzzM2QucDPmktQ7yz\",\"name\":\"mcp__qwry__describe_tables\",\"input\":{\"names\":[\"film\"]}}]}}",
  "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_01V1kFzHzzM2QucDPmktQ7yz\",\"content\":\"{\\\"result\\\":\\\"CREATE TABLE film (  -- ~1000 rows\\\\n  film_id integer PRIMARY KEY,\\\\n  title text,\\\\n  description text,\\\\n  release_year integer,\\\\n  language_id integer REFERENCES language(language_id),\\\\n  original_language_id integer REFERENCES language(language_id),\\\\n  rental_duration smallint,\\\\n  rental_rate numeric,\\\\n  length smallint,\\\\n  replacement_cost numeric,\\\\n  rating mpaa_rating,  -- values: 'G', 'NC-17', 'PG', 'PG-13', 'R'\\\\n  last_update timestamp with time zone,\\\\n  special_features ARRAY,\\\\n  fulltext tsvector,\\\\n  length_hours numeric\\\\n);\\\"}\"}]}}",
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"msg_011CeiugUYu3carqhcfNpDqP\"}}}",
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"\",\"estimated_tokens\":null}}}",
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_011CeiugUYu3carqhcfNpDqP\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"\"}]}}",
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_011CeiugUYu3carqhcfNpDqP\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01Hw7QxbTPJjfHTehXWkZWoJ\",\"name\":\"mcp__qwry__run_sql\",\"input\":{\"sql\":\"SELECT COUNT(*) as film_count FROM film;\"}}]}}",
  "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_01Hw7QxbTPJjfHTehXWkZWoJ\",\"content\":\"{\\\"result\\\":\\\"film_count\\\\n1000\\\\n(1 rows)\\\"}\"}]}}",
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"msg_011Ceiugc7ZzySbftmPEVzUy\"}}}",
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"\",\"estimated_tokens\":50}}}",
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"\",\"estimated_tokens\":null}}}",
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_011Ceiugc7ZzySbftmPEVzUy\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"\"}]}}",
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"**1000 films** in Pagila database.\\n\\nFilm table:\"}}}",
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\" ~1000 rows, schema includes title, release_year, rating, length, rental details, language refs\"}}}",
  "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\".\"}}}",
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_011Ceiugc7ZzySbftmPEVzUy\",\"content\":[{\"type\":\"text\",\"text\":\"**1000 films** in Pagila database.\\n\\nFilm table: ~1000 rows, schema includes title, release_year, rating, length, rental details, language refs.\"}]}}",
  "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"num_turns\":3,\"usage\":{\"input_tokens\":4039,\"output_tokens\":324,\"cache_read_input_tokens\":4372,\"cache_creation_input_tokens\":4549},\"total_cost_usd\":0.0151942,\"result\":\"**1000 films** in Pagila database.\\n\\nFilm table: ~1000 rows, schema includes title, release_year, rating, length, rental details, language refs.\"}",
];

/** The dead-MCP-server run: exit 0, no error event, an empty tool list, and a
 * model that answers from nothing. The status field is the only warning. */
export const CLAUDE_DEAD_MCP: readonly string[] = [
  "{\"type\":\"system\",\"subtype\":\"init\",\"tools\":[],\"mcp_servers\":[{\"name\":\"qwry\",\"status\":\"failed\"}],\"model\":\"claude-haiku-4-5\",\"session_id\":\"c44536e4-b963-4087-a51f-c5a7d5099ebf\"}",
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_dead\",\"content\":[{\"type\":\"text\",\"text\":\"I cannot reach the database. Try psql -h localhost\"}]}}",
  "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"num_turns\":1,\"usage\":{\"input_tokens\":10,\"output_tokens\":20,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0},\"total_cost_usd\":0.0,\"result\":\"I cannot reach the database.\"}",
];

/** An Anthropic message stream with TWO tool_use blocks in one turn, assembled
 * from the event sequence and delta types the W0 report pinned (section 3):
 * message_start, content_block_start/delta/stop per index, message_delta with
 * the stop reason and output tokens, message_stop, with a ping interleaved.
 * The tool input arrives as partial JSON STRINGS, which is the whole reason
 * this fixture exists. */
export const ANTHROPIC_PARALLEL_TOOL_USE = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_01\",\"model\":\"claude-sonnet-5\",\"usage\":{\"input_tokens\":118,\"cache_creation_input_tokens\":4539,\"cache_read_input_tokens\":4381,\"output_tokens\":1}}}\n\nevent: ping\ndata: {\"type\":\"ping\"}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"The film table first.\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"Eu8DCrIBCBEYAipA\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_01A09q90qw90lq917835lq9\",\"name\":\"describe_tables\",\"input\":{}}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"names\\\": [\\\"film\\\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\", \\\"actor\\\"]}\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_01B22q90qw90lq917835lq9\",\"name\":\"peek_values\",\"input\":{}}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"table\\\": \\\"film\\\", \\\"column\\\": \\\"rating\\\"}\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":2}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":137}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

/** The same stream shape for a plain answer turn: text_delta only, end_turn. */
export const ANTHROPIC_TEXT_TURN = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_02\",\"usage\":{\"input_tokens\":8,\"cache_read_input_tokens\":8920,\"output_tokens\":1}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"1000 films\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" in total.\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":42}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
