//! Aggregation — the declarative fold (spec: `behaviors/aggregation.md`).
//!
//! A sheet answers aggregate questions (a count, a sum, the extremes, an
//! average, the distinct values of a field, or an arbitrary `reduce`) over the
//! records matching a query filter. The grammar is one `Value` table — spelled
//! in TOML in a sheet config and in a binding's idiom at a call site — and its
//! evaluation lives here, in the core, so every binding gets the same answer
//! to the bit. That matters because aggregate results can be committed (as
//! persisted rollups) and must then be byte-identical across bindings.
//!
//! The pipeline is three steps, split so a binding can tell a *malformed
//! spec* (a call-site `TypeError`; a `ConfigError` in a config) from a
//! *data-dependent failure* (`AggregationError`):
//!
//! 1. [`Aggregates::from_value`] parses and validates the aggregates table;
//!    [`Aggregates::check_body_field`] rejects body-field references;
//!    [`Aggregates::prepare`] compiles any `reduce` / `finalize` snippets into
//!    the core's embedded engine. Every failure here is
//!    [`Error::ConfigInvalid`].
//! 2. [`aggregate_records`] walks the sheet exactly as a body-less query does
//!    (path-template pruning, the full filter applied in the core) and hands
//!    the matched records, in canonical path order, to the fold.
//! 3. [`fold`] evaluates every aggregate over those records. Failures are
//!    [`Error::AggregationFailed`] carrying the sheet and aggregate name.
//!
//! The fold is plain — one pass over the records in canonical path order, no
//! incremental shortcuts — so float `sum`/`avg` and `reduce` are trivially the
//! canonical computation.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};

use boa_engine::JsValue as BoaValue;
use holo_tree::{Context, MutableTree};
use indexmap::IndexMap;

use crate::config::FormatConfig;
use crate::engine::{Engine, SnippetError, SnippetHandle};
use crate::error::{Error, Result};
use crate::path_template::Template;
use crate::query::{self, compare_values, Filter};
use crate::value::Value;

/// One aggregate form. The declarative forms carry the field they read; the
/// `reduce` escape hatch carries its snippet bodies and `initial` value.
#[derive(Clone, Debug, PartialEq)]
pub enum Form {
    /// `{ count = true }` — every record contributes.
    Count,
    /// `{ sum = 'f' }` — records whose `f` is an integer or float.
    Sum(String),
    /// `{ avg = 'f' }` — as `sum`, divided by the contributing count.
    Avg(String),
    /// `{ min = 'f' }` — records whose `f` is a number, string, or datetime.
    Min(String),
    /// `{ max = 'f' }` — as `min`.
    Max(String),
    /// `{ distinct = 'f' }` — records whose `f` is a scalar.
    Distinct(String),
    /// `{ reduce = '<body>', initial = <value>, finalize = '<body>' }`.
    Reduce {
        body: String,
        initial: Value,
        finalize: Option<String>,
    },
}

impl Form {
    /// The record field a declarative form reads (`None` for `count` and
    /// `reduce`).
    pub fn field(&self) -> Option<&str> {
        match self {
            Form::Sum(f) | Form::Avg(f) | Form::Min(f) | Form::Max(f) | Form::Distinct(f) => {
                Some(f)
            }
            Form::Count | Form::Reduce { .. } => None,
        }
    }
}

/// One named aggregate: a form plus its optional `where` and `groupBy`
/// modifiers.
#[derive(Clone, Debug)]
pub struct AggregateSpec {
    pub name: String,
    pub form: Form,
    /// The `where` modifier — an equality / range filter applied before
    /// aggregating.
    pub filter: Option<Filter>,
    /// The `groupBy` modifier — the field whose string form keys the result.
    pub group_by: Option<String>,
}

/// A parsed aggregates table, in declaration order.
#[derive(Clone, Debug, Default)]
pub struct Aggregates {
    pub specs: Vec<AggregateSpec>,
}

/// A validated aggregates table whose `reduce` / `finalize` snippets are
/// known to compile — what [`fold`] runs. The fold compiles them again into a
/// fresh, runtime-limited engine (realm) per group, so `globalThis` state can't
/// leak between calls, aggregates, or groups (spec: "`reduce` … purity").
#[derive(Clone, Debug)]
pub struct Prepared {
    specs: Vec<AggregateSpec>,
}

impl Prepared {
    pub fn specs(&self) -> &[AggregateSpec] {
        &self.specs
    }
}

const FORM_KEYS: [&str; 7] = ["count", "sum", "avg", "min", "max", "distinct", "reduce"];

fn malformed(message: impl std::fmt::Display) -> Error {
    Error::ConfigInvalid {
        message: format!("aggregate spec: {message}"),
    }
}

fn field_name(name: &str, key: &str, value: &Value) -> Result<String> {
    match value {
        Value::String(s) if !s.is_empty() => Ok(s.clone()),
        _ => Err(malformed(format!(
            "{name:?}: `{key}` must name a field (a non-empty string), got {}",
            value.type_name()
        ))),
    }
}

impl AggregateSpec {
    /// Parse one `name = { … }` entry of an aggregates table.
    pub fn parse(name: &str, value: &Value) -> Result<AggregateSpec> {
        if name.is_empty() {
            return Err(malformed("an aggregate name must be a non-empty string"));
        }
        let Value::Table(map) = value else {
            return Err(malformed(format!(
                "{name:?} must be a table such as {{ count = true }} or {{ sum = 'field' }}, got {}",
                value.type_name()
            )));
        };
        let forms: Vec<&str> = map
            .keys()
            .map(String::as_str)
            .filter(|k| FORM_KEYS.contains(k))
            .collect();
        if forms.len() != 1 {
            return Err(malformed(format!(
                "{name:?} must carry exactly one of {} — found {}",
                FORM_KEYS.join(" / "),
                if forms.is_empty() { "none".to_string() } else { forms.join(", ") }
            )));
        }
        let form_key = forms[0];
        let allowed: &[&str] = if form_key == "reduce" {
            &["reduce", "initial", "finalize", "where", "groupBy"]
        } else {
            &[form_key, "where", "groupBy"]
        };
        if let Some(bad) = map.keys().find(|k| !allowed.contains(&k.as_str())) {
            return Err(malformed(format!(
                "{name:?}: unknown key `{bad}` for a `{form_key}` aggregate (allowed: {})",
                allowed.join(", ")
            )));
        }
        let raw = &map[form_key];
        let form = match form_key {
            "count" => match raw {
                Value::Boolean(true) => Form::Count,
                _ => return Err(malformed(format!("{name:?}: `count` must be `true`"))),
            },
            "sum" => Form::Sum(field_name(name, form_key, raw)?),
            "avg" => Form::Avg(field_name(name, form_key, raw)?),
            "min" => Form::Min(field_name(name, form_key, raw)?),
            "max" => Form::Max(field_name(name, form_key, raw)?),
            "distinct" => Form::Distinct(field_name(name, form_key, raw)?),
            _ => {
                let Value::String(body) = raw else {
                    return Err(malformed(format!(
                        "{name:?}: `reduce` must be a string — the body of (acc, record) => {{ … }}"
                    )));
                };
                let Some(initial) = map.get("initial") else {
                    return Err(malformed(format!("{name:?}: `reduce` requires `initial`")));
                };
                let finalize = match map.get("finalize") {
                    None => None,
                    Some(Value::String(s)) => Some(s.clone()),
                    Some(_) => {
                        return Err(malformed(format!(
                            "{name:?}: `finalize` must be a string — the body of (acc) => {{ … }}"
                        )))
                    }
                };
                Form::Reduce {
                    body: body.clone(),
                    initial: initial.clone(),
                    finalize,
                }
            }
        };
        let filter = match map.get("where") {
            None => None,
            Some(Value::Table(w)) => Some(
                Filter::from_table(w)
                    .map_err(|e| malformed(format!("{name:?}: `where`: {}", e.message())))?,
            ),
            Some(other) => {
                return Err(malformed(format!(
                    "{name:?}: `where` must be a filter table, got {}",
                    other.type_name()
                )))
            }
        };
        let group_by = match map.get("groupBy") {
            None => None,
            Some(v) => Some(field_name(name, "groupBy", v)?),
        };
        Ok(AggregateSpec {
            name: name.to_string(),
            form,
            filter,
            group_by,
        })
    }
}

