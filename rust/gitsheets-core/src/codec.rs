//! Content-typed record codec — the on-disk byte format dispatch.
//!
//! A sheet's `[gitsheet.format]` selects how a record is encoded on disk:
//! `toml` (the default — a canonical TOML blob, the bytes-authority's job) or
//! `markdown`/`mdx` (TOML **frontmatter** delimited by `+++`, then a designated
//! body field, stored as `.md`/`.mdx`). This module is the behavior-preserving
//! Rust port of `packages/gitsheets/src/format/{index,markdown}.ts`, per
//! [`specs/behaviors/content-types.md`](../../../specs/behaviors/content-types.md).
//!
//! ## One bytes-authority
//!
//! The frontmatter is serialized through the **same** canonical TOML path as a
//! TOML record ([`canonical::serialize`] — deep key sort, `@iarna`-equivalent
//! form). There is no second TOML serializer: a markdown record's frontmatter
//! and a TOML record with the same fields produce identical bytes.
//!
//! ## markdownlint normalization is NOT done here — and that is deliberate
//!
//! The JS oracle normalizes the body with the `markdownlint` npm package
//! (`lint` + `applyFixes`) on write. **That pass is intentionally not
//! reimplemented in the core.** `markdownlint` is ~40 rules with bespoke,
//! interdependent fix logic; no Rust port is byte-identical to it, so a partial
//! reimplementation would *silently* emit different body bytes for any body that
//! triggers a rule the port handled differently or not at all — exactly the
//! failure mode the plan forbids. Instead:
//!
//! - The core codec frames the body **verbatim** (byte-deterministic,
//!   language-agnostic: delimiters, frontmatter, trailing-newline, title-from-H1).
//! - The markdownlint *configuration* is fully parsed and the effective ruleset
//!   computed by the core ([`crate::config::Markdownlint::resolve`]) so nothing
//!   is dropped.
//! - The *application* of markdownlint to the body is a **host-side pre-pass**
//!   (the binding runs the `markdownlint` package — which already lives in the
//!   Node ecosystem — before handing the record to the codec), the same way the
//!   consumer Standard-Schema validator runs host-side. The core never calls
//!   back into the host (re-entrancy hazard).
//!
//! Net: the codec is byte-identical to `markdown.ts` **with `markdownlint =
//! false`**; with linting on, the binding's pre-pass supplies the normalized
//! body and the framing still matches byte-for-byte. See
//! `plans/markdown-codec-core.md` for the full parity write-up.

use indexmap::IndexMap;
use regex::Regex;
use std::sync::LazyLock;

use crate::canonical;
use crate::config::{FormatConfig, FormatKind};
use crate::error::{Error, IssueSource, Result, ValidationIssue};
use crate::value::Value;

const DELIMITER: &str = "+++";

/// A frontmatter delimiter line: `+++` followed only by whitespace to the line
/// end. Mirrors the JS `/^\+\+\+\s*$/m`.
static DELIMITER_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\+\+\+\s*$").expect("static delimiter regex"));

/// The first ATX-style H1 line (`# Title text`), capturing the title with
/// trailing whitespace trimmed. Mirrors the JS `/^# (.+?)[ \t]*$/m`; the capture
/// is `[^\r\n]+?` (not `.`) so it excludes `\r`, matching JS's `.` exactly
/// (JS `.` excludes both `\n` and `\r`).
static H1_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^# ([^\r\n]+?)[ \t]*$").expect("static H1 regex"));

// ── format dispatch ──────────────────────────────────────────────────────────

/// Serialize a record to its on-disk text for the sheet's format.
///
/// - `toml` → canonical TOML bytes ([`canonical::serialize`]).
/// - `markdown`/`mdx` → `+++\n<frontmatter>+++\n\n<body>\n` (see
///   [`serialize_markdown`]). The body is **not** markdownlint-normalized here
///   (see the module docs); callers that want normalization apply it before
///   calling.
pub fn serialize(record: &Value, format: &FormatConfig) -> Result<String> {
    match format.kind {
        FormatKind::Toml => canonical::serialize(record),
        FormatKind::Markdown | FormatKind::Mdx => serialize_markdown(record, format),
    }
}

/// Parse on-disk text into a full record (markdown: frontmatter + body field).
pub fn parse(text: &str, format: &FormatConfig) -> Result<Value> {
    match format.kind {
        FormatKind::Toml => canonical::parse(text),
        FormatKind::Markdown | FormatKind::Mdx => parse_markdown(text, format, true),
    }
}

