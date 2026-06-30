//! The embedded JS engine for definition escape-hatch snippets.
//!
//! Per [`specs/rust-core.md`](../../../specs/rust-core.md) ("Embedded code
//! execution"), gitsheets is **declarative-first**: the common cases
//! (`${{ field }}` substitution, `{field: dir}` sort directives, JSON-Schema
//! validation, built-in partition derivations) are evaluated natively over the
//! core [`Value`]. The one thing that genuinely needs arbitrary logic — a
//! definition-embedded raw-JS snippet (a path-template *expression* component
//! like `${{ publishedAt.getUTCFullYear() }}`, or a raw-JS sort comparator) —
//! runs in a JS engine **embedded in the core**, never the host binding's JS
//! runtime. Running it in the core is what keeps it portable: a Python consumer
//! gets the *core's* engine, so Node and Python produce identical results.
//!
//! ## Engine choice & contract
//!
//! The engine is [`boa_engine`] (pure-Rust). Its JS semantics determine sort
//! order and partition paths, so it is part of the **canonical-behavior
//! contract**: the version is pinned EXACTLY in `Cargo.toml` (`=0.21.1`) and
//! upgraded as deliberately as a normalization change. The `node:vm` parity
//! gate (the binding's `engine-parity.mjs` boundary suite) is what catches any
//! real divergence on an actual snippet before adoption.
//!
//! ## Compile-once, reuse-across-operations
//!
//! Each definition's snippets are compiled **once** (on sheet-open) into
//! persistent callable handles held on the [`Engine`], then reused across every
//! operation — never re-parsed per call. This mirrors the host's `node:vm`
//! comparators being built once in `buildSorter` and the path template being
//! parsed once per sheet.
//!
//! ## Thread-confinement
//!
//! A boa [`Context`] is single-threaded (`!Send`), so [`Engine`] is `!Send`
//! too. It is pinned to its owning thread — the same discipline holo-tree's
//! thread-local cache already needs. Bindings construct and call it on the
//! thread that owns the `Store`.

use boa_engine::object::builtins::JsArray;
use boa_engine::{js_string, Context, JsNativeErrorKind, JsValue as BoaValue, Source};

use crate::error::{Error, Result};
use crate::value::{Datetime, Value};

/// An opaque handle to a snippet compiled into the engine, returned by
/// [`Engine::compile`] and reused across operations.
pub type SnippetHandle = usize;

/// The outcome of a JS exception raised while *calling* a compiled snippet.
/// Path rendering distinguishes the two: an undefined-identifier reference is
/// "this component is un-renderable" (expected at query time, when only some
/// fields are bound), while any other exception is a genuine failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SnippetError {
    /// A `ReferenceError` — an identifier the snippet names is not defined on
    /// the record. Mirrors the host renderer treating `… is not defined` as an
    /// un-renderable component rather than a throw.
    UndefinedReference(String),
    /// Any other JS exception (TypeError, SyntaxError at call, …).
    Other(String),
}

/// A persistent embedded JS engine: one boa [`Context`] plus the definition's
/// compiled snippet callables, held for the lifetime of the owning handle.
///
/// `!Send` (boa's `Context` is): construct and use on one thread.
pub struct Engine {
    context: Context,
    /// `(ms) => new Date(ms)` — builds a real JS `Date` for datetime fields, so
    /// a snippet like `publishedAt.getUTCFullYear()` sees a `Date`, matching the
    /// host where the record's datetime is a JS `Date` of the same epoch ms.
    make_date: BoaValue,
    /// Compiled snippet callables, indexed by [`SnippetHandle`].
    snippets: Vec<BoaValue>,
}

impl Engine {
    /// Build a fresh engine. Evaluates the one bootstrap helper (`make_date`).
    pub fn new() -> Result<Self> {
        let mut context = Context::default();
        let make_date = context
            .eval(Source::from_bytes("(ms) => new Date(ms)"))
            .map_err(|e| Error::ConfigInvalid {
                message: format!("embedded engine bootstrap failed: {e}"),
            })?;
        Ok(Self {
            context,
            make_date,
            snippets: Vec::new(),
        })
    }

    /// Compile a JS source that must evaluate to a **callable**, returning a
    /// reusable [`SnippetHandle`]. Callers pass the fully-wrapped source — e.g.
    /// `(record) => { with (record) { return (EXPR) } }` for a path expression,
    /// or `(a, b) => { RULE }` for a sort comparator — exactly as the host's
    /// `node:vm` path does. A snippet that fails to parse, or that doesn't
    /// evaluate to a function, is a [`Error::ConfigInvalid`] (a definition
    /// problem surfaced at sheet-open, not per-record).
    pub fn compile(&mut self, source: &str) -> Result<SnippetHandle> {
        let value =
            self.context
                .eval(Source::from_bytes(source))
                .map_err(|e| Error::ConfigInvalid {
                    message: format!("embedded snippet failed to compile: {e}"),
                })?;
        if !value.is_callable() {
            return Err(Error::ConfigInvalid {
                message: format!(
                    "embedded snippet did not evaluate to a function: {source:?}"
                ),
            });
        }
        self.snippets.push(value);
        Ok(self.snippets.len() - 1)
    }