impl Aggregates {
    /// Parse an aggregates table (`name → spec`). A malformed table is
    /// [`Error::ConfigInvalid`] — a call-site `TypeError` in the bindings.
    pub fn from_value(value: &Value) -> Result<Aggregates> {
        let Value::Table(map) = value else {
            return Err(malformed(format!(
                "the aggregates must be a table mapping names to specs, got {}",
                value.type_name()
            )));
        };
        let mut specs = Vec::with_capacity(map.len());
        for (name, spec) in map {
            specs.push(AggregateSpec::parse(name, spec)?);
        }
        Ok(Aggregates { specs })
    }

    /// Reject any reference to a content-typed sheet's body field — an
    /// aggregate's field, its `groupBy`, a `where` key, or (for an ad-hoc call)
    /// a key of the query `filter`. Aggregates read body-less, so such a
    /// reference would silently see nothing.
    pub fn check_body_field(&self, body: &str, filter: Option<&Filter>) -> Result<()> {
        if filter.is_some_and(|f| f.fields().any(|k| k == body)) {
            return Err(malformed(format!(
                "the filter references the body field {body:?}; aggregates read records body-less"
            )));
        }
        for spec in &self.specs {
            let hit = spec.form.field() == Some(body)
                || spec.group_by.as_deref() == Some(body)
                || spec.filter.as_ref().is_some_and(|f| f.fields().any(|k| k == body));
            if hit {
                return Err(malformed(format!(
                    "{:?} references the body field {body:?}; aggregates read records body-less",
                    spec.name
                )));
            }
        }
        Ok(())
    }

    /// Check that every `reduce` / `finalize` snippet compiles (in a scratch
    /// engine). A snippet that does not is [`Error::ConfigInvalid`].
    pub fn prepare(self) -> Result<Prepared> {
        let mut scratch: Option<Engine> = None;
        for spec in &self.specs {
            if let Form::Reduce { .. } = spec.form {
                let engine = match &mut scratch {
                    Some(e) => e,
                    None => scratch.insert(Engine::new_limited()?),
                };
                compile_reduce(spec, engine)?;
            }
        }
        Ok(Prepared { specs: self.specs })
    }
}

/// Compile a `reduce` spec's `(reduce, finalize)` into `engine`.
fn compile_reduce(
    spec: &AggregateSpec,
    engine: &mut Engine,
) -> Result<(SnippetHandle, Option<SnippetHandle>)> {
    let Form::Reduce { body, finalize, .. } = &spec.form else {
        unreachable!("compile_reduce on a reduce spec");
    };
    let reduce = engine
        .compile(&format!("(acc, record) => {{ {body}\n}}"))
        .map_err(|e| malformed(format!("{:?}: `reduce`: {}", spec.name, e.message())))?;
    let fin = match finalize {
        Some(f) => Some(
            engine
                .compile(&format!("(acc) => {{ {f}\n}}"))
                .map_err(|e| malformed(format!("{:?}: `finalize`: {}", spec.name, e.message())))?,
        ),
        None => None,
    };
    Ok((reduce, fin))
}

/// Parse, body-check, and compile in one step — the binding entry for an
/// ad-hoc call. Every failure is [`Error::ConfigInvalid`].
pub fn prepare(value: &Value, body_field: Option<&str>, filter: Option<&Filter>) -> Result<Prepared> {
    let aggs = Aggregates::from_value(value)?;
    if let Some(body) = body_field {
        aggs.check_body_field(body, filter)?;
    }
    aggs.prepare()
}

// ── the fold ──────────────────────────────────────────────────────────────────

/// The comparable kinds `min` / `max` / `distinct` require to be uniform.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Number,
    String,
    Datetime,
    Boolean,
}

impl Kind {
    fn of(v: &Value) -> Option<Kind> {
        match v {
            Value::Integer(_) | Value::Float(_) => Some(Kind::Number),
            Value::String(_) => Some(Kind::String),
            Value::Datetime(_) => Some(Kind::Datetime),
            Value::Boolean(_) => Some(Kind::Boolean),
            Value::Array(_) | Value::Table(_) => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Kind::Number => "number",
            Kind::String => "string",
            Kind::Datetime => "datetime",
            Kind::Boolean => "boolean",
        }
    }
}

/// Order two same-kind values: [`compare_values`] for numbers, strings, and
/// datetimes; `false` before `true` for booleans. `None` when incomparable
/// (NaN, a local time against a date).
fn compare_same_kind(a: &Value, b: &Value) -> Option<Ordering> {
    match (a, b) {
        (Value::Boolean(x), Value::Boolean(y)) => Some(x.cmp(y)),
        _ => compare_values(a, b),
    }
}

struct SumAcc {
    n: u64,
    int: i128,
    float: f64,
    all_int: bool,
}

impl SumAcc {
    fn new() -> SumAcc {
        SumAcc {
            n: 0,
            int: 0,
            float: 0.0,
            all_int: true,
        }
    }
    fn add(&mut self, v: &Value) {
        match v {
            Value::Integer(i) => {
                self.int += *i as i128;
                self.float += *i as f64;
            }
            Value::Float(f) => {
                self.all_int = false;
                self.float += *f;
            }
            _ => unreachable!("only numbers contribute to sum"),
        }
        self.n += 1;
    }
}

enum Acc {
    Count(i64),
    Sum(SumAcc),
    Extreme { kind: Kind, best: Value },
    Distinct { kind: Kind, values: Vec<Value> },
    /// A live engine accumulator in the group's own runtime-limited realm.
    Reduce {
        engine: Box<Engine>,
        reduce: SnippetHandle,
        finalize: Option<SnippetHandle>,
        acc: BoaValue,
    },
}

/// One aggregate's running state: a single accumulator, or one per group.
/// An accumulator is created on its first contributing record, so a group
/// exists only when something contributes to it.
enum Slot {
    Single(Option<Acc>),
    Grouped(BTreeMap<String, Acc>),
}