/// Parse only the header (frontmatter) — the lazy-body path. For `toml` this is
/// identical to [`parse`]; for markdown the body bytes are never injected into
/// the record (the body field is left absent). Mirrors `Format.parseHeaderOnly`.
pub fn parse_header_only(text: &str, format: &FormatConfig) -> Result<Value> {
    match format.kind {
        FormatKind::Toml => canonical::parse(text),
        FormatKind::Markdown | FormatKind::Mdx => parse_markdown(text, format, false),
    }
}

// ── markdown serialize ───────────────────────────────────────────────────────

fn body_field_name(format: &FormatConfig) -> Result<&str> {
    format.body.as_deref().ok_or_else(|| Error::ConfigInvalid {
        message: "markdown format requires [gitsheet.format].body to be set to the field name holding the body text".to_string(),
    })
}

fn serialize_markdown(record: &Value, format: &FormatConfig) -> Result<String> {
    let body_field = body_field_name(format)?;

    let Value::Table(table) = record else {
        return Err(Error::ValidationFailed {
            message: "markdown format: record must be a table".to_string(),
            issues: Vec::new(),
        });
    };

    // The body field → body text. An absent body is the empty string (matches
    // the JS `?? ''`); a present non-string body is a type error.
    let body = match table.get(body_field) {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => {
            return Err(Error::ValidationFailed {
                message: format!(
                    "markdown format: record.{body_field} must be a string, got {}",
                    other.type_name()
                ),
                issues: Vec::new(),
            })
        }
    };

    // Frontmatter = every field except the body field.
    let mut frontmatter: IndexMap<String, Value> = IndexMap::new();
    for (k, v) in table {
        if k == body_field {
            continue;
        }
        frontmatter.insert(k.clone(), v.clone());
    }

    // Title-from-H1: enforce `record[title] === <body's first H1, or absent>`.
    if let Some(title_field) = &format.title {
        let extracted = extract_first_h1(&body);
        let supplied = frontmatter.get(title_field);
        if let Some(supplied_val) = supplied {
            let agrees = match (&extracted, supplied_val) {
                (Some(e), Value::String(s)) => e == s,
                _ => false,
            };
            if !agrees {
                let supplied_repr = match supplied_val {
                    Value::String(s) => format!("{s:?}"),
                    other => other.type_name().to_string(),
                };
                let extracted_repr = match &extracted {
                    Some(e) => format!("{e:?}"),
                    None => "undefined".to_string(),
                };
                return Err(Error::ValidationFailed {
                    message: format!(
                        "record.{title_field} ({supplied_repr}) disagrees with body's first H1 ({extracted_repr}). Use `Sheet.patch` if you want to rename via either field — `upsert` requires self-consistent input."
                    ),
                    issues: vec![ValidationIssue {
                        path: vec![title_field.clone()],
                        message: format!(
                            "disagrees with body's first H1 ({extracted_repr})"
                        ),
                        source: IssueSource::JsonSchema,
                        schema_path: None,
                        code: None,
                    }],
                });
            }
        }
        match &extracted {
            Some(e) => {
                frontmatter.insert(title_field.clone(), Value::String(e.clone()));
            }
            // No H1 in body → ensure no stale title leaks into frontmatter.
            None => {
                frontmatter.shift_remove(title_field);
            }
        }
    }

    let fm_text = canonical::serialize(&Value::Table(frontmatter))?;

    // Layout: `+++\n<frontmatter>+++\n\n<body>\n`. canonical::serialize already
    // ends with a newline, so the frontmatter slots cleanly between delimiters.
    // The on-disk file ends with exactly one `\n` — a body that does not already
    // end with one gets it appended (so a body value of `'hi\n'` is idempotent).
    let trailing = if body.ends_with('\n') { "" } else { "\n" };
    Ok(format!("{DELIMITER}\n{fm_text}{DELIMITER}\n\n{body}{trailing}"))
}

// ── markdown parse ───────────────────────────────────────────────────────────

fn parse_markdown(text: &str, format: &FormatConfig, with_body: bool) -> Result<Value> {
    let body_field = body_field_name(format)?;
    let (frontmatter, body) = split_on_delimiters(text);
    let mut record = canonical::parse(&frontmatter)?;
    if with_body {
        match &mut record {
            Value::Table(t) => {
                t.insert(body_field.to_string(), Value::String(body));
            }
            // canonical::parse of a TOML document is always a table; this arm is
            // unreachable in practice but keeps the match total.
            _ => {
                let mut t = IndexMap::new();
                t.insert(body_field.to_string(), Value::String(body));
                record = Value::Table(t);
            }
        }
    }
    Ok(record)
}

