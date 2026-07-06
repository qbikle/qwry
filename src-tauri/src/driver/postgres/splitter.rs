//! Splits a SQL string into statements on top-level `;`, respecting single/double
//! quotes, dollar-quoting ($$ / $tag$), line comments and nested block comments.
//! Mirrors PG simple-protocol behavior: chunks with no real tokens (empty /
//! comment-only) are dropped, so indexes align with CommandComplete sequence.

/// One split statement plus where it begins in the original buffer, so a PG
/// error position (1-based chars into the statement) can be rebased onto the
/// whole executed text for the editor squiggle.
pub struct StmtSpan {
    pub sql: String,
    /// chars (not bytes) before the statement's first non-whitespace char
    pub char_offset: usize,
}

pub fn split_statements(sql: &str) -> Vec<String> {
    split_statement_spans(sql).into_iter().map(|s| s.sql).collect()
}

pub fn split_statement_spans(sql: &str) -> Vec<StmtSpan> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    let mut has_token = false;

    let push = |out: &mut Vec<StmtSpan>, start: usize, end: usize| {
        let raw = &sql[start..end];
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return;
        }
        let byte_start = start + (raw.len() - raw.trim_start().len());
        out.push(StmtSpan {
            sql: trimmed.to_string(),
            char_offset: sql[..byte_start].chars().count(),
        });
    };

    while i < bytes.len() {
        match bytes[i] {
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                i += 2;
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                let mut depth = 1;
                while i < bytes.len() && depth > 0 {
                    if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                        depth += 1;
                        i += 2;
                    } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
            b'\'' => {
                has_token = true;
                // E'…' escape strings honor backslash escapes — treating \' as
                // a terminator would split at an interior ';' and desync
                // statement indexes (editability would target the wrong SQL)
                let escape_string = i > 0
                    && (bytes[i - 1] == b'E' || bytes[i - 1] == b'e')
                    && (i < 2 || !(bytes[i - 2].is_ascii_alphanumeric() || bytes[i - 2] == b'_'));
                i += 1;
                while i < bytes.len() {
                    if escape_string && bytes[i] == b'\\' {
                        i += 2; // backslash escape consumes the next char
                    } else if bytes[i] == b'\'' {
                        if bytes.get(i + 1) == Some(&b'\'') {
                            i += 2; // escaped ''
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            b'"' => {
                has_token = true;
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'"' {
                        if bytes.get(i + 1) == Some(&b'"') {
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            b'$' => {
                // possible dollar-quote opener: $tag$ where tag is [A-Za-z0-9_]*
                let tag_start = i + 1;
                let mut j = tag_start;
                while j < bytes.len()
                    && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_')
                {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b'$' {
                    has_token = true;
                    let tag = &bytes[i..=j]; // "$tag$"
                    i = j + 1;
                    // scan for closing tag
                    while i < bytes.len() {
                        if bytes[i] == b'$' && bytes[i..].starts_with(tag) {
                            i += tag.len();
                            break;
                        }
                        i += 1;
                    }
                } else {
                    has_token = true; // bare $ (e.g. positional param)
                    i += 1;
                }
            }
            b';' => {
                if has_token {
                    push(&mut out, start, i);
                }
                has_token = false;
                i += 1;
                start = i;
            }
            c => {
                if !c.is_ascii_whitespace() {
                    has_token = true;
                }
                i += 1;
            }
        }
    }
    if has_token {
        push(&mut out, start, sql.len());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::split_statements;

    #[test]
    fn basic_split() {
        assert_eq!(
            split_statements("SELECT 1; SELECT 2"),
            vec!["SELECT 1", "SELECT 2"]
        );
    }

    #[test]
    fn semicolon_in_string() {
        assert_eq!(
            split_statements("SELECT 'a;b'; SELECT 2"),
            vec!["SELECT 'a;b'", "SELECT 2"]
        );
    }

    #[test]
    fn escaped_quote() {
        assert_eq!(
            split_statements("SELECT 'it''s; fine'"),
            vec!["SELECT 'it''s; fine'"]
        );
    }

    #[test]
    fn quoted_identifier() {
        assert_eq!(
            split_statements(r#"SELECT "a;b" FROM t; SELECT 1"#),
            vec![r#"SELECT "a;b" FROM t"#, "SELECT 1"]
        );
    }

    #[test]
    fn dollar_quoting() {
        let sql = "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql; SELECT 2";
        assert_eq!(split_statements(sql).len(), 2);
        let sql = "DO $body$ BEGIN; END; $body$; SELECT 3";
        assert_eq!(
            split_statements(sql),
            vec!["DO $body$ BEGIN; END; $body$", "SELECT 3"]
        );
    }

    #[test]
    fn comments() {
        assert_eq!(
            split_statements("-- c1; not a split\nSELECT 1; /* x; y */ SELECT 2"),
            vec!["-- c1; not a split\nSELECT 1", "/* x; y */ SELECT 2"]
        );
        // nested block comment
        assert_eq!(
            split_statements("/* a /* b; */ c; */ SELECT 1"),
            vec!["/* a /* b; */ c; */ SELECT 1"]
        );
    }

    #[test]
    fn drops_empty_chunks() {
        assert_eq!(split_statements(";;  ; SELECT 1; -- only comment\n;"), vec!["SELECT 1"]);
        assert!(split_statements("  \n ").is_empty());
        assert!(split_statements("/* just a comment */").is_empty());
    }

    #[test]
    fn trailing_statement_no_semicolon() {
        assert_eq!(split_statements("SELECT 1;\nSELECT 2"), vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn escape_strings() {
        // \' inside E'…' is an escaped quote, not a terminator
        assert_eq!(
            split_statements(r"SELECT E'a\'; not a split'; SELECT 2"),
            vec![r"SELECT E'a\'; not a split'", "SELECT 2"]
        );
        // a plain identifier ending in e does NOT start an escape string
        assert_eq!(
            split_statements(r"SELECT case_e'\'; SELECT 2"),
            // '\' is a normal string containing one backslash → ; splits
            vec![r"SELECT case_e'\'", "SELECT 2"]
        );
    }

    #[test]
    fn span_offsets_are_chars_to_trimmed_start() {
        let spans = super::split_statement_spans("SELECT 1;\n  SELECT 2");
        assert_eq!(spans[0].char_offset, 0);
        assert_eq!(spans[1].sql, "SELECT 2");
        assert_eq!(spans[1].char_offset, 12); // "SELECT 1;\n  " = 12 chars

        // multibyte before the second statement: offset counts CHARS not bytes
        let spans = super::split_statement_spans("SELECT 'é😀'; SELECT 2");
        assert_eq!(spans[1].sql, "SELECT 2");
        assert_eq!(spans[1].char_offset, "SELECT 'é😀'; ".chars().count());
    }
}