fn agg_error(sheet: &str, spec: &AggregateSpec, group: Option<&str>, cause: impl std::fmt::Display) -> Error {
    let at = match group {
        Some(g) => format!(" (group {g:?})"),
        None => String::new(),
    };
    Error::AggregationFailed {
        message: format!("aggregate {:?} on sheet {sheet:?}{at}: {cause}", spec.name),
        sheet: sheet.to_string(),
        aggregate: spec.name.clone(),
        partition: None,
    }
}

fn snippet_message(e: SnippetError) -> String {
    match e {
        SnippetError::UndefinedReference(m) | SnippetError::Other(m) => m,
    }
}

/// The string form of a `groupBy` value: strings as-is, integers in decimal,
/// booleans as `true`/`false`. Any other kind (or an absent field) does not
/// contribute.
fn group_key(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Integer(i) => Some(i.to_string()),
        Value::Boolean(b) => Some(b.to_string()),
        _ => None,
    }
}

/// The value a declarative form reads from `record`, when it contributes.
fn contributing<'r>(form: &Form, record: &'r IndexMap<String, Value>) -> Option<&'r Value> {
    let v = record.get(form.field()?)?;
    let ok = match form {
        Form::Sum(_) | Form::Avg(_) => matches!(v, Value::Integer(_) | Value::Float(_)),
        Form::Min(_) | Form::Max(_) => matches!(
            v,
            Value::Integer(_) | Value::Float(_) | Value::String(_) | Value::Datetime(_)
        ),
        Form::Distinct(_) => Kind::of(v).is_some(),
        Form::Count | Form::Reduce { .. } => unreachable!("no field"),
    };
    ok.then_some(v)
}

/// Fold one record into `acc` (created on first contribution by the caller).
#[allow(clippy::too_many_arguments)]
fn step(
    sheet: &str,
    spec: &AggregateSpec,
    group: Option<&str>,
    acc: Option<Acc>,
    value: Option<&Value>,
    record: &Value,
) -> Result<Acc> {
    Ok(match (&spec.form, acc) {
        (Form::Count, None) => Acc::Count(1),
        (Form::Count, Some(Acc::Count(n))) => Acc::Count(n + 1),
        (Form::Sum(_) | Form::Avg(_), acc) => {
            let mut s = match acc {
                Some(Acc::Sum(s)) => s,
                _ => SumAcc::new(),
            };
            s.add(value.expect("contributing value"));
            Acc::Sum(s)
        }
        (Form::Min(_) | Form::Max(_), acc) => {
            let v = value.expect("contributing value");
            let kind = Kind::of(v).expect("comparable kind");
            match acc {
                None => Acc::Extreme {
                    kind,
                    best: v.clone(),
                },
                Some(Acc::Extreme { kind: k, best }) => {
                    if k != kind {
                        return Err(agg_error(
                            sheet,
                            spec,
                            group,
                            format!("mixed value kinds ({} and {})", k.name(), kind.name()),
                        ));
                    }
                    let Some(ord) = compare_same_kind(v, &best) else {
                        return Err(agg_error(
                            sheet,
                            spec,
                            group,
                            format!("values cannot be compared ({v:?} vs {best:?})"),
                        ));
                    };
                    let replace = match spec.form {
                        Form::Min(_) => ord == Ordering::Less,
                        _ => ord == Ordering::Greater,
                    };
                    Acc::Extreme {
                        kind,
                        best: if replace { v.clone() } else { best },
                    }
                }
                Some(_) => unreachable!("accumulator kind matches its form"),
            }
        }
        (Form::Distinct(_), acc) => {
            let v = value.expect("contributing value");
            let kind = Kind::of(v).expect("scalar kind");
            let (k, mut values) = match acc {
                None => (kind, Vec::new()),
                Some(Acc::Distinct { kind, values }) => (kind, values),
                Some(_) => unreachable!("accumulator kind matches its form"),
            };
            if k != kind {
                return Err(agg_error(
                    sheet,
                    spec,
                    group,
                    format!("mixed value kinds ({} and {})", k.name(), kind.name()),
                ));
            }
            // Binary search over the sorted distinct set; an equal value is
            // already present (the first in path order wins).
            let (mut lo, mut hi) = (0usize, values.len());
            let mut present = false;
            while lo < hi {
                let mid = (lo + hi) / 2;
                match compare_same_kind(v, &values[mid]) {
                    Some(Ordering::Less) => hi = mid,
                    Some(Ordering::Greater) => lo = mid + 1,
                    Some(Ordering::Equal) => {
                        present = true;
                        break;
                    }
                    None => {
                        return Err(agg_error(
                            sheet,
                            spec,
                            group,
                            format!("values cannot be compared ({v:?} vs {:?})", values[mid]),
                        ))
                    }
                }
            }
            if !present {
                values.insert(lo, v.clone());
            }
            Acc::Distinct { kind, values }
        }
        (Form::Reduce { initial, .. }, acc) => {
            let (mut engine, reduce, finalize, acc_js) = match acc {
                Some(Acc::Reduce {
                    engine,
                    reduce,
                    finalize,
                    acc,
                }) => (engine, reduce, finalize, acc),
                None => {
                    // A fresh realm for this group's fold.
                    let mut engine = Box::new(
                        Engine::new_limited().map_err(|e| agg_error(sheet, spec, group, e.message()))?,
                    );
                    let (reduce, finalize) = compile_reduce(spec, &mut engine)
                        .map_err(|e| agg_error(sheet, spec, group, e.message()))?;
                    let acc = engine
                        .to_engine(initial)
                        .map_err(|e| agg_error(sheet, spec, group, e.message()))?;
                    (engine, reduce, finalize, acc)
                }
                Some(_) => unreachable!("accumulator kind matches its form"),
            };
            let record_js = engine
                .to_engine(record)
                .map_err(|e| agg_error(sheet, spec, group, e.message()))?;
            let next = engine
                .call_engine(reduce, &[acc_js, record_js])
                .map_err(|e| agg_error(sheet, spec, group, format!("reduce threw: {}", snippet_message(e))))?;
            Acc::Reduce {
                engine,
                reduce,
                finalize,
                acc: next,
            }
        }
        (Form::Count, Some(_)) => unreachable!("accumulator kind matches its form"),
    })
}

/// Close an accumulator into its result value.
fn finish(
    sheet: &str,
    spec: &AggregateSpec,
    group: Option<&str>,
    acc: Acc,
) -> Result<Value> {
    let overflow = || agg_error(sheet, spec, group, "integer sum overflows the signed 64-bit range");
    Ok(match acc {
        Acc::Count(n) => Value::Integer(n),
        Acc::Sum(s) => match spec.form {
            Form::Avg(_) => {
                let total = if s.all_int {
                    i64::try_from(s.int).map_err(|_| overflow())? as f64
                } else {
                    s.float
                };
                Value::Float(total / s.n as f64)
            }
            _ if s.all_int => Value::Integer(i64::try_from(s.int).map_err(|_| overflow())?),
            _ => Value::Float(s.float),
        },
        Acc::Extreme { best, .. } => best,
        Acc::Distinct { values, .. } => Value::Array(values),
        Acc::Reduce {
            mut engine,
            finalize,
            mut acc,
            ..
        } => {
            if let Some(fin) = finalize {
                acc = engine.call_engine(fin, &[acc]).map_err(|e| {
                    agg_error(sheet, spec, group, format!("finalize threw: {}", snippet_message(e)))
                })?;
            }
            engine.to_core_value(&acc).map_err(|why| {
                agg_error(sheet, spec, group, format!("result is not TOML-representable: {why}"))
            })?
        }
    })
}

