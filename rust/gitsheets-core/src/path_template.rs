//! Path-template parsing + rendering — record → on-disk path.
//!
//! A behavior-preserving Rust port of the host renderer
//! (`packages/gitsheets/src/path-template/index.ts`), per
//! [`specs/behaviors/path-templates.md`](../../../specs/behaviors/path-templates.md).
//! The template determines where each record's file lives in the data tree, so
//! it is bytes-determining and belongs in the core (every binding must render
//! the same path for the same record).
//!
//! ## What's native vs engine-backed
//!
//! - **Literal** and **field-reference** (`${{ slug }}`) components render
//!   **natively** over the core [`Value`] — the declarative-first common case.
//! - **Date-bucket** components (`${{ publishedAt: YYYY/MM/DD }}`) also render
//!   **natively**, via chrono — never through the engine, so bucket paths are
//!   UTC-deterministic by construction (see the spec's "Date-bucket
//!   references"). One bucket token expands at *parse* time into one component
//!   per format part, so the query walk sees ordinary one-level components.
//! - **Expression** components (`${{ publishedAt.getUTCFullYear() }}`) are the
//!   escape hatch: compiled once into the embedded [`Engine`] and evaluated per
//!   record. This is where partition derivations beyond the closed bucket enum
//!   live, and it is the path-template half of the `node:vm` parity gate.
//!
//! Query-tree traversal/pruning (the *other* job of a parsed template) is a
//! record-engine concern and lands downstream; this module owns parse + render.

use chrono::{Datelike, NaiveDate};

use crate::engine::{Engine, SnippetError, SnippetHandle};
use crate::error::{Error, Result};
use crate::value::{Datetime, Value};

/// One parsed path component (a slash-separated segment), made of one or more
/// parts. A pure field-reference / literal component renders natively; a
/// component containing an expression part consults the engine.
#[derive(Debug)]
struct Component {
    parts: Vec<Part>,
    /// True iff this component is exactly one recursive (`field/**`) field part.
    recursive: bool,
}

#[derive(Debug)]
enum Part {
    Literal(String),
    Field {
        name: String,
        recursive: bool,
    },
    /// One segment of a date-bucket reference (`${{ field: YYYY/MM/DD }}`).
    /// The parser expands a bucket token into one `Bucket` part per format
    /// part, each its own component, so a `YYYY/MM/DD` bucket creates three
    /// real tree levels.
    Bucket {
        /// The referenced field, split on `.` (dotted references read nested
        /// tables).
        field: Vec<String>,
        unit: BucketUnit,
    },
    Expression {
        handle: SnippetHandle,
        /// The raw expression source (inside `${{ … }}`), retained for
        /// [`Template::get_field_names`]'s best-effort identifier scan.
        source: String,
    },
}

/// One path segment's date-bucket unit. `YYYY` in a `YYYY/WW` bucket is the
/// ISO week-based year ([`BucketUnit::IsoWeekYear`]), a *different* value from
/// the calendar year near year boundaries — see the spec's ISO-week rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BucketUnit {
    CalendarYear,
    Month,
    Day,
    IsoWeekYear,
    IsoWeek,
}

/// The closed format enum. Deliberately not a format language: anything
/// outside this set is `ConfigError('config_invalid')` at sheet-open.
const BUCKET_FORMATS: &[(&str, &[BucketUnit])] = &[
    ("YYYY", &[BucketUnit::CalendarYear]),
    ("YYYY/MM", &[BucketUnit::CalendarYear, BucketUnit::Month]),
    (
        "YYYY/MM/DD",
        &[BucketUnit::CalendarYear, BucketUnit::Month, BucketUnit::Day],
    ),
    ("YYYY/WW", &[BucketUnit::IsoWeekYear, BucketUnit::IsoWeek]),
];

/// One component's contribution to a query-tree walk: the value it renders to
/// against the (partial) query — `None` when un-renderable, in which case the
/// walk must expand across all subtrees at that level — plus whether it is the
/// recursive (`field/**`) component. See [`Template::plan_query`].
#[derive(Clone, Debug)]
pub struct QueryComponentPlan {
    pub rendered: Option<String>,
    pub recursive: bool,
}

/// A parsed, compiled path template. Built once per template string (with its
/// expression parts compiled into the shared [`Engine`]); rendered many times.
#[derive(Debug)]
pub struct Template {
    source: String,
    components: Vec<Component>,
}

impl Template {
    /// Parse `source` and compile any expression components into `engine`,
    /// returning a reusable template. Expression compile failures surface as
    /// [`Error::PathRenderFailed`] (matching the host's `compileExpression`,
    /// which raises `path_render_failed` on a bad expression).
    pub fn compile(source: &str, engine: &mut Engine) -> Result<Self> {
        let components = parse_template(source, engine)?;
        Ok(Template {
            source: source.to_string(),
            components,
        })
    }

    /// The original template string.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// Number of slash-separated components.
    pub fn component_count(&self) -> usize {
        self.components.len()
    }

