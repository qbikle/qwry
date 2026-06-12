//! Splits a SQL string into statements on top-level `;`, respecting single/double
//! quotes, dollar-quoting ($$ / $tag$), line comments and nested block comments.
//! Mirrors PG simple-protocol behavior: chunks with no real tokens (empty /
//! comment-only) are dropped, so indexes align with CommandComplete sequence.

pub fn split_statements(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    let mut has_token = false;

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
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\'' {
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
                    out.push(sql[start..i].trim().to_string());
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
        let tail = sql[start..].trim();
        if !tail.is_empty() {
            out.push(tail.to_string());
        }
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
}