/// Evaluate every prepared aggregate over `records`, which the caller yields
/// in canonical path order (spec: "Canonical computation"). Returns a table
/// with one entry per aggregate name; an ungrouped aggregate with no
/// contributing record is omitted, except `count` (`0`) and `sum` (`0`); a
/// grouped aggregate is always a table of its contributing groups.
pub fn fold<'a, I>(sheet: &str, records: I, prepared: &Prepared, engine: &mut Engine) -> Result<Value>
where
    I: IntoIterator<Item = &'a Value>,
{
    let mut slots: Vec<Slot> = prepared
        .specs
        .iter()
        .map(|s| {
            if s.group_by.is_some() {
                Slot::Grouped(BTreeMap::new())
            } else {
                Slot::Single(None)
            }
        })
        .collect();
    let empty = IndexMap::new();

    for record in records {
        let table = match record {
            Value::Table(t) => t,
            _ => &empty,
        };
        for (i, spec) in prepared.specs.iter().enumerate() {
            if let Some(w) = &spec.filter {
                if !query::matches(w, record, engine)? {
                    continue;
                }
            }
            let value = match spec.form {
                Form::Count | Form::Reduce { .. } => None,
                _ => match contributing(&spec.form, table) {
                    Some(v) => Some(v),
                    None => continue,
                },
            };
            match &mut slots[i] {
                Slot::Single(acc) => {
                    let next = step(sheet, spec, None, acc.take(), value, record)?;
                    *acc = Some(next);
                }
                Slot::Grouped(groups) => {
                    let g = spec.group_by.as_deref().expect("grouped spec");
                    let Some(key) = group_key(table.get(g)) else {
                        continue;
                    };
                    let prev = groups.remove(&key);
                    let next = step(sheet, spec, Some(&key), prev, value, record)?;
                    groups.insert(key, next);
                }
            }
        }
    }

    let mut out = IndexMap::new();
    for (spec, slot) in prepared.specs.iter().zip(slots) {
        match slot {
            Slot::Single(Some(acc)) => {
                out.insert(spec.name.clone(), finish(sheet, spec, None, acc)?);
            }
            Slot::Single(None) => match spec.form {
                Form::Count | Form::Sum(_) => {
                    out.insert(spec.name.clone(), Value::Integer(0));
                }
                _ => {}
            },
            Slot::Grouped(groups) => {
                let mut table = IndexMap::new();
                for (key, acc) in groups {
                    let v = finish(sheet, spec, Some(&key), acc)?;
                    table.insert(key, v);
                }
                out.insert(spec.name.clone(), Value::Table(table));
            }
        }
    }
    Ok(Value::Table(out))
}

/// Ad-hoc aggregation over a tree (spec: "Ad-hoc aggregation"): walk the
/// sheet under `base` exactly as a body-less query does — pruned by
/// `template`, the full `filter` applied in the core, records decoded through
/// `format` — and fold the matches in canonical path order. `only`, when
/// given, further restricts the contributing set to those record paths: a
/// binding whose filter carries host-side predicates admits records with them
/// first, and the core still folds over its own reads of exactly those
/// records. `engine` must be the one `template` was compiled into.
#[allow(clippy::too_many_arguments)]
pub fn aggregate_records(
    ctx: &Context<'_>,
    tree: &mut MutableTree,
    base: &str,
    template: &Template,
    filter: &Filter,
    engine: &mut Engine,
    extension: &str,
    format: &FormatConfig,
    sheet: &str,
    prepared: &Prepared,
    only: Option<&HashSet<String>>,
) -> Result<Value> {
    let rows = query::query_records_format(ctx, tree, base, template, filter, engine, extension, format, false)?;
    fold_rows(sheet, &rows, extension, only, prepared, engine)
}

