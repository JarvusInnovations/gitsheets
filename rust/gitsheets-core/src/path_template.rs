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
//! - **Expression** components (`${{ publishedAt.getUTCFullYear() }}`) are the
//!   escape hatch: compiled once into the embedded [`Engine`] and evaluated per
//!   record. This is where partition derivations (date-parts, etc.) live, and
//!   it is the path-template half of the `node:vm` parity gate.
//!
//! Query-tree traversal/pruning (the *other* job of a parsed template) is a
//! record-engine concern and lands downstream; this module owns parse + render.

use crate::engine::{Engine, SnippetError, SnippetHandle};
use crate::error::{Error, Result};
use crate::value::Value;

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
    Field { name: String, recursive: bool },
    Expression { handle: SnippetHandle },
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
            let rendered = self.render_component(component, record, engine)?;
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
    /// Returns `Err` only for a genuine engine failure (a non-reference JS
    /// exception while evaluating an expression).
    fn render_component(
        &self,
        component: &Component,
        record: &Value,
        engine: &mut Engine,
    ) -> Result<Option<String>> {
        let mut out = String::new();
        for part in &component.parts {
            let piece = match part {
                Part::Literal(text) => Some(text.clone()),
                Part::Field { name, .. } => field_to_string(record, name),
                Part::Expression { handle } => match engine.call(*handle, std::slice::from_ref(record)) {
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
                segments.last_mut().unwrap().push(Part::Expression { handle });
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