    /// Render the template against a full record into a slash-joined path
    /// (without the trailing file extension — the caller appends `.toml`/`.md`).
    ///
    /// Mirrors the host `Template.render`:
    /// - any component that can't render (a required field/expression is absent
    ///   or yields `null`/`undefined`/non-primitive) → [`Error::PathRenderFailed`]
    ///   naming the component;
    /// - a rendered segment containing a filesystem-illegal character →
    ///   [`Error::PathInvalidChars`].
    pub fn render(&self, record: &Value, engine: &mut Engine) -> Result<String> {
        let mut segments = Vec::with_capacity(self.components.len());
        for (i, component) in self.components.iter().enumerate() {
            let rendered = self.render_component(component, record, engine, true)?;
            let Some(rendered) = rendered else {
                return Err(Error::PathRenderFailed {
                    message: format!(
                        "cannot render component {i} of \"{}\" — a required field or expression returned undefined",
                        self.source
                    ),
                });
            };
            reject_invalid_chars(&rendered, component.recursive, &self.source, i)?;
            segments.push(rendered);
        }
        Ok(segments.join("/"))
    }

    /// Render a single component to `Some(text)` or `None` (un-renderable).
    /// Returns `Err` for a genuine engine failure (a non-reference JS
    /// exception while evaluating an expression) — and, in `strict` mode
    /// (full-record `render`), for a date-bucket field holding a value that
    /// isn't a date (wrong type / unparseable string). In non-strict mode
    /// (query planning) a bad bucket value degrades to un-renderable so the
    /// walk widens instead of erroring — matching how opaque filter values
    /// widen the walk today (spec: "Query traversal semantics").
    fn render_component(
        &self,
        component: &Component,
        record: &Value,
        engine: &mut Engine,
        strict: bool,
    ) -> Result<Option<String>> {
        let mut out = String::new();
        for part in &component.parts {
            let piece = match part {
                Part::Literal(text) => Some(text.clone()),
                Part::Field { name, .. } => field_to_string(record, name),
                Part::Bucket { field, unit } => match bucket_date(record, field) {
                    Ok(Some(date)) => Some(render_bucket_unit(&date, *unit)),
                    Ok(None) => None,
                    Err(detail) if strict => {
                        return Err(Error::PathRenderFailed {
                            message: format!(
                                "date-bucket reference in \"{}\": {detail}",
                                self.source
                            ),
                        });
                    }
                    Err(_) => None,
                },
                Part::Expression { handle, .. } => match engine.call(*handle, std::slice::from_ref(record)) {
                    Ok(value) => engine.to_path_string(&value),
                    // An undefined identifier is "un-renderable", not fatal —
                    // lets a partial query walk the tree fully (host parity).
                    Err(SnippetError::UndefinedReference(_)) => None,
                    Err(SnippetError::Other(message)) => {
                        return Err(Error::PathRenderFailed {
                            message: format!(
                                "expression in component of \"{}\" failed: {message}",
                                self.source
                            ),
                        });
                    }
                },
            };
            match piece {
                Some(p) => out.push_str(&p),
                None => return Ok(None),
            }
        }
        Ok(Some(out))
    }

    /// Names of record fields that contribute to rendering this template — the
    /// query auto-derivation set consumers use to identify a record by its
    /// rendered path (e.g. `Sheet.patch`'s query derivation in the CLI). A
    /// behavior-preserving port of the host `Template.getFieldNames`:
    ///
    /// - `field` components contribute the field name directly;
    /// - `expression` components contribute a best-effort scan of the bare
    ///   identifiers in their source, minus JS keywords/globals. False positives
    ///   (e.g. `(slug || legacyId)` yields both) are fine — the caller passes
    ///   only known input fields downstream.
    ///
    /// Insertion-ordered and de-duplicated, matching the host's `Set` spread.
    pub fn get_field_names(&self) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for c in &self.components {
            for p in &c.parts {
                match p {
                    Part::Field { name, .. } => {
                        if seen.insert(name.clone()) {
                            out.push(name.clone());
                        }
                    }
                    // A bucket contributes its base (top-level) field name —
                    // the same contribution an expression scan would make for
                    // a dotted member access.
                    Part::Bucket { field, .. } => {
                        let name = &field[0];
                        if seen.insert(name.clone()) {
                            out.push(name.clone());
                        }
                    }
                    Part::Expression { source, .. } => {
                        for id in extract_identifiers(source) {
                            if seen.insert(id.clone()) {
                                out.push(id);
                            }
                        }
                    }
                    Part::Literal(_) => {}
                }
            }
        }
        out
    }

    /// Render each component against a (possibly partial) `query` for the
    /// query-tree walk: the value the component renders to (`None` when a field
    /// or expression it needs is absent → the walk expands across all subtrees
    /// at that level), plus its recursive flag. This is the planning half of the
    /// host renderer's query *pruning* — see [`crate::query`] for the walk that
    /// consumes it. Invalid-char rejection is intentionally NOT applied here
    /// (the host applies it only in `render`, not in `queryTree`).
    pub fn plan_query(
        &self,
        query: &Value,
        engine: &mut Engine,
    ) -> Result<Vec<QueryComponentPlan>> {
        let mut out = Vec::with_capacity(self.components.len());
        for c in &self.components {
            let rendered = self.render_component(c, query, engine, false)?;
            out.push(QueryComponentPlan {
                rendered,
                recursive: c.recursive,
            });
        }
        Ok(out)
    }
}