/// Split a markdown record's text into frontmatter TOML + body, mirroring the JS
/// `splitOnDelimiters`. The first `+++` line is the opener, the next is the
/// closer; a UTF-8 BOM before the opener is stripped; any later `+++` line in
/// the body is preserved. Input with no delimiters is body-only.
fn split_on_delimiters(text: &str) -> (String, String) {
    // Strip a leading UTF-8 BOM if present.
    let stripped = text.strip_prefix('\u{feff}').unwrap_or(text);

    let opener = match DELIMITER_LINE_RE.find(stripped) {
        Some(m) => m,
        None => return (String::new(), stripped.to_string()),
    };

    let after_opener = &stripped[opener.end()..];
    // Drop the newline directly after the opener delimiter.
    let after_opener = after_opener.strip_prefix('\n').unwrap_or(after_opener);

    let closer = match DELIMITER_LINE_RE.find(after_opener) {
        Some(m) => m,
        // Opener but no closer — treat everything after the opener as body.
        None => return (String::new(), after_opener.to_string()),
    };

    let frontmatter = after_opener[..closer.start()].to_string();
    // Drop the newline after the closer, a leading blank line before the body,
    // and a single trailing newline (it belongs to the file, not the body).
    let mut body = &after_opener[closer.end()..];
    body = body.strip_prefix('\n').unwrap_or(body);
    body = body.strip_prefix('\n').unwrap_or(body);
    body = body.strip_suffix('\n').unwrap_or(body);
    (frontmatter, body.to_string())
}

// ── title-from-H1 helpers ────────────────────────────────────────────────────