/// Fold `(path, record)` rows — record paths relative to the sheet base, no
/// extension, in any order — optionally restricted to the `only` paths. The
/// rows are folded in **canonical path order**: the byte order of the full
/// path *with* `extension`, which is the order a recursive git tree walk
/// yields (`k-1.toml` before `k.toml`, though `k` sorts before `k-1`). That is
/// deliberately not the extensionless order `query` happens to return.
pub fn fold_rows(
    sheet: &str,
    rows: &[(String, Value)],
    extension: &str,
    only: Option<&HashSet<String>>,
    prepared: &Prepared,
    engine: &mut Engine,
) -> Result<Value> {
    let mut ordered: Vec<(String, &Value)> = rows
        .iter()
        .filter(|(path, _)| only.is_none_or(|set| set.contains(path)))
        .map(|(path, record)| (format!("{path}{extension}"), record))
        .collect();
    ordered.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    fold(sheet, ordered.into_iter().map(|(_, record)| record), prepared, engine)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::FormatKind;
    use crate::record::{resolve_tree, write_records, TOML_EXTENSION};

    fn s(v: &str) -> Value {
        Value::String(v.to_string())
    }
    fn i(v: i64) -> Value {
        Value::Integer(v)
    }
    fn f(v: f64) -> Value {
        Value::Float(v)
    }
    fn dt(v: &str) -> Value {
        Value::Datetime(v.parse().unwrap())
    }
    fn t(pairs: &[(&str, Value)]) -> Value {
        let mut m = IndexMap::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        Value::Table(m)
    }
    fn get<'v>(v: &'v Value, k: &str) -> Option<&'v Value> {
        match v {
            Value::Table(m) => m.get(k),
            _ => None,
        }
    }

    /// Prepare + fold `aggs` over `records` with a fresh engine.
    fn run(records: &[Value], aggs: Value) -> Result<Value> {
        let mut eng = Engine::new().unwrap();
        let prepared = prepare(&aggs, None, None)?;
        fold("tx", records.iter(), &prepared, &mut eng)
    }

    fn ledger() -> Vec<Value> {
        vec![
            t(&[("id", s("a")), ("status", s("posted")), ("cents", i(100)), ("at", dt("2026-01-02T00:00:00Z"))]),
            t(&[("id", s("b")), ("status", s("posted")), ("cents", i(250)), ("at", dt("2026-01-01T00:00:00Z"))]),
            t(&[("id", s("c")), ("status", s("pending")), ("cents", i(-50)), ("at", dt("2026-02-01T00:00:00Z"))]),
            t(&[("id", s("d")), ("status", s("void"))]),
        ]
    }

    #[test]
    fn count_counts_every_record_and_is_zero_when_empty() {
        let r = run(&ledger(), t(&[("n", t(&[("count", Value::Boolean(true))]))])).unwrap();
        assert_eq!(get(&r, "n"), Some(&i(4)));
        let r = run(&[], t(&[("n", t(&[("count", Value::Boolean(true))]))])).unwrap();
        assert_eq!(get(&r, "n"), Some(&i(0)));
    }

    #[test]
    fn sum_is_integer_when_every_value_is_and_float_otherwise() {
        let r = run(&ledger(), t(&[("total", t(&[("sum", s("cents"))]))])).unwrap();
        assert_eq!(get(&r, "total"), Some(&i(300)));

        let recs = vec![t(&[("x", i(1))]), t(&[("x", f(0.5))]), t(&[("x", s("7"))]), t(&[("x", i(2))])];
        let r = run(&recs, t(&[("total", t(&[("sum", s("x"))]))])).unwrap();
        assert_eq!(get(&r, "total"), Some(&f(3.5)));

        // Nothing contributes → 0 (integer), present.
        let r = run(&[t(&[("x", s("no"))])], t(&[("total", t(&[("sum", s("x"))]))])).unwrap();
        assert_eq!(get(&r, "total"), Some(&i(0)));
    }

    #[test]
    fn float_sum_is_the_path_order_fold() {
        // (0.1 + 0.2) + 0.3 != 0.1 + (0.2 + 0.3) in f64 — the order is the
        // contract.
        let recs = vec![t(&[("x", f(0.1))]), t(&[("x", f(0.2))]), t(&[("x", f(0.3))])];
        let r = run(&recs, t(&[("total", t(&[("sum", s("x"))]))])).unwrap();
        assert_eq!(get(&r, "total"), Some(&f(0.0 + 0.1 + 0.2 + 0.3)));
    }

    #[test]
    fn integer_sum_overflow_is_an_aggregation_error() {
        let recs = vec![t(&[("x", i(i64::MAX))]), t(&[("x", i(1))])];
        let err = run(&recs, t(&[("total", t(&[("sum", s("x"))]))])).unwrap_err();
        assert_eq!(err.aggregation(), Some(("tx", "total", None)));
        // …but a float anywhere makes it a float fold.
        let recs = vec![t(&[("x", i(i64::MAX))]), t(&[("x", f(1.0))])];
        let r = run(&recs, t(&[("total", t(&[("sum", s("x"))]))])).unwrap();
        assert!(matches!(get(&r, "total"), Some(Value::Float(_))));
    }

    #[test]
    fn avg_is_float_sum_over_count_and_omitted_when_empty() {
        let r = run(&ledger(), t(&[("mean", t(&[("avg", s("cents"))]))])).unwrap();
        assert_eq!(get(&r, "mean"), Some(&f(100.0)));
        let r = run(&[t(&[("id", s("x"))])], t(&[("mean", t(&[("avg", s("cents"))]))])).unwrap();
        assert_eq!(get(&r, "mean"), None);
    }

    #[test]
    fn min_and_max_by_kind_with_first_tie_and_omission() {
        let aggs = t(&[
            ("lo", t(&[("min", s("cents"))])),
            ("hi", t(&[("max", s("cents"))])),
            ("first", t(&[("min", s("at"))])),
            ("last", t(&[("max", s("at"))])),
            ("name", t(&[("max", s("id"))])),
            ("none", t(&[("min", s("missing"))])),
        ]);
        let r = run(&ledger(), aggs).unwrap();
        assert_eq!(get(&r, "lo"), Some(&i(-50)));
        assert_eq!(get(&r, "hi"), Some(&i(250)));
        assert_eq!(get(&r, "first"), Some(&dt("2026-01-01T00:00:00Z")));
        assert_eq!(get(&r, "last"), Some(&dt("2026-02-01T00:00:00Z")));
        assert_eq!(get(&r, "name"), Some(&s("d")));
        assert_eq!(get(&r, "none"), None);

        // Integers and floats are one kind; the first of equal extremes wins.
        let recs = vec![t(&[("x", f(2.0))]), t(&[("x", i(2))]), t(&[("x", i(3))])];
        let r = run(&recs, t(&[("lo", t(&[("min", s("x"))]))])).unwrap();
        assert_eq!(get(&r, "lo"), Some(&f(2.0)));

        // Booleans / tables don't contribute to min.
        let recs = vec![t(&[("x", Value::Boolean(true))]), t(&[("x", i(5))])];
        let r = run(&recs, t(&[("lo", t(&[("min", s("x"))]))])).unwrap();
        assert_eq!(get(&r, "lo"), Some(&i(5)));
    }

    #[test]
    fn mixed_kinds_under_min_max_distinct_are_aggregation_errors() {
        let recs = vec![t(&[("x", i(1))]), t(&[("x", s("one"))])];
        for form in ["min", "max", "distinct"] {
            let err = run(&recs, t(&[("agg", t(&[(form, s("x"))]))])).unwrap_err();
            assert_eq!(err.code(), "aggregation_failed", "{form}");
            assert_eq!(err.aggregation(), Some(("tx", "agg", None)));
            assert!(err.message().contains("mixed value kinds"), "{}", err.message());
        }
        // A local time can't be ordered against a datetime.
        let recs = vec![t(&[("x", dt("07:30:00"))]), t(&[("x", dt("2026-01-01T00:00:00Z"))])];
        let err = run(&recs, t(&[("agg", t(&[("max", s("x"))]))])).unwrap_err();
        assert_eq!(err.code(), "aggregation_failed");
    }

    #[test]
    fn distinct_sorts_by_kind_and_dedupes_equal_values() {
        let recs = vec![
            t(&[("x", i(3))]),
            t(&[("x", f(1.0))]),
            t(&[("x", i(1))]),
            t(&[("x", f(2.5))]),
            t(&[("x", i(3))]),
        ];
        let r = run(&recs, t(&[("d", t(&[("distinct", s("x"))]))])).unwrap();
        assert_eq!(get(&r, "d"), Some(&Value::Array(vec![f(1.0), f(2.5), i(3)])));

        let recs = vec![t(&[("x", s("b"))]), t(&[("x", s("B"))]), t(&[("x", s("a"))]), t(&[("x", s("b"))])];
        let r = run(&recs, t(&[("d", t(&[("distinct", s("x"))]))])).unwrap();
        assert_eq!(get(&r, "d"), Some(&Value::Array(vec![s("B"), s("a"), s("b")])));

        let recs = vec![
            t(&[("x", dt("2026-01-01T05:00:00+05:00"))]),
            t(&[("x", dt("2026-01-01T00:00:00Z"))]),
            t(&[("x", dt("2025-06-01"))]),
        ];
        let r = run(&recs, t(&[("d", t(&[("distinct", s("x"))]))])).unwrap();
        assert_eq!(
            get(&r, "d"),
            Some(&Value::Array(vec![dt("2025-06-01"), dt("2026-01-01T05:00:00+05:00")]))
        );

        let recs = vec![t(&[("x", Value::Boolean(true))]), t(&[("x", Value::Boolean(false))])];
        let r = run(&recs, t(&[("d", t(&[("distinct", s("x"))]))])).unwrap();
        assert_eq!(get(&r, "d"), Some(&Value::Array(vec![Value::Boolean(false), Value::Boolean(true)])));

        // Arrays/tables are not scalars → don't contribute; nothing → omitted.
        let r = run(&[t(&[("x", Value::Array(vec![]))])], t(&[("d", t(&[("distinct", s("x"))]))])).unwrap();
        assert_eq!(get(&r, "d"), None);
    }

    #[test]
    fn where_and_group_by_compose() {
        let aggs = t(&[
            ("byStatus", t(&[("count", Value::Boolean(true)), ("groupBy", s("status"))])),
            (
                "postedCents",
                t(&[("sum", s("cents")), ("where", t(&[("status", s("posted"))]))]),
            ),
            (
                "bigByStatus",
                t(&[
                    ("sum", s("cents")),
                    ("groupBy", s("status")),
                    ("where", t(&[("cents", t(&[("$gte", i(0))]))])),
                ]),
            ),
            ("nothing", t(&[("max", s("cents")), ("groupBy", s("nope"))])),
        ]);
        let r = run(&ledger(), aggs).unwrap();
        assert_eq!(
            get(&r, "byStatus"),
            Some(&t(&[("pending", i(1)), ("posted", i(2)), ("void", i(1))]))
        );
        assert_eq!(get(&r, "postedCents"), Some(&i(350)));
        // `void` has no cents and `pending` fails the where → neither appears.
        assert_eq!(get(&r, "bigByStatus"), Some(&t(&[("posted", i(350))])));
        // No group key anywhere → an empty table, still present.
        assert_eq!(get(&r, "nothing"), Some(&t(&[])));
    }

    #[test]
    fn group_keys_are_string_forms_of_strings_integers_and_booleans() {
        let recs = vec![
            t(&[("g", i(1))]),
            t(&[("g", s("1"))]),
            t(&[("g", Value::Boolean(false))]),
            t(&[("g", f(1.5))]),
            t(&[("g", dt("2026-01-01"))]),
            t(&[]),
        ];
        let r = run(&recs, t(&[("n", t(&[("count", Value::Boolean(true)), ("groupBy", s("g"))]))])).unwrap();
        assert_eq!(get(&r, "n"), Some(&t(&[("1", i(2)), ("false", i(1))])));
    }

    #[test]
    fn reduce_folds_in_path_order_with_finalize() {
        let aggs = t(&[
            (
                "ids",
                t(&[
                    ("reduce", s("return acc + record.id;")),
                    ("initial", s("")),
                ]),
            ),
            (
                "stats",
                t(&[
                    ("reduce", s("acc.n += 1; if (record.cents !== undefined) acc.total += record.cents; return acc;")),
                    ("initial", t(&[("n", i(0)), ("total", i(0))])),
                    ("finalize", s("return { n: acc.n, mean: acc.total / acc.n, when: new Date(0) };")),
                ]),
            ),
            (
                "perStatus",
                t(&[
                    ("reduce", s("acc.push(record.id); return acc;")),
                    ("initial", Value::Array(vec![])),
                    ("groupBy", s("status")),
                ]),
            ),
        ]);
        let r = run(&ledger(), aggs).unwrap();
        assert_eq!(get(&r, "ids"), Some(&s("abcd")));
        assert_eq!(
            get(&r, "stats"),
            Some(&t(&[("n", i(4)), ("mean", i(75)), ("when", dt("1970-01-01T00:00:00Z"))]))
        );
        // Each group starts from its own copy of `initial`.
        assert_eq!(
            get(&r, "perStatus"),
            Some(&t(&[
                ("pending", Value::Array(vec![s("c")])),
                ("posted", Value::Array(vec![s("a"), s("b")])),
                ("void", Value::Array(vec![s("d")])),
            ]))
        );

        // No records → omitted (finalize never runs).
        let r = run(
            &[],
            t(&[("x", t(&[("reduce", s("return acc;")), ("initial", i(0)), ("finalize", s("return 1;"))]))]),
        )
        .unwrap();
        assert_eq!(get(&r, "x"), None);
    }

    #[test]
    fn reduce_marshals_numbers_like_the_binding_boundary() {
        let r = run(
            &[t(&[])],
            t(&[
                ("int", t(&[("reduce", s("return 0.5 + 0.5;")), ("initial", i(0))])),
                ("float", t(&[("reduce", s("return 2.5;")), ("initial", i(0))])),
                ("dropped", t(&[("reduce", s("return { a: 1, b: null, c: undefined };")), ("initial", i(0))])),
            ]),
        )
        .unwrap();
        assert_eq!(get(&r, "int"), Some(&i(1)));
        assert_eq!(get(&r, "float"), Some(&f(2.5)));
        assert_eq!(get(&r, "dropped"), Some(&t(&[("a", i(1))])));
    }

    #[test]
    fn reduce_throw_or_non_toml_result_is_an_aggregation_error() {
        for (body, fin, needle) in [
            ("throw new Error('boom');", None, "reduce threw"),
            ("return acc;", Some("throw new Error('late');"), "finalize threw"),
            ("return undefined;", None, "not TOML-representable"),
            ("return null;", None, "not TOML-representable"),
            ("return () => 1;", None, "not TOML-representable"),
            ("return [1, null];", None, "not TOML-representable"),
            ("return new Map();", None, "not TOML-representable"),
            ("const o = {}; o.self = o; return o;", None, "not TOML-representable"),
        ] {
            let mut spec = vec![("reduce", s(body)), ("initial", i(0))];
            if let Some(fin) = fin {
                spec.push(("finalize", s(fin)));
            }
            let err = run(&[t(&[])], t(&[("bad", t(&spec))])).unwrap_err();
            assert_eq!(err.code(), "aggregation_failed", "{body}");
            assert_eq!(err.aggregation(), Some(("tx", "bad", None)));
            assert!(err.message().contains(needle), "{body}: {}", err.message());
        }
    }

    #[test]
    fn malformed_specs_are_config_invalid() {
        let bad = [
            s("nope"),
            t(&[("x", s("count"))]),
            t(&[("x", t(&[]))]),
            t(&[("x", t(&[("count", Value::Boolean(false))]))]),
            t(&[("x", t(&[("count", Value::Boolean(true)), ("sum", s("a"))]))]),
            t(&[("x", t(&[("sum", i(1))]))]),
            t(&[("x", t(&[("sum", s(""))]))]),
            t(&[("x", t(&[("sum", s("a")), ("initial", i(0))]))]),
            t(&[("x", t(&[("sum", s("a")), ("bogus", i(0))]))]),
            t(&[("x", t(&[("reduce", s("return acc;"))]))]),
            t(&[("x", t(&[("reduce", i(1)), ("initial", i(0))]))]),
            t(&[("x", t(&[("reduce", s("return acc;")), ("initial", i(0)), ("finalize", i(1))]))]),
            t(&[("x", t(&[("reduce", s("return acc +;")), ("initial", i(0))]))]),
            t(&[("x", t(&[("count", Value::Boolean(true)), ("where", s("a"))]))]),
            t(&[("x", t(&[("count", Value::Boolean(true)), ("where", t(&[("a", t(&[("$in", i(1))]))]))]))]),
            t(&[("x", t(&[("count", Value::Boolean(true)), ("where", t(&[("a", t(&[("$pred", s("true"))]))]))]))]),
            t(&[("x", t(&[("count", Value::Boolean(true)), ("groupBy", i(1))]))]),
        ];
        for aggs in bad {
            let err = run(&[], aggs.clone()).unwrap_err();
            assert_eq!(err.code(), "config_invalid", "{aggs:?}");
        }
        // An empty aggregates table is fine: an empty result.
        assert_eq!(run(&[], t(&[])).unwrap(), t(&[]));
    }

    #[test]
    fn body_field_references_are_rejected() {
        for aggs in [
            t(&[("x", t(&[("distinct", s("body"))]))]),
            t(&[("x", t(&[("count", Value::Boolean(true)), ("groupBy", s("body"))]))]),
            t(&[("x", t(&[("count", Value::Boolean(true)), ("where", t(&[("body", s("hi"))]))]))]),
        ] {
            let err = prepare(&aggs, Some("body"), None).unwrap_err();
            assert_eq!(err.code(), "config_invalid");
        }
        let ok = t(&[("x", t(&[("count", Value::Boolean(true))]))]);
        let mut filter = Filter::new();
        filter.push("body", crate::query::FilterPred::Equals(s("x")));
        assert!(prepare(&ok, Some("body"), Some(&filter)).is_err());
        assert!(prepare(&ok, Some("body"), None).is_ok());
    }

    #[test]
    fn avg_integer_overflow_is_an_aggregation_error() {
        let recs = vec![t(&[("x", i(i64::MAX))]), t(&[("x", i(1))])];
        let err = run(&recs, t(&[("m", t(&[("avg", s("x"))]))])).unwrap_err();
        assert_eq!(err.aggregation(), Some(("tx", "m", None)));
    }

    #[test]
    fn group_keys_of_different_kinds_merge_by_string_form() {
        let recs = vec![
            t(&[("g", i(1)), ("x", i(10))]),
            t(&[("g", s("1")), ("x", i(5))]),
            t(&[("g", Value::Boolean(true)), ("x", i(1))]),
            t(&[("g", s("true")), ("x", i(2))]),
        ];
        let r = run(&recs, t(&[("t", t(&[("sum", s("x")), ("groupBy", s("g"))]))])).unwrap();
        assert_eq!(get(&r, "t"), Some(&t(&[("1", i(15)), ("true", i(3))])));
    }

    #[test]
    fn distinct_keeps_a_large_integer_apart_from_a_nearby_float() {
        let two53 = 1i64 << 53;
        let recs = vec![t(&[("x", f(two53 as f64))]), t(&[("x", i(two53 + 1))]), t(&[("x", i(two53))])];
        let r = run(&recs, t(&[("d", t(&[("distinct", s("x"))]))])).unwrap();
        // 2^53 (float) and 2^53 (int) are equal; 2^53 + 1 is its own value.
        assert_eq!(get(&r, "d"), Some(&Value::Array(vec![f(two53 as f64), i(two53 + 1)])));
    }

    #[test]
    fn a_reduce_date_outside_toml_years_is_an_aggregation_error() {
        let err = run(
            &[t(&[])],
            t(&[("d", t(&[("reduce", s("return new Date(Date.UTC(70000, 0, 1));")), ("initial", i(0))]))]),
        )
        .unwrap_err();
        assert_eq!(err.code(), "aggregation_failed");
        assert!(err.message().contains("0–9999"), "{}", err.message());
        let err = run(
            &[t(&[])],
            t(&[("d", t(&[("reduce", s("return new Date(Date.UTC(-1, 0, 1));")), ("initial", i(0))]))]),
        )
        .unwrap_err();
        assert_eq!(err.code(), "aggregation_failed");
        // In range still converts.
        let r = run(
            &[t(&[])],
            t(&[("d", t(&[("reduce", s("return new Date(Date.UTC(9999, 11, 31));")), ("initial", i(0))]))]),
        )
        .unwrap();
        assert_eq!(get(&r, "d"), Some(&dt("9999-12-31T00:00:00Z")));
    }

    #[test]
    fn runaway_snippets_hit_the_runtime_limits() {
        for body in [
            "while (true) {}",
            "for (;;) { acc++; }",
            "const f = (n) => f(n + 1); return f(0);",
        ] {
            let err = run(&[t(&[])], t(&[("x", t(&[("reduce", s(body)), ("initial", i(0))]))])).unwrap_err();
            assert_eq!(err.code(), "aggregation_failed", "{body}");
            assert!(err.message().contains("reduce threw"), "{body}: {}", err.message());
        }
        // A bounded loop under the limit is fine.
        let r = run(
            &[t(&[])],
            t(&[("x", t(&[("reduce", s("let n = 0; for (let k = 0; k < 1000; k++) n += k; return n;")), ("initial", i(0))]))]),
        )
        .unwrap();
        assert_eq!(get(&r, "x"), Some(&i(499_500)));
    }

    #[test]
    fn global_state_does_not_leak_between_groups_aggregates_or_calls() {
        let body = "globalThis.seen = (globalThis.seen || 0) + 1; return globalThis.seen;";
        let recs = vec![t(&[("g", s("a"))]), t(&[("g", s("a"))]), t(&[("g", s("b"))])];
        let aggs = t(&[
            ("grouped", t(&[("reduce", s(body)), ("initial", i(0)), ("groupBy", s("g"))])),
            ("whole", t(&[("reduce", s(body)), ("initial", i(0))])),
        ]);
        let r = run(&recs, aggs.clone()).unwrap();
        assert_eq!(get(&r, "grouped"), Some(&t(&[("a", i(2)), ("b", i(1))])));
        assert_eq!(get(&r, "whole"), Some(&i(3)));
        // A second call starts clean too.
        assert_eq!(run(&recs, aggs).unwrap(), r);
    }

    #[test]
    fn shared_reference_results_are_bounded() {
        // 40 levels of [x, x] is shallow (depth 40) but expands to 2^40 nodes.
        let body = "let x = [1]; for (let k = 0; k < 40; k++) x = [x, x]; return x;";
        let err = run(&[t(&[])], t(&[("x", t(&[("reduce", s(body)), ("initial", i(0))]))])).unwrap_err();
        assert_eq!(err.code(), "aggregation_failed");
        assert!(err.message().contains("more than"), "{}", err.message());
    }

    // ── end to end over a tree ───────────────────────────────────────────────

    fn tctx(repo: &gix::Repository) -> Context<'_> {
        Context::new(repo, Box::leak(Box::new(holo_tree::TreeCache::new())))
    }

    #[test]
    fn aggregate_records_prunes_filters_and_folds_in_path_order() {
        let dir = tempfile::tempdir().unwrap();
        let repo = gix::init(dir.path()).unwrap();
        let ctx = tctx(&repo);
        let mut tree = MutableTree::empty();
        let items: Vec<(String, Value)> = [
            ("2026/01/b", "2026-01-20T00:00:00Z", "posted", 0.2),
            ("2026/01/a", "2026-01-05T00:00:00Z", "posted", 0.1),
            ("2026/02/c", "2026-02-10T00:00:00Z", "pending", 0.3),
            ("2025/12/z", "2025-12-31T00:00:00Z", "posted", 100.0),
        ]
        .iter()
        .map(|(p, at, st, amt)| {
            let slug = p.rsplit('/').next().unwrap();
            (
                (*p).to_string(),
                t(&[("at", dt(at)), ("slug", s(slug)), ("status", s(st)), ("amt", f(*amt))]),
            )
        })
        .collect();
        let hash = write_records(&ctx, &mut tree, "tx", &items, TOML_EXTENSION).unwrap().tree_hash;
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ at: YYYY/MM }}/${{ slug }}", &mut eng).unwrap();
        let format = FormatConfig {
            kind: FormatKind::Toml,
            body: None,
            title: None,
            normalize: true,
        };
        let mut filter = Filter::new();
        filter.push(
            "at",
            crate::query::FilterPred::Range(
                crate::query::Range::from_table(match &t(&[("$gte", s("2026-01-01"))]) {
                    Value::Table(m) => m,
                    _ => unreachable!(),
                })
                .unwrap(),
            ),
        );
        let aggs = t(&[
            ("n", t(&[("count", Value::Boolean(true))])),
            ("total", t(&[("sum", s("amt"))])),
            ("order", t(&[("reduce", s("return acc + record.slug;")), ("initial", s(""))])),
            ("byStatus", t(&[("count", Value::Boolean(true)), ("groupBy", s("status"))])),
        ]);
        let prepared = prepare(&aggs, None, Some(&filter)).unwrap();
        let r = aggregate_records(
            &ctx, &mut tree, "tx", &template, &filter, &mut eng, TOML_EXTENSION, &format, "tx", &prepared, None,
        )
        .unwrap();
        assert_eq!(get(&r, "n"), Some(&i(3)));
        assert_eq!(get(&r, "total"), Some(&f(0.0 + 0.1 + 0.2 + 0.3)));
        // Canonical path order: 2026/01/a, 2026/01/b, 2026/02/c.
        assert_eq!(get(&r, "order"), Some(&s("abc")));
        assert_eq!(get(&r, "byStatus"), Some(&t(&[("pending", i(1)), ("posted", i(2))])));

        // `only` restricts the contributing set to admitted paths.
        let only: HashSet<String> = ["2026/01/b".to_string(), "2026/02/c".to_string()].into();
        let r = aggregate_records(
            &ctx, &mut tree, "tx", &template, &filter, &mut eng, TOML_EXTENSION, &format, "tx", &prepared, Some(&only),
        )
        .unwrap();
        assert_eq!(get(&r, "order"), Some(&s("bc")));
    }

    #[test]
    fn folds_in_tree_walk_order_not_extensionless_order() {
        // ids a, a-b, a.b → files a.toml, a-b.toml, a.b.toml. Extensionless
        // order is a < a-b < a.b; the tree walk (full path with extension) is
        // a-b.toml < a.b.toml < a.toml.
        let dir = tempfile::tempdir().unwrap();
        let repo = gix::init(dir.path()).unwrap();
        let ctx = tctx(&repo);
        let mut tree = MutableTree::empty();
        let items: Vec<(String, Value)> = [("a", 0.1), ("a-b", 0.2), ("a.b", 0.3)]
            .iter()
            .map(|(id, x)| ((*id).to_string(), t(&[("id", s(id)), ("x", f(*x))])))
            .collect();
        let hash = write_records(&ctx, &mut tree, "s", &items, TOML_EXTENSION).unwrap().tree_hash;

        // The order git itself walks the tree.
        let out = std::process::Command::new("git")
            .arg("--git-dir")
            .arg(repo.git_dir())
            .args(["ls-tree", "-r", "--name-only", &hash])
            .output()
            .unwrap();
        let walked: Vec<String> = String::from_utf8(out.stdout).unwrap().lines().map(str::to_string).collect();
        assert_eq!(walked, vec!["s/a-b.toml", "s/a.b.toml", "s/a.toml"]);

        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ id }}", &mut eng).unwrap();
        let format = FormatConfig {
            kind: FormatKind::Toml,
            body: None,
            title: None,
            normalize: true,
        };
        let aggs = t(&[
            ("total", t(&[("sum", s("x"))])),
            ("order", t(&[("reduce", s("acc.push(record.id); return acc;")), ("initial", Value::Array(vec![]))])),
        ]);
        let prepared = prepare(&aggs, None, None).unwrap();
        let r = aggregate_records(
            &ctx, &mut tree, "s", &template, &Filter::new(), &mut eng, TOML_EXTENSION, &format, "s", &prepared, None,
        )
        .unwrap();
        assert_eq!(get(&r, "order"), Some(&Value::Array(vec![s("a-b"), s("a.b"), s("a")])));
        let tree_order = 0.0 + 0.2 + 0.3 + 0.1;
        let extless_order = 0.0 + 0.1 + 0.2 + 0.3;
        assert_ne!(tree_order, extless_order, "the fixture must discriminate the two orders");
        assert_eq!(get(&r, "total"), Some(&f(tree_order)));

        // fold_rows sorts whatever order it is handed.
        let mut rows = items.clone();
        rows.reverse();
        let r2 = fold_rows("s", &rows, TOML_EXTENSION, None, &prepared, &mut eng).unwrap();
        assert_eq!(r2, r);
    }

    #[test]
    fn aggregate_records_reads_markdown_body_less() {
        let dir = tempfile::tempdir().unwrap();
        let repo = gix::init(dir.path()).unwrap();
        let ctx = tctx(&repo);
        let fmt = FormatConfig {
            kind: FormatKind::Markdown,
            body: Some("body".into()),
            title: None,
            normalize: true,
        };
        let mut tree = MutableTree::empty();
        for (slug, words) in [("one", 3), ("two", 5)] {
            let record = t(&[("slug", s(slug)), ("words", i(words)), ("body", s("# Hi\n"))]);
            let text = crate::codec::serialize(&record, &fmt).unwrap();
            tree.write_child_bytes(&ctx, &format!("posts/{slug}.md"), text.as_bytes()).unwrap();
        }
        let hash = tree.write(&ctx).unwrap().to_string();
        let mut tree = resolve_tree(&repo, &hash).unwrap();
        let mut eng = Engine::new().unwrap();
        let template = Template::compile("${{ slug }}", &mut eng).unwrap();
        let aggs = t(&[
            ("words", t(&[("sum", s("words"))])),
            ("hasBody", t(&[("reduce", s("return acc || record.body !== undefined;")), ("initial", Value::Boolean(false))])),
        ]);
        let prepared = prepare(&aggs, Some("body"), None).unwrap();
        let r = aggregate_records(
            &ctx, &mut tree, "posts", &template, &Filter::new(), &mut eng, ".md", &fmt, "posts", &prepared, None,
        )
        .unwrap();
        assert_eq!(get(&r, "words"), Some(&i(8)));
        assert_eq!(get(&r, "hasBody"), Some(&Value::Boolean(false)));
    }
}