/// JS keywords + globals excluded from the [`Template::get_field_names`]
/// identifier scan — a verbatim port of `JS_RESERVED` in
/// `packages/gitsheets/src/path-template/index.ts`.
const JS_RESERVED: &[&str] = &[
    "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
    "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import",
    "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
    "typeof", "undefined", "var", "void", "while", "with", "yield", "let", "static", "async",
    "await", "of", "Array", "Boolean", "Date", "Number", "Object", "String", "Math", "JSON",
    "RegExp", "Symbol", "Promise", "Map", "Set", "NaN", "Infinity", "globalThis",
];

/// Bare identifiers in an expression, matching the host regex
/// `/(?<![.\w$])([a-zA-Z_$][a-zA-Z0-9_$]*)/g` then the `JS_RESERVED` filter.
/// Members (`x.y`) contribute only `x` because the lookbehind rejects a start
/// preceded by `.`/word-char/`$`. Implemented as a manual scan (Rust `regex`
/// has no lookbehind).
fn extract_identifiers(source: &str) -> Vec<String> {
    let chars: Vec<char> = source.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$';
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_alphabetic() || c == '_' || c == '$' {
            // Lookbehind: a start char is a match only if the previous char is
            // not `.`, a word char, or `$`.
            let prev_ok = i == 0 || {
                let p = chars[i - 1];
                !(p == '.' || is_word(p))
            };
            let mut j = i + 1;
            while j < chars.len() && is_word(chars[j]) {
                j += 1;
            }
            if prev_ok {
                let id: String = chars[i..j].iter().collect();
                if !JS_RESERVED.contains(&id.as_str()) {
                    out.push(id);
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// Native stringification of a field value, matching the host `stringifyValue`:
/// strings as-is; numbers/booleans via their JS `String(...)` form; everything
/// that has no unambiguous path representation (`null`/absent, arrays, tables,
/// and — see the divergence note in the plan — datetimes) → `None`.
fn field_to_string(record: &Value, name: &str) -> Option<String> {
    let Value::Table(map) = record else {
        return None;
    };
    match map.get(name) {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Integer(i)) => Some(i.to_string()),
        Some(Value::Float(f)) => Some(format_js_number(*f)),
        Some(Value::Boolean(b)) => Some(if *b { "true".into() } else { "false".into() }),
        // Datetime / Array / Table have no native path form here (a host Date
        // field would stringify to a locale/TZ-dependent string — see the plan's
        // enumerated divergence; nobody uses a raw Date as a path segment).
        Some(_) => None,
    }
}

/// Format an f64 the way JS `String(n)` does for the common cases: an integral
/// float prints without a decimal (`1.0` → `"1"`), `1.5` → `"1.5"`. (Exotic
/// scientific-notation thresholds differ from V8; an edge for a float used
/// directly as a path segment, which is itself unusual.)
fn format_js_number(f: f64) -> String {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

// ── date-bucket rendering (spec: "Date-bucket references") ───────────────────

/// Resolve a (possibly dotted) bucket field against `record` and reduce it to
/// the **UTC calendar date** the bucket partitions on.
///
/// - `Ok(None)` — the field (or a dotted ancestor) is absent: the component is
///   un-renderable, same as the existing missing-field rule.
/// - `Err(detail)` — the field is present but isn't a date: wrong type, a TOML
///   local-time, or an unparseable string. `render` (strict) surfaces this as
///   `PathRenderFailed`; query planning degrades it to un-renderable.
fn bucket_date(record: &Value, field: &[String]) -> std::result::Result<Option<NaiveDate>, String> {
    let mut current = record;
    for seg in field {
        let Value::Table(map) = current else {
            return Ok(None);
        };
        match map.get(seg) {
            Some(v) => current = v,
            None => return Ok(None),
        }
    }
    let name = field.join(".");
    match current {
        Value::Datetime(dt) => date_from_toml_datetime(dt, &name).map(Some),
        Value::String(s) => parse_iso_date(s, &name).map(Some),
        other => Err(format!(
            "field \"{name}\" has type {} — date-bucket fields accept TOML \
             datetime/local-datetime/local-date values or ISO 8601 strings",
            other.type_name()
        )),
    }
}

/// The UTC calendar date of a TOML datetime. **UTC always**: an offset
/// datetime is normalized to UTC before its date parts are read; offset-less
/// kinds (local datetime, local date) are taken at face value — bucket
/// rendering never consults a timezone.
fn date_from_toml_datetime(
    dt: &Datetime,
    name: &str,
) -> std::result::Result<NaiveDate, String> {
    let Datetime(inner) = dt;
    let Some(date) = inner.date else {
        return Err(format!(
            "field \"{name}\" is a TOML local-time, which has no date to bucket on"
        ));
    };
    let date = NaiveDate::from_ymd_opt(date.year as i32, date.month as u32, date.day as u32)
        .ok_or_else(|| format!("field \"{name}\" has an out-of-range date"))?;
    let (Some(time), Some(offset)) = (inner.time, inner.offset) else {
        return Ok(date);
    };
    // Wall-clock components at `offset` → the instant's UTC date.
    let offset_minutes: i64 = match offset {
        toml::value::Offset::Z => 0,
        toml::value::Offset::Custom { minutes } => minutes as i64,
    };
    let wall = date
        .and_hms_opt(time.hour as u32, time.minute as u32, time.second as u32)
        .ok_or_else(|| format!("field \"{name}\" has an out-of-range time"))?;
    let utc = wall - chrono::Duration::minutes(offset_minutes);
    Ok(utc.date())
}

/// The UTC calendar date of an ISO 8601 string: date-only (`2026-03-09`),
/// datetime without offset (taken at face value), or datetime with offset /
/// `Z` (normalized to UTC).
fn parse_iso_date(s: &str, name: &str) -> std::result::Result<NaiveDate, String> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Ok(dt.to_utc().date_naive());
    }
    if let Ok(dt) = s.parse::<chrono::NaiveDateTime>() {
        return Ok(dt.date());
    }
    if let Ok(d) = s.parse::<NaiveDate>() {
        return Ok(d);
    }
    Err(format!(
        "field \"{name}\" value {s:?} is not an ISO 8601 date or datetime"
    ))
}

/// Render one bucket unit of `date`, zero-padded (`MM`/`DD`/`WW` two digits,
/// years four). `YYYY/WW` uses ISO-8601 week numbering, where the year is the
/// ISO **week-based** year — near January 1 / December 31 it can differ from
/// the calendar year (2027-01-01 is ISO 2026-W53).
fn render_bucket_unit(date: &NaiveDate, unit: BucketUnit) -> String {
    match unit {
        BucketUnit::CalendarYear => format!("{:04}", date.year()),
        BucketUnit::Month => format!("{:02}", date.month()),
        BucketUnit::Day => format!("{:02}", date.day()),
        BucketUnit::IsoWeekYear => format!("{:04}", date.iso_week().year()),
        BucketUnit::IsoWeek => format!("{:02}", date.iso_week().week()),
    }
}

// ── invalid-character rejection ───────────────────────────────────────────────

fn is_windows_invalid(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 0x20
}

fn reject_invalid_chars(
    rendered: &str,
    recursive: bool,
    source: &str,
    component_index: usize,
) -> Result<()> {
    for c in rendered.chars() {
        // Non-recursive components additionally forbid `/` (it would silently
        // expand the path structure); recursive `field/**` components allow it.
        let invalid = is_windows_invalid(c) || (!recursive && c == '/');
        if invalid {
            return Err(Error::PathInvalidChars {
                message: format!(
                    "component {component_index} of \"{source}\" rendered to {rendered:?}, which contains disallowed character {:?}",
                    c
                ),
            });
        }
    }
    Ok(())
}

// ── parser (port of parseTemplateString / buildComponent) ─────────────────────

/// A bare field reference: identifier chars optionally followed by the `/**`
/// recursive suffix. Anything else inside `${{ }}` is an expression.
fn is_field_name(s: &str) -> bool {
    let body = s.strip_suffix("/**").unwrap_or(s);
    !body.is_empty()
        && body
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Recognize a date-bucket *attempt*: `<field(.dotted)?> : <format>`. Returns
/// the dotted field segments and the raw format text. Format validation
/// against the closed enum happens at the call site, so an unknown format is
/// `config_invalid` rather than falling through to the expression compiler.
///
/// Recognizing this shape breaks no working template: `(field: ...)` is a JS
/// labeled statement inside the renderer's `return (...)` wrapper — a
/// guaranteed syntax error — so the colon-after-identifier space was dead.
fn split_bucket_attempt(expr: &str) -> Option<(Vec<String>, &str)> {
    let (head, tail) = expr.split_once(':')?;
    let head = head.trim();
    if head.is_empty() {
        return None;
    }
    let segments: Vec<&str> = head.split('.').collect();
    let is_ident = |s: &&str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    if !segments.iter().all(is_ident) {
        return None;
    }
    Some((
        segments.into_iter().map(str::to_string).collect(),
        tail.trim(),
    ))
}

fn parse_template(source: &str, engine: &mut Engine) -> Result<Vec<Component>> {
    let normalized = source.trim_matches('/');
    if normalized.is_empty() {
        return Err(Error::PathRenderFailed {
            message: "path template is empty".into(),
        });
    }

    let chars: Vec<char> = normalized.chars().collect();
    let mut segments: Vec<Vec<Part>> = vec![Vec::new()];
    let mut pending_literal = String::new();
    let mut i = 0;

    let starts_with = |chars: &[char], idx: usize, pat: &str| -> bool {
        let pat: Vec<char> = pat.chars().collect();
        idx + pat.len() <= chars.len() && chars[idx..idx + pat.len()] == pat[..]
    };

    while i < chars.len() {
        if starts_with(&chars, i, "${{") {
            flush_literal(&mut pending_literal, &mut segments);
            i += 3;
            let mut expr = String::new();
            while !starts_with(&chars, i, "}}") {
                if i >= chars.len() {
                    return Err(Error::PathRenderFailed {
                        message: format!(
                            "expression \"${{{{{expr}\" in template \"{source}\" was not closed with }}}}"
                        ),
                    });
                }
                expr.push(chars[i]);
                i += 1;
            }
            let expr = expr.trim().to_string();
            i += 2;

            // Date-bucket reference — recognized BEFORE the expression
            // fallback (spec: "Date-bucket references § Grammar").
            if let Some((field, format_src)) = split_bucket_attempt(&expr) {
                let units = BUCKET_FORMATS
                    .iter()
                    .find(|(f, _)| *f == format_src)
                    .map(|(_, units)| *units);
                let Some(units) = units else {
                    return Err(Error::ConfigInvalid {
                        message: format!(
                            "invalid date-bucket format {format_src:?} in \"${{{{ {expr} }}}}\" — \
                             supported formats: YYYY, YYYY/MM, YYYY/MM/DD, YYYY/WW"
                        ),
                    });
                };
                // A bucket expands into multiple real segments, so it must
                // stand alone in its path segment: nothing already in the
                // segment (any pending literal was flushed above), and a `/`
                // or end-of-template after it.
                let standalone_before = segments.last().unwrap().is_empty();
                let standalone_after = i >= chars.len() || chars[i] == '/';
                if !standalone_before || !standalone_after {
                    return Err(Error::ConfigInvalid {
                        message: format!(
                            "date-bucket reference \"${{{{ {expr} }}}}\" must stand alone in its \
                             path segment — no literal prefix/suffix or adjacent references"
                        ),
                    });
                }
                for (idx, unit) in units.iter().enumerate() {
                    if idx > 0 {
                        segments.push(Vec::new());
                    }
                    segments.last_mut().unwrap().push(Part::Bucket {
                        field: field.clone(),
                        unit: *unit,
                    });
                }
                continue;
            }

            if is_field_name(&expr) {
                let recursive = expr.ends_with("/**");
                let name = if recursive {
                    expr[..expr.len() - 3].to_string()
                } else {
                    expr.clone()
                };
                segments
                    .last_mut()
                    .unwrap()
                    .push(Part::Field { name, recursive });
            } else {
                let wrapped = format!("(record) => {{ with (record) {{ return ({expr}) }} }}");
                let handle = engine.compile(&wrapped).map_err(|e| Error::PathRenderFailed {
                    message: format!(
                        "expression {expr:?} failed to compile: {}",
                        e.message()
                    ),
                })?;
                segments
                    .last_mut()
                    .unwrap()
                    .push(Part::Expression { handle, source: expr });
            }
        } else if chars[i] == '/' {
            flush_literal(&mut pending_literal, &mut segments);
            segments.push(Vec::new());
            i += 1;
        } else {
            pending_literal.push(chars[i]);
            i += 1;
        }
    }
    flush_literal(&mut pending_literal, &mut segments);

    let mut components = Vec::with_capacity(segments.len());
    for (idx, parts) in segments.into_iter().enumerate() {
        components.push(build_component(parts, idx, source)?);
    }

    // Recursive (`/**`) must be the last component if present.
    for c in &components[..components.len().saturating_sub(1)] {
        if c.recursive {
            return Err(Error::PathRenderFailed {
                message: "recursive component (${{ ... /** }}) must be the final component of the template".into(),
            });
        }
    }

    Ok(components)
}

fn flush_literal(pending: &mut String, segments: &mut [Vec<Part>]) {
    if !pending.is_empty() {
        segments
            .last_mut()
            .unwrap()
            .push(Part::Literal(std::mem::take(pending)));
    }
}

fn build_component(parts: Vec<Part>, index: usize, source: &str) -> Result<Component> {
    if parts.is_empty() {
        return Err(Error::PathRenderFailed {
            message: format!(
                "empty component at index {index} of \"{source}\" — consecutive slashes are not allowed"
            ),
        });
    }

    let only_recursive = parts.len() == 1
        && matches!(&parts[0], Part::Field { recursive: true, .. });

    if !only_recursive {
        for part in &parts {
            if let Part::Field {
                recursive: true,
                name,
            } = part
            {
                return Err(Error::PathRenderFailed {
                    message: format!(
                        "recursive field reference (${{{{ {name}/** }}}}) must be the only part of its component"
                    ),
                });
            }
        }
    }

    Ok(Component {
        parts,
        recursive: only_recursive,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;

    fn table(pairs: &[(&str, Value)]) -> Value {
        let mut m = IndexMap::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        Value::Table(m)
    }

    fn render(template: &str, record: &Value) -> Result<String> {
        let mut eng = Engine::new().unwrap();
        let t = Template::compile(template, &mut eng)?;
        t.render(record, &mut eng)
    }

    #[test]
    fn simple_field() {
        let r = table(&[("slug", Value::String("jane".into()))]);
        assert_eq!(render("${{ slug }}", &r).unwrap(), "jane");
    }

    #[test]
    fn composite_two_level() {
        let r = table(&[
            ("domain", Value::String("af.mil".into())),
            ("username", Value::String("grandma".into())),
        ]);
        assert_eq!(
            render("${{ domain }}/${{ username }}", &r).unwrap(),
            "af.mil/grandma"
        );
    }

    #[test]
    fn multi_variable_per_segment_issue_105() {
        let r = table(&[
            ("year", Value::Integer(2026)),
            ("status", Value::String("active".into())),
            ("id", Value::Integer(12345)),
        ]);
        assert_eq!(
            render("${{ year }}/${{ status }}--${{ id }}", &r).unwrap(),
            "2026/active--12345"
        );
    }

    #[test]
    fn expression_partition_by_date_parts() {
        let dt = Value::Datetime("2026-03-09T12:00:00Z".parse().unwrap());
        let r = table(&[("publishedAt", dt), ("slug", Value::String("hi".into()))]);
        let out = render(
            "${{ publishedAt.getUTCFullYear() }}/${{ publishedAt.getUTCMonth() }}/${{ slug }}",
            &r,
        )
        .unwrap();
        // getUTCMonth is 0-based, exactly like JS.
        assert_eq!(out, "2026/2/hi");
    }

    #[test]
    fn missing_field_fails_render() {
        let r = table(&[("other", Value::String("x".into()))]);
        let err = render("${{ slug }}", &r).unwrap_err();
        assert_eq!(err.code(), "path_render_failed");
    }

    #[test]
    fn invalid_char_is_rejected() {
        let r = table(&[("slug", Value::String("a:b".into()))]);
        let err = render("${{ slug }}", &r).unwrap_err();
        assert_eq!(err.code(), "path_invalid_chars");
    }

    #[test]
    fn slash_in_nonrecursive_segment_is_rejected() {
        let r = table(&[("slug", Value::String("a/b".into()))]);
        let err = render("${{ slug }}", &r).unwrap_err();
        assert_eq!(err.code(), "path_invalid_chars");
    }

    #[test]
    fn recursive_component_allows_slashes() {
        let r = table(&[("contentPath", Value::String("docs/guides/intro".into()))]);
        assert_eq!(
            render("${{ contentPath/** }}", &r).unwrap(),
            "docs/guides/intro"
        );
    }

    #[test]
    fn recursive_must_be_last() {
        let mut eng = Engine::new().unwrap();
        let err = Template::compile("${{ a/** }}/${{ b }}", &mut eng).unwrap_err();
        assert_eq!(err.code(), "path_render_failed");
    }

    #[test]
    fn empty_template_is_rejected() {
        let mut eng = Engine::new().unwrap();
        assert!(Template::compile("///", &mut eng).is_err());
    }

    #[test]
    fn consecutive_slashes_rejected() {
        let mut eng = Engine::new().unwrap();
        assert!(Template::compile("${{ a }}//${{ b }}", &mut eng).is_err());
    }

    #[test]
    fn expression_with_undefined_identifier_is_unrenderable() {
        // At full-record render time a missing identifier means the path can't
        // be produced → path_render_failed (the component is un-renderable).
        let r = table(&[("slug", Value::String("x".into()))]);
        let err = render("${{ missing.toLowerCase() }}", &r).unwrap_err();
        assert_eq!(err.code(), "path_render_failed");
    }

    #[test]
    fn integer_and_boolean_fields_stringify_like_js() {
        let r = table(&[("n", Value::Integer(42)), ("b", Value::Boolean(true))]);
        assert_eq!(render("${{ n }}/${{ b }}", &r).unwrap(), "42/true");
    }

    fn field_names(template: &str) -> Vec<String> {
        let mut eng = Engine::new().unwrap();
        Template::compile(template, &mut eng).unwrap().get_field_names()
    }

    #[test]
    fn get_field_names_collects_field_components() {
        assert_eq!(field_names("${{ slug }}"), vec!["slug"]);
        assert_eq!(field_names("${{ domain }}/${{ username }}"), vec!["domain", "username"]);
        assert_eq!(
            field_names("${{ year }}/${{ status }}--${{ id }}"),
            vec!["year", "status", "id"]
        );
        assert_eq!(field_names("${{ contentPath/** }}"), vec!["contentPath"]);
        // Literal-only template contributes no field names.
        assert!(field_names("users/all").is_empty());
    }

    #[test]
    fn get_field_names_scans_expression_identifiers_minus_members_and_keywords() {
        // Member access contributes only the object identifier.
        assert_eq!(
            field_names("${{ publishedAt.getUTCFullYear() }}/${{ slug }}"),
            vec!["publishedAt", "slug"]
        );
        // `||` expression: both operands; de-duped, insertion-ordered.
        assert_eq!(field_names("${{ (slug || legacyId) }}"), vec!["slug", "legacyId"]);
        // Reserved words / globals are excluded; `id` survives.
        assert_eq!(field_names("shard-${{ id % 4 }}/${{ id }}"), vec!["id"]);
    }

    // ── date-bucket references (spec: "Date-bucket references") ─────────────

    fn dt(s: &str) -> Value {
        Value::Datetime(s.parse().unwrap())
    }

    #[test]
    fn bucket_renders_each_format() {
        let r = table(&[("publishedAt", dt("2026-03-09T12:00:00Z")), ("slug", Value::String("hi".into()))]);
        assert_eq!(render("${{ publishedAt: YYYY }}/${{ slug }}", &r).unwrap(), "2026/hi");
        assert_eq!(render("${{ publishedAt: YYYY/MM }}/${{ slug }}", &r).unwrap(), "2026/03/hi");
        assert_eq!(
            render("${{ publishedAt: YYYY/MM/DD }}/${{ slug }}", &r).unwrap(),
            "2026/03/09/hi"
        );
        // 2026-03-09 is a Monday in ISO week 11 of week-year 2026.
        assert_eq!(render("${{ publishedAt: YYYY/WW }}/${{ slug }}", &r).unwrap(), "2026/11/hi");
    }

    #[test]
    fn bucket_zero_pads_two_digit_parts() {
        let r = table(&[("d", dt("2026-01-02"))]);
        assert_eq!(render("${{ d: YYYY/MM/DD }}", &r).unwrap(), "2026/01/02");
        // Week 1 pads too (2026-01-02 is ISO 2026-W01).
        assert_eq!(render("${{ d: YYYY/WW }}", &r).unwrap(), "2026/01");
    }

    #[test]
    fn iso_week_year_is_not_the_calendar_year_at_boundaries() {
        // January 1 belonging to week 53 of the PRIOR ISO year.
        let r = table(&[("d", dt("2027-01-01"))]);
        assert_eq!(render("${{ d: YYYY/WW }}", &r).unwrap(), "2026/53");
        // ...while the calendar-year formats keep the calendar year.
        assert_eq!(render("${{ d: YYYY }}", &r).unwrap(), "2027");

        // Late December belonging to week 1 of the NEXT ISO year.
        let r = table(&[("d", dt("2024-12-30"))]);
        assert_eq!(render("${{ d: YYYY/WW }}", &r).unwrap(), "2025/01");
        assert_eq!(render("${{ d: YYYY }}", &r).unwrap(), "2024");
    }

    #[test]
    fn bucket_normalizes_offset_datetimes_to_utc() {
        // 23:30 at -05:00 is 04:30 the NEXT day in UTC.
        let r = table(&[("d", dt("2025-12-31T23:30:00-05:00"))]);
        assert_eq!(render("${{ d: YYYY/MM/DD }}", &r).unwrap(), "2026/01/01");
        // And the other direction: 00:30+05:00 is the PREVIOUS day in UTC.
        let r = table(&[("d", dt("2026-01-01T00:30:00+05:00"))]);
        assert_eq!(render("${{ d: YYYY/MM/DD }}", &r).unwrap(), "2025/12/31");
    }

    #[test]
    fn bucket_takes_offsetless_values_at_face_value() {
        // TOML local-datetime and local-date have no offset: no TZ math.
        let r = table(&[("d", dt("2026-03-09T23:59:59"))]);
        assert_eq!(render("${{ d: YYYY/MM/DD }}", &r).unwrap(), "2026/03/09");
        let r = table(&[("d", dt("2026-03-09"))]);
        assert_eq!(render("${{ d: YYYY/MM/DD }}", &r).unwrap(), "2026/03/09");
    }

    #[test]
    fn bucket_accepts_iso_strings() {
        let r = table(&[("d", Value::String("2026-03-09".into()))]);
        assert_eq!(render("${{ d: YYYY/MM }}", &r).unwrap(), "2026/03");
        // Offset string normalizes to UTC.
        let r = table(&[("d", Value::String("2025-12-31T23:30:00-05:00".into()))]);
        assert_eq!(render("${{ d: YYYY/MM/DD }}", &r).unwrap(), "2026/01/01");
        // Offset-less datetime string reads at face value.
        let r = table(&[("d", Value::String("2026-03-09T23:59:59".into()))]);
        assert_eq!(render("${{ d: YYYY/MM/DD }}", &r).unwrap(), "2026/03/09");
    }

    #[test]
    fn bucket_may_be_the_entire_path() {
        // Daily-rollup identity: the bucket IS the record key.
        let r = table(&[("day", dt("2026-03-09"))]);
        assert_eq!(render("${{ day: YYYY/MM/DD }}", &r).unwrap(), "2026/03/09");
    }

    #[test]
    fn bucket_composes_anywhere_in_the_template() {
        let r = table(&[
            ("region", Value::String("us".into())),
            ("d", dt("2026-03-09")),
            ("slug", Value::String("x".into())),
        ]);
        assert_eq!(
            render("posts/${{ region }}/${{ d: YYYY/MM }}/${{ slug }}", &r).unwrap(),
            "posts/us/2026/03/x"
        );
    }

    #[test]
    fn bucket_dotted_field_reads_nested_tables() {
        let mut meta = IndexMap::new();
        meta.insert("publishedAt".to_string(), dt("2026-03-09"));
        let r = table(&[("meta", Value::Table(meta)), ("slug", Value::String("x".into()))]);
        assert_eq!(
            render("${{ meta.publishedAt: YYYY/MM }}/${{ slug }}", &r).unwrap(),
            "2026/03/x"
        );
    }

    #[test]
    fn bucket_missing_field_follows_the_missing_field_rule() {
        let r = table(&[("slug", Value::String("x".into()))]);
        let err = render("${{ d: YYYY/MM }}/${{ slug }}", &r).unwrap_err();
        assert_eq!(err.code(), "path_render_failed");
    }

    #[test]
    fn bucket_wrong_type_fails_render_with_a_naming_message() {
        for v in [Value::Integer(42), Value::Boolean(true), Value::Float(1.5)] {
            let r = table(&[("d", v), ("slug", Value::String("x".into()))]);
            let err = render("${{ d: YYYY/MM }}/${{ slug }}", &r).unwrap_err();
            assert_eq!(err.code(), "path_render_failed");
            assert!(err.message().contains("\"d\""), "message names the field: {}", err.message());
        }
    }

    #[test]
    fn bucket_unparseable_string_fails_render() {
        let r = table(&[("d", Value::String("not-a-date".into()))]);
        let err = render("${{ d: YYYY }}", &r).unwrap_err();
        assert_eq!(err.code(), "path_render_failed");
        assert!(err.message().contains("not-a-date"));
    }

    #[test]
    fn bucket_toml_local_time_fails_render() {
        let r = table(&[("d", dt("07:32:00"))]);
        let err = render("${{ d: YYYY }}", &r).unwrap_err();
        assert_eq!(err.code(), "path_render_failed");
        assert!(err.message().contains("local-time"));
    }

    #[test]
    fn bucket_invalid_format_is_config_invalid_at_compile() {
        let mut eng = Engine::new().unwrap();
        for bad in ["YYYY-MM", "MM/DD", "YYYY/MM/DD/HH", "yyyy", "WW", ""] {
            let src = format!("${{{{ d: {bad} }}}}/${{{{ slug }}}}");
            let err = Template::compile(&src, &mut eng).unwrap_err();
            assert_eq!(err.code(), "config_invalid", "format {bad:?}");
            assert!(err.message().contains("YYYY/MM/DD"), "message lists valid formats");
        }
    }

    #[test]
    fn bucket_must_stand_alone_in_its_segment() {
        let mut eng = Engine::new().unwrap();
        for bad in [
            "posts-${{ d: YYYY }}",             // literal prefix
            "${{ d: YYYY }}.draft",             // literal suffix
            "${{ d: YYYY }}${{ slug }}",        // adjacent reference
            "${{ slug }}-${{ d: YYYY/MM }}",    // reference prefix
        ] {
            let err = Template::compile(bad, &mut eng).unwrap_err();
            assert_eq!(err.code(), "config_invalid", "template {bad:?}");
        }
    }

    #[test]
    fn bucket_expands_component_count() {
        let mut eng = Engine::new().unwrap();
        let t = Template::compile("${{ d: YYYY/MM/DD }}/${{ slug }}", &mut eng).unwrap();
        assert_eq!(t.component_count(), 4);
        let t = Template::compile("${{ d: YYYY/WW }}", &mut eng).unwrap();
        assert_eq!(t.component_count(), 2);
    }

    #[test]
    fn get_field_names_includes_bucket_fields_once() {
        assert_eq!(
            field_names("${{ publishedAt: YYYY/MM/DD }}/${{ slug }}"),
            vec!["publishedAt", "slug"]
        );
        // Dotted bucket contributes its base field, like an expression scan.
        assert_eq!(
            field_names("${{ meta.publishedAt: YYYY/MM }}/${{ slug }}"),
            vec!["meta", "slug"]
        );
    }

    #[test]
    fn plan_query_renders_buckets_from_query_values_and_wildcards_otherwise() {
        let mut eng = Engine::new().unwrap();
        let t = Template::compile("${{ d: YYYY/MM }}/${{ slug }}", &mut eng).unwrap();

        // Datetime query value → both bucket segments render.
        let q = table(&[("d", dt("2026-03-09T12:00:00Z"))]);
        let plan = t.plan_query(&q, &mut eng).unwrap();
        let rendered: Vec<Option<&str>> = plan.iter().map(|p| p.rendered.as_deref()).collect();
        assert_eq!(rendered, vec![Some("2026"), Some("03"), None]);

        // ISO-string query value renders too.
        let q = table(&[("d", Value::String("2026-03-09".into()))]);
        let plan = t.plan_query(&q, &mut eng).unwrap();
        assert_eq!(plan[0].rendered.as_deref(), Some("2026"));
        assert_eq!(plan[1].rendered.as_deref(), Some("03"));

        // Absent field → wildcard (None), not an error.
        let q = table(&[("slug", Value::String("x".into()))]);
        let plan = t.plan_query(&q, &mut eng).unwrap();
        assert_eq!(plan[0].rendered, None);
        assert_eq!(plan[1].rendered, None);
        assert_eq!(plan[2].rendered.as_deref(), Some("x"));

        // Wrong-typed / unparseable query value degrades to wildcard — the
        // walk widens; the record-level filter still applies downstream.
        for v in [Value::Integer(42), Value::String("not-a-date".into())] {
            let q = table(&[("d", v)]);
            let plan = t.plan_query(&q, &mut eng).unwrap();
            assert_eq!(plan[0].rendered, None);
            assert_eq!(plan[1].rendered, None);
        }
    }

    #[test]
    fn template_compiles_once_renders_many() {
        let mut eng = Engine::new().unwrap();
        let t = Template::compile("${{ slug.toUpperCase() }}", &mut eng).unwrap();
        let r1 = table(&[("slug", Value::String("a".into()))]);
        let r2 = table(&[("slug", Value::String("b".into()))]);
        assert_eq!(t.render(&r1, &mut eng).unwrap(), "A");
        assert_eq!(t.render(&r2, &mut eng).unwrap(), "B");
    }
}
