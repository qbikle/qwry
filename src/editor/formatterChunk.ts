// The lazy formatter chunk's whole surface: sql-formatter's dialect-explicit
// door and the ONE dialect this client speaks. Naming the two bindings is what
// keeps the other 23 out of the chunk. The package's string door, `format()`,
// picks its dialect off a namespace with a computed key
// (`allDialects[cfg.language]`), so anything that can reach `format` pins all
// 24 grammars — and `import("sql-formatter")` reaches it, which is why the
// chunk carried 293.4 kB for a Postgres-only client. Every dynamic import of
// the formatter goes through here (sqlDialect.ts, format.ts), so there is one
// chunk and not two.

export { formatDialect, postgresql } from "sql-formatter";