    /// How many snippets have been compiled into this engine. Bindings expose
    /// this to prove snippets are compiled **once on open** and never per call:
    /// the count is set at compile time and never grows as operations run.
    pub fn snippet_count(&self) -> usize {
        self.snippets.len()
    }

    /// Call a compiled snippet with `args` (marshalled from core values), and
    /// return the raw boa result for the caller to interpret (stringify for a
    /// path component; coerce to a number for a comparator).
    pub fn call(
        &mut self,
        handle: SnippetHandle,
        args: &[Value],
    ) -> std::result::Result<BoaValue, SnippetError> {
        let func = self
            .snippets
            .get(handle)
            .cloned()
            .ok_or_else(|| SnippetError::Other(format!("unknown snippet handle {handle}")))?;
        let callable = func
            .as_callable()
            .ok_or_else(|| SnippetError::Other("snippet is not callable".into()))?;

        let mut boa_args = Vec::with_capacity(args.len());
        for arg in args {
            boa_args.push(
                self.marshal_to_boa(arg)
                    .map_err(|e| SnippetError::Other(e.message().to_string()))?,
            );
        }

        match callable.call(&BoaValue::undefined(), &boa_args, &mut self.context) {
            Ok(v) => Ok(v),
            Err(err) => {
                let kind = err
                    .try_native(&mut self.context)
                    .map(|n| n.kind.clone())
                    .ok();
                let message = err.to_string();
                match kind {
                    Some(JsNativeErrorKind::Reference) => {
                        Err(SnippetError::UndefinedReference(message))
                    }
                    _ => Err(SnippetError::Other(message)),
                }
            }
        }
    }

    /// Stringify a boa value the way the host renderer's `stringifyValue` does:
    /// primitives (string / number / boolean / bigint) → their JS `String(...)`
    /// form; `null` / `undefined` / functions / objects → `None` (the component
    /// is un-renderable). Matches `packages/gitsheets/src/path-template`.
    pub fn to_path_string(&mut self, value: &BoaValue) -> Option<String> {
        if value.is_null_or_undefined() || value.is_callable() || value.is_object() {
            return None;
        }
        if value.is_string() || value.is_number() || value.is_boolean() || value.is_bigint() {
            // ECMAScript ToString — JS-accurate number formatting (`2026`, `1.5`).
            return value
                .to_string(&mut self.context)
                .ok()
                .map(|s| s.to_std_string_escaped());
        }
        None
    }

    /// Coerce a boa value to a number via ECMAScript `ToNumber` — what
    /// `Array.prototype.sort` does with a comparator's return value.
    pub fn to_number(&mut self, value: &BoaValue) -> Result<f64> {
        value.to_number(&mut self.context).map_err(|e| Error::ConfigInvalid {
            message: format!("comparator did not return a number: {e}"),
        })
    }

    // ── core Value -> boa JsValue marshalling ────────────────────────────────

    fn marshal_to_boa(&mut self, value: &Value) -> Result<BoaValue> {
        Ok(match value {
            Value::String(s) => js_string!(s.as_str()).into(),
            // JS has a single `number`; an i64 projects to f64 exactly as the
            // host record's integers already are (the binding marshalled them to
            // JS numbers). Beyond 2^53 this loses precision — same as the host.
            Value::Integer(i) => (*i as f64).into(),
            Value::Float(f) => (*f).into(),
            Value::Boolean(b) => (*b).into(),
            Value::Datetime(dt) => {
                let ms = datetime_to_unix_millis(dt);
                let make_date = self
                    .make_date
                    .as_callable()
                    .expect("make_date is callable");
                make_date
                    .call(&BoaValue::undefined(), &[(ms as f64).into()], &mut self.context)
                    .map_err(|e| Error::ConfigInvalid {
                        message: format!("failed to build JS Date: {e}"),
                    })?
            }
            Value::Array(items) => {
                let arr = JsArray::new(&mut self.context);
                for item in items {
                    let v = self.marshal_to_boa(item)?;
                    arr.push(v, &mut self.context).map_err(|e| Error::ConfigInvalid {
                        message: format!("failed to build JS array: {e}"),
                    })?;
                }
                arr.into()
            }
            Value::Table(map) => {
                let obj = boa_engine::object::JsObject::with_object_proto(self.context.intrinsics());
                for (k, val) in map {
                    let v = self.marshal_to_boa(val)?;
                    obj.set(js_string!(k.as_str()), v, false, &mut self.context)
                        .map_err(|e| Error::ConfigInvalid {
                            message: format!("failed to build JS object: {e}"),
                        })?;
                }
                obj.into()
            }
        })
    }
}