/// Extract the first ATX-style H1 from a markdown body, or `None` if absent.
/// The title is returned with surrounding whitespace trimmed. Mirrors the JS
/// `extractFirstH1`.
pub fn extract_first_h1(body: &str) -> Option<String> {
    H1_LINE_RE
        .captures(body)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

/// Rewrite (or prepend) the first ATX H1 of a markdown body to `new_title`.
/// Used by `Sheet.patch` to reconcile a title-only delta into the body. If the
/// body has no H1, prepends `# new_title\n\n`. Mirrors the JS `rewriteLeadingH1`.
pub fn rewrite_leading_h1(body: &str, new_title: &str) -> String {
    if let Some(m) = H1_LINE_RE.find(body) {
        let before = &body[..m.start()];
        let after = &body[m.end()..];
        return format!("{before}# {new_title}{after}");
    }
    if body.is_empty() {
        return format!("# {new_title}\n");
    }
    format!("# {new_title}\n\n{body}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Markdownlint;

    fn md(body_field: &str, title: Option<&str>) -> FormatConfig {
        FormatConfig {
            kind: FormatKind::Markdown,
            body: Some(body_field.to_string()),
            title: title.map(|s| s.to_string()),
            markdownlint: Markdownlint::Default,
        }
    }

    fn rec(pairs: &[(&str, Value)]) -> Value {
        let mut m = IndexMap::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        Value::Table(m)
    }
    fn s(v: &str) -> Value {
        Value::String(v.to_string())
    }

    fn field<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
        match v {
            Value::Table(t) => t.get(k),
            _ => None,
        }
    }

    // ── serialize ────────────────────────────────────────────────────────────

    #[test]
    fn writes_frontmatter_then_body() {
        let text = serialize(
            &rec(&[
                ("slug", s("hello")),
                ("title", s("Hello, world")),
                ("body", s("# Hello\n\nBody text\n")),
            ]),
            &md("body", None),
        )
        .unwrap();
        assert!(text.starts_with("+++\n"));
        assert!(text.contains("slug = \"hello\""));
        assert!(text.contains("title = \"Hello, world\""));
        assert!(text.contains("+++\n\n# Hello\n\nBody text\n"));
    }

    #[test]
    fn empty_body_is_delimiters_plus_one_trailing_newline() {
        let text = serialize(&rec(&[("slug", s("empty")), ("body", s(""))]), &md("body", None)).unwrap();
        assert_eq!(text, "+++\nslug = \"empty\"\n+++\n\n\n");
    }

    #[test]
    fn missing_body_is_treated_as_empty() {
        let text = serialize(&rec(&[("slug", s("no-body"))]), &md("body", None)).unwrap();
        assert!(text.contains("slug = \"no-body\""));
        assert!(text.ends_with("+++\n\n\n"));
    }

    #[test]
    fn body_not_a_string_is_validation_error() {
        let err = serialize(&rec(&[("slug", s("bad")), ("body", Value::Integer(42))]), &md("body", None))
            .unwrap_err();
        assert_eq!(err.code(), "validation_failed");
        assert!(err.message().contains("must be a string"));
    }

    #[test]
    fn frontmatter_keys_are_deep_sorted() {
        let text = serialize(
            &rec(&[("zeta", Value::Integer(1)), ("alpha", Value::Integer(2)), ("slug", s("sorted")), ("body", s(""))]),
            &md("body", None),
        )
        .unwrap();
        let alpha = text.find("alpha").unwrap();
        let slug = text.find("slug").unwrap();
        let zeta = text.find("zeta").unwrap();
        assert!(alpha < slug && slug < zeta);
    }

    #[test]
    fn body_ending_in_newline_does_not_double_up() {
        // A body that already ends with `\n` round-trips without a trailing
        // newline (the file's `\n` is the file's, not the body's).
        let text = serialize(&rec(&[("slug", s("x")), ("body", s("hi\n"))]), &md("body", None)).unwrap();
        assert!(text.ends_with("\n\nhi\n"));
        let parsed = parse(&text, &md("body", None)).unwrap();
        assert_eq!(field(&parsed, "body"), Some(&s("hi")));
    }

    // ── parse ────────────────────────────────────────────────────────────────

    #[test]
    fn round_trips_through_serialize_then_parse() {
        let original = rec(&[
            ("slug", s("roundtrip")),
            ("title", s("Round-trip")),
            ("tags", Value::Array(vec![s("a"), s("b")])),
            ("body", s("# Heading\n\nSome content.")),
        ]);
        let text = serialize(&original, &md("body", None)).unwrap();
        let parsed = parse(&text, &md("body", None)).unwrap();
        assert_eq!(field(&parsed, "slug"), Some(&s("roundtrip")));
        assert_eq!(field(&parsed, "title"), Some(&s("Round-trip")));
        assert_eq!(field(&parsed, "tags"), Some(&Value::Array(vec![s("a"), s("b")])));
        assert_eq!(field(&parsed, "body"), Some(&s("# Heading\n\nSome content.")));
    }

    #[test]
    fn preserves_a_plus_plus_plus_line_in_the_body() {
        let body = "before\n\n+++\n\nafter";
        let text = serialize(&rec(&[("slug", s("plus")), ("body", s(body))]), &md("body", None)).unwrap();
        let parsed = parse(&text, &md("body", None)).unwrap();
        assert_eq!(field(&parsed, "body"), Some(&s(body)));
    }

    #[test]
    fn empty_body_reads_back_as_empty_string() {
        let text = serialize(&rec(&[("slug", s("empty")), ("body", s(""))]), &md("body", None)).unwrap();
        let parsed = parse(&text, &md("body", None)).unwrap();
        assert_eq!(field(&parsed, "body"), Some(&s("")));
    }

    #[test]
    fn preserves_toml_datetime_in_frontmatter() {
        let dt: Value = Value::Datetime("2024-05-16T10:00:00Z".parse().unwrap());
        let text = serialize(&rec(&[("slug", s("dated")), ("publishedAt", dt.clone()), ("body", s("hi"))]), &md("body", None)).unwrap();
        let parsed = parse(&text, &md("body", None)).unwrap();
        assert_eq!(field(&parsed, "publishedAt"), Some(&dt));
    }

    #[test]
    fn strips_a_utf8_bom() {
        let text = "\u{feff}+++\nslug = \"bom\"\n+++\n\nhello\n";
        let parsed = parse(text, &md("body", None)).unwrap();
        assert_eq!(field(&parsed, "slug"), Some(&s("bom")));
        assert_eq!(field(&parsed, "body"), Some(&s("hello")));
    }

    #[test]
    fn body_only_file_has_just_the_body_field() {
        let parsed = parse("just some body text", &md("body", None)).unwrap();
        assert_eq!(field(&parsed, "body"), Some(&s("just some body text")));
        let Value::Table(t) = parsed else { panic!() };
        let others: Vec<&String> = t.keys().filter(|k| *k != "body").collect();
        assert!(others.is_empty());
    }

    #[test]
    fn parse_header_only_skips_the_body() {
        let big = "this body is big\n".repeat(1000);
        let text = serialize(&rec(&[("slug", s("header")), ("title", s("Header only")), ("body", s(&big))]), &md("body", None)).unwrap();
        let header = parse_header_only(&text, &md("body", None)).unwrap();
        assert_eq!(field(&header, "slug"), Some(&s("header")));
        assert_eq!(field(&header, "title"), Some(&s("Header only")));
        assert_eq!(field(&header, "body"), None);
    }

    // ── title-from-H1 ────────────────────────────────────────────────────────

    #[test]
    fn extract_first_h1_cases() {
        assert_eq!(extract_first_h1("# Hello, world\n\nBody").as_deref(), Some("Hello, world"));
        assert_eq!(extract_first_h1("Body without a heading"), None);
        assert_eq!(extract_first_h1("## Subheading\n\nBody"), None);
        assert_eq!(extract_first_h1(""), None);
        assert_eq!(extract_first_h1("#NoSpace"), None);
        assert_eq!(extract_first_h1("Some prose first.\n\n# Title\n\nMore.").as_deref(), Some("Title"));
        assert_eq!(extract_first_h1("# Hello   ").as_deref(), Some("Hello"));
    }

    #[test]
    fn rewrite_leading_h1_cases() {
        assert_eq!(rewrite_leading_h1("# Old\n\nBody", "New"), "# New\n\nBody");
        assert_eq!(rewrite_leading_h1("# First\n\n# Second", "X"), "# X\n\n# Second");
        assert_eq!(rewrite_leading_h1("Just prose, no heading.", "X"), "# X\n\nJust prose, no heading.");
        assert_eq!(rewrite_leading_h1("", "X"), "# X\n");
    }

    #[test]
    fn serialize_extracts_title_from_body_h1() {
        let text = serialize(&rec(&[("slug", s("hello")), ("body", s("# Hello, world\n\nA short post."))]), &md("body", Some("title"))).unwrap();
        assert!(text.contains("title = \"Hello, world\""));
        assert!(text.contains("slug = \"hello\""));
    }

    #[test]
    fn serialize_passes_through_agreeing_title() {
        let text = serialize(
            &rec(&[("slug", s("hello")), ("title", s("Hello, world")), ("body", s("# Hello, world\n\nA short post."))]),
            &md("body", Some("title")),
        )
        .unwrap();
        assert!(text.contains("title = \"Hello, world\""));
    }

    #[test]
    fn serialize_throws_on_disagreeing_title() {
        let err = serialize(&rec(&[("slug", s("hello")), ("title", s("X")), ("body", s("# Y\n\nbody"))]), &md("body", Some("title"))).unwrap_err();
        assert_eq!(err.code(), "validation_failed");
        assert_eq!(err.issues().len(), 1);
    }

    #[test]
    fn serialize_throws_when_title_supplied_but_no_h1() {
        let err = serialize(&rec(&[("slug", s("hello")), ("title", s("Stale")), ("body", s("No H1 here."))]), &md("body", Some("title"))).unwrap_err();
        assert_eq!(err.code(), "validation_failed");
    }

    #[test]
    fn serialize_omits_title_when_no_h1_and_none_supplied() {
        let text = serialize(&rec(&[("slug", s("hello")), ("body", s("No H1 here."))]), &md("body", Some("title"))).unwrap();
        assert!(!text.contains("title ="));
    }

    #[test]
    fn title_round_trips() {
        let text = serialize(&rec(&[("slug", s("hello")), ("body", s("# Hello, world\n\nA short post."))]), &md("body", Some("title"))).unwrap();
        let parsed = parse(&text, &md("body", Some("title"))).unwrap();
        assert_eq!(field(&parsed, "title"), Some(&s("Hello, world")));
        assert_eq!(field(&parsed, "body"), Some(&s("# Hello, world\n\nA short post.")));
    }

    // ── toml passthrough ─────────────────────────────────────────────────────

    #[test]
    fn toml_format_is_canonical_passthrough() {
        let fmt = FormatConfig {
            kind: FormatKind::Toml,
            body: None,
            title: None,
            markdownlint: Markdownlint::Default,
        };
        let r = rec(&[("slug", s("jane")), ("email", s("jane@x.org"))]);
        let text = serialize(&r, &fmt).unwrap();
        assert_eq!(text, "email = \"jane@x.org\"\nslug = \"jane\"\n");
        assert_eq!(parse(&text, &fmt).unwrap(), r);
    }
}