/// Epoch milliseconds for any of the four TOML datetime kinds, computed without
/// a calendar dependency (Howard Hinnant's `days_from_civil`). Local kinds (no
/// offset) are interpreted at UTC — the same least-lossy projection the Node
/// binding's `datetime_to_unix_millis` uses, so a datetime field reaches the
/// engine as the same instant the host's JS `Date` would carry.
fn datetime_to_unix_millis(dt: &Datetime) -> i64 {
    let Datetime(inner) = dt;
    let (year, month, day) = match inner.date {
        Some(d) => (d.year as i64, d.month as i64, d.day as i64),
        None => (1970, 1, 1),
    };
    let (hour, minute, second, nanos) = match inner.time {
        Some(t) => (
            t.hour as i64,
            t.minute as i64,
            t.second as i64,
            t.nanosecond as i64,
        ),
        None => (0, 0, 0, 0),
    };
    let offset_minutes: i64 = match inner.offset {
        Some(toml::value::Offset::Z) => 0,
        Some(toml::value::Offset::Custom { minutes }) => minutes as i64,
        None => 0,
    };
    let days = days_from_civil(year, month, day);
    let wall_ms = (((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + nanos / 1_000_000;
    // Components are wall-clock at `offset`; the instant is components − offset.
    wall_ms - offset_minutes * 60_000
}

/// Days since the Unix epoch (1970-01-01) for a proleptic-Gregorian civil date.
/// Howard Hinnant's algorithm (<http://howardhinnant.github.io/date_algorithms.html>).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;

    fn dt(s: &str) -> Value {
        Value::Datetime(s.parse::<Datetime>().expect("parse datetime"))
    }

    #[test]
    fn days_from_civil_matches_known_anchors() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        assert_eq!(days_from_civil(2000, 1, 1), 10957);
    }

    #[test]
    fn datetime_to_millis_matches_known_instant() {
        // 1979-05-27T07:32:00Z is 296_638_320_000 ms since epoch.
        let v = dt("1979-05-27T07:32:00Z");
        let Value::Datetime(d) = &v else { unreachable!() };
        assert_eq!(datetime_to_unix_millis(d), 296_638_320_000);
    }

    #[test]
    fn compiles_and_calls_a_comparator_reused_across_calls() {
        let mut eng = Engine::new().expect("engine");
        let h = eng
            .compile("(a, b) => { return a - b; }")
            .expect("compile");
        // Reused across operations — same handle, many calls.
        let r1 = eng.call(h, &[Value::Integer(1), Value::Integer(2)]).unwrap();
        let r2 = eng.call(h, &[Value::Integer(5), Value::Integer(3)]).unwrap();
        assert_eq!(eng.to_number(&r1).unwrap(), -1.0);
        assert_eq!(eng.to_number(&r2).unwrap(), 2.0);
    }

    #[test]
    fn path_expression_over_a_date_field_derives_partitions() {
        let mut eng = Engine::new().expect("engine");
        let h = eng
            .compile("(record) => { with (record) { return (publishedAt.getUTCFullYear()) } }")
            .expect("compile");
        let mut rec = IndexMap::new();
        rec.insert("publishedAt".to_string(), dt("1979-05-27T07:32:00Z"));
        let out = eng.call(h, &[Value::Table(rec)]).unwrap();
        assert_eq!(eng.to_path_string(&out).as_deref(), Some("1979"));
    }

    #[test]
    fn undefined_identifier_is_an_unrenderable_reference() {
        let mut eng = Engine::new().expect("engine");
        let h = eng
            .compile("(record) => { with (record) { return (missing.toLowerCase()) } }")
            .expect("compile");
        let rec = IndexMap::new();
        let err = eng.call(h, &[Value::Table(rec)]).unwrap_err();
        assert!(matches!(err, SnippetError::UndefinedReference(_)), "got {err:?}");
    }

    #[test]
    fn string_method_expression_renders() {
        let mut eng = Engine::new().expect("engine");
        let h = eng
            .compile("(record) => { with (record) { return (slug.toLowerCase()) } }")
            .expect("compile");
        let mut rec = IndexMap::new();
        rec.insert("slug".to_string(), Value::String("HELLO".into()));
        let out = eng.call(h, &[Value::Table(rec)]).unwrap();
        assert_eq!(eng.to_path_string(&out).as_deref(), Some("hello"));
    }

    #[test]
    fn objects_and_null_are_unrenderable() {
        let mut eng = Engine::new().expect("engine");
        let h = eng.compile("(record) => { with (record) { return (x) } }").unwrap();
        // null → None
        let mut rec = IndexMap::new();
        rec.insert("x".to_string(), Value::Array(vec![Value::Integer(1)]));
        let out = eng.call(h, &[Value::Table(rec)]).unwrap();
        assert_eq!(eng.to_path_string(&out), None, "array result is un-renderable");
    }
}
