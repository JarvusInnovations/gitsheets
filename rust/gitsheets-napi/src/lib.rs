//! `gitsheets-napi` — the Node.js binding for [`gitsheets-core`].
//!
//! This crate owns exactly one thing: **marshalling** between JS host values
//! and the core's TOML-faithful [`Value`](gitsheets_core::Value), with the
//! type-fidelity rules locked in [`specs/rust-core.md`](../../../specs/rust-core.md)
//! ("Type-fidelity rules"):
//!
//! - **Integers** — the core stores `i64`; the binding marshals OUT to a JS
//!   `number` when the value fits in ±(2^53−1) and to `BigInt` above that, and
//!   accepts BOTH `number` and `bigint` IN.
//! - **Floats** — `f64`, kept distinct from integers (`1` and `1.0` differ).
//! - **Datetimes** — all four TOML kinds live in the core; the binding surfaces
//!   them as JS `Date` (matching `@iarna` v1.x), with the precise kind retained
//!   core-side. A `Date` round-trips to a `Date`.
//! - **Tables ↔ plain objects, arrays ↔ arrays, strings/bools** — obvious.
//!
//! Errors cross as **structured, matchable** JS errors (a `code`/`status`/class
//! discriminant, plus `issues`/`conflictingPaths` payloads), never an opaque
//! string — directly answering `notes/holo-tree-findings.md` §4. The typed
//! `GitsheetsError` subclasses themselves are constructed in the thin JS wrapper
//! (`binding.cjs`), which maps each structured error onto its class.
//!
//! Every entry point is **batch-first**: it takes/returns a `Vec`, so bulk
//! paths never bake in per-record FFI crossings.

use chrono::{Datelike, Timelike};
use gitsheets_core::diff::{MergePatch, PatchOp, PatchValue};
use gitsheets_core::engine::Engine;
use gitsheets_core::index::{MultiIndex, UniqueIndex};
use gitsheets_core::path_template::Template;
use gitsheets_core::query::{self, Filter, FilterPred};
use gitsheets_core::validation::CompiledSchema;
use gitsheets_core::{record, Datetime, Value};
use napi::bindgen_prelude::*;
use napi::{Env, JsDate, JsFunction, JsObject, JsString, JsUnknown, NapiRaw, ValueType};
use napi_derive::napi;
use toml::value::{Date as TomlDate, Datetime as TomlDatetime, Offset, Time as TomlTime};

/// JS can't exceed this exactly; integers within ±(2^53−1) stay ergonomic
/// `number`s, larger ones become `BigInt`.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

// ── the value newtype + its marshalling ──────────────────────────────────────

/// Newtype wrapper so we can implement napi's conversion traits on the core
/// [`Value`] (orphan rule). This is the entire FFI boundary for records.
pub struct JsValue(pub Value);

impl TypeName for JsValue {
    fn type_name() -> &'static str {
        "any"
    }
    fn value_type() -> ValueType {
        ValueType::Unknown
    }
}

impl ValidateNapiValue for JsValue {
    // Any JS value is a candidate; concrete validation happens in `from_napi_value`.
    unsafe fn validate(
        _env: napi::sys::napi_env,
        _napi_val: napi::sys::napi_value,
    ) -> Result<napi::sys::napi_value> {
        Ok(std::ptr::null_mut())
    }
}

impl FromNapiValue for JsValue {
    unsafe fn from_napi_value(
        env: napi::sys::napi_env,
        napi_val: napi::sys::napi_value,
    ) -> Result<Self> {
        let unknown = JsUnknown::from_napi_value(env, napi_val)?;
        let value = match unknown.get_type()? {
            ValueType::Boolean => Value::Boolean(bool::from_napi_value(env, napi_val)?),
            ValueType::Number => {
                let n = f64::from_napi_value(env, napi_val)?;
                // JS has a single `number`; treat an exact integral within the
                // safe range as a core integer, everything else as a float.
                if n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER as f64 {
                    Value::Integer(n as i64)
                } else {
                    Value::Float(n)
                }
            }
            ValueType::BigInt => {
                let big = BigInt::from_napi_value(env, napi_val)?;
                let (v, lossless) = big.get_i64();
                if !lossless {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "integer is outside the i64 range TOML permits",
                    ));
                }
                Value::Integer(v)
            }
            ValueType::String => Value::String(String::from_napi_value(env, napi_val)?),
            ValueType::Object => {
                if unknown.is_array()? {
                    let items = Vec::<JsValue>::from_napi_value(env, napi_val)?;
                    Value::Array(items.into_iter().map(|j| j.0).collect())
                } else if unknown.is_date()? {
                    let date = JsDate::from_napi_value(env, napi_val)?;
                    let ms = date.value_of()?;
                    Value::Datetime(unix_millis_to_datetime(ms)?)
                } else {
                    let obj = JsObject::from_napi_value(env, napi_val)?;
                    let names = obj.get_property_names()?;
                    let len = names.get_array_length()?;
                    let mut map = indexmap::IndexMap::new();
                    for i in 0..len {
                        let key_js: JsString = names.get_element(i)?;
                        let key = key_js.into_utf8()?.as_str()?.to_owned();
                        let child: JsUnknown = obj.get_named_property(&key)?;
                        let child = JsValue::from_napi_value(env, child.raw())?;
                        map.insert(key, child.0);
                    }
                    Value::Table(map)
                }
            }
            other => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("cannot marshal JS value of type {other:?} to a TOML value (null/undefined have no TOML representation)"),
                ));
            }
        };
        Ok(JsValue(value))
    }
}

impl ToNapiValue for JsValue {
    unsafe fn to_napi_value(env: napi::sys::napi_env, val: Self) -> Result<napi::sys::napi_value> {
        match val.0 {
            Value::String(s) => String::to_napi_value(env, s),
            Value::Boolean(b) => bool::to_napi_value(env, b),
            Value::Float(f) => f64::to_napi_value(env, f),
            Value::Integer(i) => {
                // Adaptive: ergonomic `number` within the safe range, exact
                // `BigInt` beyond it.
                if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&i) {
                    f64::to_napi_value(env, i as f64)
                } else {
                    BigInt::to_napi_value(env, BigInt::from(i))
                }
            }
            Value::Datetime(dt) => {
                let ms = datetime_to_unix_millis(&dt)?;
                let env_wrap = Env::from_raw(env);
                let date = env_wrap.create_date(ms as f64)?;
                JsDate::to_napi_value(env, date)
            }
            Value::Array(items) => {
                let wrapped: Vec<JsValue> = items.into_iter().map(JsValue).collect();
                Vec::<JsValue>::to_napi_value(env, wrapped)
            }
            Value::Table(map) => {
                let env_wrap = Env::from_raw(env);
                let mut obj = env_wrap.create_object()?;
                for (k, v) in map {
                    let child_raw = JsValue::to_napi_value(env, JsValue(v))?;
                    let child = JsUnknown::from_napi_value(env, child_raw)?;
                    obj.set_named_property(&k, child)?;
                }
                JsObject::to_napi_value(env, obj)
            }
        }
    }
}

// ── datetime <-> JS Date bridge (a host-surface concern, hence in the binding) ─

/// Build an offset-datetime (UTC `Z`) core datetime from JS-`Date` epoch
/// milliseconds. A JS `Date` is an absolute instant, which is exactly an
/// offset-datetime at UTC — matching `@iarna`'s treatment of JS Dates.
fn unix_millis_to_datetime(ms: f64) -> Result<Datetime> {
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms as i64)
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("date {ms} ms is out of range")))?;
    let toml_dt = TomlDatetime {
        date: Some(TomlDate {
            year: dt.year() as u16,
            month: dt.month() as u8,
            day: dt.day() as u8,
        }),
        time: Some(TomlTime {
            hour: dt.hour() as u8,
            minute: dt.minute() as u8,
            second: dt.second() as u8,
            nanosecond: dt.nanosecond(),
        }),
        offset: Some(Offset::Z),
    };
    Ok(Datetime(toml_dt))
}

/// Compute the JS-`Date` epoch milliseconds for any of the four datetime kinds.
/// Local kinds (no offset) are interpreted as UTC for the `Date` surface — the
/// least-lossy idiomatic projection; the core retains the precise kind for
/// byte-faithful re-serialization.
fn datetime_to_unix_millis(dt: &Datetime) -> Result<i64> {
    let TomlDatetime { date, time, offset } = dt.0;
    let date = date.unwrap_or(TomlDate {
        year: 1970,
        month: 1,
        day: 1,
    });
    let time = time.unwrap_or(TomlTime {
        hour: 0,
        minute: 0,
        second: 0,
        nanosecond: 0,
    });
    let naive_date =
        chrono::NaiveDate::from_ymd_opt(date.year as i32, date.month as u32, date.day as u32)
            .ok_or_else(|| Error::new(Status::InvalidArg, "datetime has an invalid date"))?;
    let naive_time = chrono::NaiveTime::from_hms_nano_opt(
        time.hour as u32,
        time.minute as u32,
        time.second as u32,
        time.nanosecond,
    )
    .ok_or_else(|| Error::new(Status::InvalidArg, "datetime has an invalid time"))?;
    let naive = chrono::NaiveDateTime::new(naive_date, naive_time);
    let offset_minutes: i64 = match offset {
        Some(Offset::Z) => 0,
        Some(Offset::Custom { minutes }) => minutes as i64,
        None => 0,
    };
    // Components are wall-clock at `offset`; the instant is components − offset.
    Ok(naive.and_utc().timestamp_millis() - offset_minutes * 60_000)
}

// ── public entry points ──────────────────────────────────────────────────────

/// Round-trip a **batch** of records through the core, preserving full type
/// fidelity. The whole array crosses the FFI once. This is the foundation's
/// stand-in for the real batch engine entry points (`upsertMany`, `queryAll`,
/// …), which keep this same batch-first signature.
#[napi]
pub fn roundtrip(records: Vec<JsValue>) -> Vec<JsValue> {
    let core: Vec<Value> = records.into_iter().map(|j| j.0).collect();
    gitsheets_core::echo_batch(core)
        .into_iter()
        .map(JsValue)
        .collect()
}

/// Parse a **batch** of TOML documents into records, marshalled to JS with full
/// type fidelity. The whole array crosses the FFI once (batch-first). A
/// malformed document surfaces as a structured, typed core error (`config_invalid`).
#[napi]
pub fn parse_records(env: Env, documents: Vec<String>) -> Result<Vec<JsValue>> {
    match gitsheets_core::parse_batch(documents) {
        Ok(values) => Ok(values.into_iter().map(JsValue).collect()),
        Err(err) => Err(raise_core_error(&env, &err)),
    }
}

/// Serialize a **batch** of records to their canonical TOML bytes in one call
/// (deep key sort + `toml`-crate default formatting; see `gitsheets_core::canonical`).
/// A value TOML can't represent surfaces as a structured, typed core error.
#[napi]
pub fn serialize_records(env: Env, records: Vec<JsValue>) -> Result<Vec<String>> {
    let values: Vec<Value> = records.into_iter().map(|j| j.0).collect();
    match gitsheets_core::serialize_batch(&values) {
        Ok(bytes) => Ok(bytes),
        Err(err) => Err(raise_core_error(&env, &err)),
    }
}

// ── definition logic: path templates, validation, embedded engine ────────────

/// One JSON-Schema validation failure, marshalled to the `ValidationIssue`
/// shape the host surface uses (`source`/`schemaPath`/`code`, with snake fields
/// rendered camelCase by napi). Returned by [`validate_batch`].
#[napi(object)]
pub struct JsValidationIssue {
    pub path: Vec<String>,
    pub message: String,
    pub source: String,
    pub schema_path: Option<String>,
    pub code: Option<String>,
}

/// Render a path template against a **batch** of records, returning one path per
/// record (no file extension; the caller appends `.toml`/`.md`). The template is
/// parsed and its expression components compiled into the embedded engine
/// **once**, then reused across the whole batch — the bulk path crosses the FFI
/// a single time. A render failure surfaces as a structured, typed
/// `PathTemplateError` (`path_render_failed` / `path_invalid_chars`). This is the
/// path-template half of the `node:vm` parity gate.
#[napi]
pub fn render_paths_batch(env: Env, template: String, records: Vec<JsValue>) -> Result<Vec<String>> {
    let mut engine = match Engine::new() {
        Ok(e) => e,
        Err(err) => return Err(raise_core_error(&env, &err)),
    };
    let compiled = match Template::compile(&template, &mut engine) {
        Ok(t) => t,
        Err(err) => return Err(raise_core_error(&env, &err)),
    };
    let mut out = Vec::with_capacity(records.len());
    for record in records {
        match compiled.render(&record.0, &mut engine) {
            Ok(path) => out.push(path),
            Err(err) => return Err(raise_core_error(&env, &err)),
        }
    }
    Ok(out)
}

/// Validate a **batch** of records against a JSON Schema, returning the issues
/// for each record (an empty inner array ⇒ that record is valid). The schema is
/// compiled **once**, then reused across the batch. Unlike the host's throwing
/// `validateRecord`, this returns issues per record so a parity harness can diff
/// the full pass/fail + path/keyword picture against `ajv`. A schema that won't
/// compile surfaces as a structured, typed `ConfigError` (`config_invalid`).
#[napi]
pub fn validate_batch(
    env: Env,
    schema: JsValue,
    records: Vec<JsValue>,
) -> Result<Vec<Vec<JsValidationIssue>>> {
    let compiled = match CompiledSchema::compile(&schema.0) {
        Ok(c) => c,
        Err(err) => return Err(raise_core_error(&env, &err)),
    };
    let mut out = Vec::with_capacity(records.len());
    for record in records {
        let issues = compiled
            .validate(&record.0)
            .into_iter()
            .map(|issue| JsValidationIssue {
                path: issue.path,
                message: issue.message,
                source: issue.source.as_str().to_string(),
                schema_path: issue.schema_path,
                code: issue.code,
            })
            .collect();
        out.push(issues);
    }
    Ok(out)
}

/// Compile a raw-JS sort comparator (`rule`, the body of `(a, b) => { … }`) and
/// run it once against `a`/`b`, returning its numeric result. The direct
/// comparator-parity entry point: a harness asserts this equals the same rule
/// run through `node:vm` for identical inputs.
#[napi]
pub fn run_comparator(env: Env, rule: String, a: JsValue, b: JsValue) -> Result<f64> {
    let mut engine = match Engine::new() {
        Ok(e) => e,
        Err(err) => return Err(raise_core_error(&env, &err)),
    };
    let wrapped = format!("(a, b) => {{ {rule} }}");
    let handle = match engine.compile(&wrapped) {
        Ok(h) => h,
        Err(err) => return Err(raise_core_error(&env, &err)),
    };
    let result = engine
        .call(handle, &[a.0, b.0])
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e:?}")))?;
    engine
        .to_number(&result)
        .map_err(|err| raise_core_error(&env, &err))
}

/// A compiled sheet definition: the embedded engine plus the definition's
/// path template (and optional raw-JS sort comparator), **compiled once** at
/// construction and reused across every method call. Holds a `!Send` boa
/// context, so it is constructed and used on its owning JS thread — the
/// thread-confinement the spec requires. Exists to demonstrate the
/// compile-once-per-open / reuse-across-operations contract from JS.
#[napi]
pub struct CompiledDefinition {
    engine: Engine,
    template: Template,
    sort_handle: Option<usize>,
}

#[napi]
impl CompiledDefinition {
    /// Compile a definition once: parse the path template (compiling its
    /// expression snippets into the engine) and, if given, compile a raw-JS sort
    /// comparator. All snippet compilation happens here — never per operation.
    #[napi(constructor)]
    pub fn new(env: Env, path_template: String, sort_rule: Option<String>) -> Result<Self> {
        let mut engine = match Engine::new() {
            Ok(e) => e,
            Err(err) => return Err(raise_core_error(&env, &err)),
        };
        let template = match Template::compile(&path_template, &mut engine) {
            Ok(t) => t,
            Err(err) => return Err(raise_core_error(&env, &err)),
        };
        let sort_handle = match sort_rule {
            Some(rule) => {
                let wrapped = format!("(a, b) => {{ {rule} }}");
                match engine.compile(&wrapped) {
                    Ok(h) => Some(h),
                    Err(err) => return Err(raise_core_error(&env, &err)),
                }
            }
            None => None,
        };
        Ok(CompiledDefinition {
            engine,
            template,
            sort_handle,
        })
    }

    /// Render one record's path using the already-compiled template.
    #[napi]
    pub fn render_path(&mut self, env: Env, record: JsValue) -> Result<String> {
        self.template
            .render(&record.0, &mut self.engine)
            .map_err(|err| raise_core_error(&env, &err))
    }

    /// Run the compiled sort comparator on two values, returning its numeric
    /// result. Errors if the definition was built without a sort rule.
    #[napi]
    pub fn compare(&mut self, a: JsValue, b: JsValue) -> Result<f64> {
        let handle = self
            .sort_handle
            .ok_or_else(|| Error::new(Status::InvalidArg, "definition has no sort rule"))?;
        let result = self
            .engine
            .call(handle, &[a.0, b.0])
            .map_err(|e| Error::new(Status::GenericFailure, format!("{e:?}")))?;
        self.engine
            .to_number(&result)
            .map_err(|e| Error::new(Status::GenericFailure, e.message().to_string()))
    }

    /// How many snippets were compiled into this definition's engine. Constant
    /// across operations — proof that compilation happened once at construction,
    /// not per `render_path` / `compare` call.
    #[napi]
    pub fn snippet_count(&self) -> u32 {
        self.engine.snippet_count() as u32
    }
}

// ── record CRUD + diff/patch over the holo-tree substrate ─────────────────────
//
// These prove the record engine's parity from JS. Each opens a repo at `gitDir`
// and resolves a ref/hash to a tree in the core (the binding never touches a
// `gix::Repository` or a holo-tree node — the seam stays Rust-side). All are
// batch-first: a `Vec` of paths/records crosses the FFI once.

const DEFAULT_EXTENSION: &str = ".toml";

fn extension_of(extension: Option<String>) -> String {
    extension.unwrap_or_else(|| DEFAULT_EXTENSION.to_string())
}

/// Read a batch of records by path. Each result is the record (a plain object
/// with full TOML type fidelity) or `null` when no blob lives at that path.
#[napi]
pub fn record_read(
    env: Env,
    git_dir: String,
    tree_ref: String,
    base: String,
    paths: Vec<String>,
    extension: Option<String>,
) -> Result<Vec<Option<JsValue>>> {
    let ext = extension_of(extension);
    match record::read_records_at_ref(&git_dir, &tree_ref, &base, &paths, &ext) {
        Ok(values) => Ok(values.into_iter().map(|v| v.map(JsValue)).collect()),
        Err(err) => Err(raise_core_error(&env, &err)),
    }
}

/// The result of a `record_write`/`record_delete`: the new root tree hash plus
/// per-record output (`blobHashes` for writes, `existed` for deletes).
#[napi(object)]
pub struct JsWriteOutcome {
    pub tree_hash: String,
    pub blob_hashes: Vec<String>,
}

/// The result of a `record_delete`.
#[napi(object)]
pub struct JsDeleteOutcome {
    pub tree_hash: String,
    pub existed: Vec<bool>,
}

/// Write a batch of records (canonical TOML) under `base`, starting from the
/// tree `baseRef`. `paths[i]` is written from `records[i]`. Returns the new root
/// tree hash + each written blob hash. The bytes are produced by the core's
/// bytes-authority, so two bindings writing the same record agree byte-for-byte.
#[napi]
pub fn record_write(
    env: Env,
    git_dir: String,
    base_ref: String,
    base: String,
    paths: Vec<String>,
    records: Vec<JsValue>,
    extension: Option<String>,
) -> Result<JsWriteOutcome> {
    if paths.len() != records.len() {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "record_write: paths ({}) and records ({}) length mismatch",
                paths.len(),
                records.len()
            ),
        ));
    }
    let items: Vec<(String, Value)> = paths
        .into_iter()
        .zip(records.into_iter().map(|j| j.0))
        .collect();
    let ext = extension_of(extension);
    match record::write_records_at_ref(&git_dir, &base_ref, &base, &items, &ext) {
        Ok(outcome) => Ok(JsWriteOutcome {
            tree_hash: outcome.tree_hash,
            blob_hashes: outcome.blob_hashes,
        }),
        Err(err) => Err(raise_core_error(&env, &err)),
    }
}

/// Delete a batch of records by path under `base`, starting from `baseRef`.
/// `existed[i]` reports whether `paths[i]` was actually present.
#[napi]
pub fn record_delete(
    env: Env,
    git_dir: String,
    base_ref: String,
    base: String,
    paths: Vec<String>,
    extension: Option<String>,
) -> Result<JsDeleteOutcome> {
    let ext = extension_of(extension);
    match record::delete_records_at_ref(&git_dir, &base_ref, &base, &paths, &ext) {
        Ok(outcome) => Ok(JsDeleteOutcome {
            tree_hash: outcome.tree_hash,
            existed: outcome.existed,
        }),
        Err(err) => Err(raise_core_error(&env, &err)),
    }
}

/// One record from `record_list`: its path (relative to `base`, no extension)
/// and parsed value.
#[napi(object)]
pub struct JsRecordEntry {
    pub path: String,
    pub record: JsValue,
}

/// List every record under `base` in the tree `treeRef`, in sorted
/// (git-canonical) path order.
#[napi]
pub fn record_list(
    env: Env,
    git_dir: String,
    tree_ref: String,
    base: String,
    extension: Option<String>,
) -> Result<Vec<JsRecordEntry>> {
    let ext = extension_of(extension);
    match record::list_records_at_ref(&git_dir, &tree_ref, &base, &ext) {
        Ok(entries) => Ok(entries
            .into_iter()
            .map(|(path, record)| JsRecordEntry {
                path,
                record: JsValue(record),
            })
            .collect()),
        Err(err) => Err(raise_core_error(&env, &err)),
    }
}

// ── substrate read/write counters (bulk benchmark + hologit#464 finding) ──────

/// A snapshot of holo-tree's process-wide tree/blob counters — read-side
/// instrumentation for the bulk benchmark and the hologit#464 perf finding.
#[napi(object)]
pub struct JsSubstrateStats {
    pub trees_read: i64,
    pub trees_written: i64,
    pub trees_skipped_clean: i64,
    pub cache_hits: i64,
    pub cache_misses: i64,
    pub blobs_read: i64,
}

/// Snapshot the substrate (holo-tree) counters.
#[napi]
pub fn substrate_stats() -> JsSubstrateStats {
    let s = record::substrate_stats();
    JsSubstrateStats {
        trees_read: s.trees_read as i64,
        trees_written: s.trees_written as i64,
        trees_skipped_clean: s.trees_skipped_clean as i64,
        cache_hits: s.cache_hits as i64,
        cache_misses: s.cache_misses as i64,
        blobs_read: s.blobs_read as i64,
    }
}

/// Reset the substrate counters + the thread-local tree cache.
#[napi]
pub fn substrate_reset() {
    record::substrate_reset();
}

// ── query traversal + filtering ───────────────────────────────────────────────
//
// A query crosses the FFI once: the binding compiles the template + any
// predicate snippets into a single engine, then the core prunes the tree by the
// path template and applies the full filter natively (declarative equality /
// nested predicates) with the embedded engine as the escape hatch.
//
// Filter marshalling convention (the binding's only query-specific shape):
//   - a literal value          → equality predicate (native)
//   - `{ "$pred": "<js src>" }` → engine predicate `(value, record) => ( <src> )`
//   - a plain object           → nested filter (recurse)

/// Parse a JS filter object into a core [`Filter`], compiling any predicate
/// snippets into `engine`.
fn parse_filter(env: &Env, obj: &JsObject, engine: &mut Engine) -> Result<Filter> {
    let names = obj.get_property_names()?;
    let len = names.get_array_length()?;
    let mut filter = Filter::new();
    for i in 0..len {
        let key_js: JsString = names.get_element(i)?;
        let key = key_js.into_utf8()?.as_str()?.to_owned();
        let val: JsUnknown = obj.get_named_property(&key)?;
        filter.push(key, parse_filter_pred(env, val, engine)?);
    }
    Ok(filter)
}

fn parse_filter_pred(env: &Env, val: JsUnknown, engine: &mut Engine) -> Result<FilterPred> {
    if val.get_type()? == ValueType::Object && !val.is_array()? && !val.is_date()? {
        let obj = unsafe { JsObject::from_napi_value(env.raw(), val.raw())? };
        if obj.has_named_property("$pred")? {
            let pred: JsUnknown = obj.get_named_property("$pred")?;
            if pred.get_type()? == ValueType::String {
                let src_js = unsafe { JsString::from_napi_value(env.raw(), pred.raw())? };
                let src = src_js.into_utf8()?.as_str()?.to_owned();
                let wrapped = format!("(value, record) => ( {src} )");
                let handle = engine
                    .compile(&wrapped)
                    .map_err(|err| raise_core_error(env, &err))?;
                return Ok(FilterPred::Predicate(handle));
            }
        }
        // A plain object is a nested-table filter.
        let nested = parse_filter(env, &obj, engine)?;
        return Ok(FilterPred::Nested(nested));
    }
    // Everything else is an equality literal — marshal through the record value
    // type (preserving int/float + the datetime kind).
    let jv = unsafe { JsValue::from_napi_value(env.raw(), val.raw())? };
    Ok(FilterPred::Equals(jv.0))
}

/// Query records under `base` in the tree `treeRef`, returning each matched
/// `{ path, record }` in sorted path order. The template prunes the walk; the
/// filter (equality / nested / `$pred` snippets) is applied to each candidate.
/// Batch-first: the whole query crosses the FFI once.
#[napi]
pub fn record_query(
    env: Env,
    git_dir: String,
    tree_ref: String,
    base: String,
    template: String,
    filter: JsObject,
    extension: Option<String>,
) -> Result<Vec<JsRecordEntry>> {
    let ext = extension_of(extension);
    let repo = record::open_repo(&git_dir).map_err(|err| raise_core_error(&env, &err))?;
    let mut tree = record::resolve_tree(&repo, &tree_ref).map_err(|err| raise_core_error(&env, &err))?;
    let mut engine = Engine::new().map_err(|err| raise_core_error(&env, &err))?;
    let compiled = Template::compile(&template, &mut engine).map_err(|err| raise_core_error(&env, &err))?;
    let parsed = parse_filter(&env, &filter, &mut engine)?;
    match query::query_records(&repo, &mut tree, &base, &compiled, &parsed, &mut engine, &ext) {
        Ok(rows) => Ok(rows
            .into_iter()
            .map(|(path, record)| JsRecordEntry {
                path,
                record: JsValue(record),
            })
            .collect()),
        Err(err) => Err(raise_core_error(&env, &err)),
    }
}

/// The pruning candidate set alone (no content filter applied) — the direct
/// parity target for the host `Template.queryTree`. `query` is a (partial)
/// record of the path-template input fields. Returns candidate record paths
/// (relative to `base`, no extension) in sorted order.
#[napi]
pub fn record_query_candidates(
    env: Env,
    git_dir: String,
    tree_ref: String,
    base: String,
    template: String,
    query: JsValue,
    extension: Option<String>,
) -> Result<Vec<String>> {
    let ext = extension_of(extension);
    let repo = record::open_repo(&git_dir).map_err(|err| raise_core_error(&env, &err))?;
    let mut tree = record::resolve_tree(&repo, &tree_ref).map_err(|err| raise_core_error(&env, &err))?;
    let mut engine = Engine::new().map_err(|err| raise_core_error(&env, &err))?;
    let compiled = Template::compile(&template, &mut engine).map_err(|err| raise_core_error(&env, &err))?;
    query::query_candidate_paths(&repo, &mut tree, &base, &compiled, &query.0, &mut engine, &ext)
        .map_err(|err| raise_core_error(&env, &err))
}

/// The record fields that contribute to rendering `template` — the query
/// auto-derivation set (`Template.getFieldNames` parity). Insertion-ordered,
/// de-duplicated; expression components contribute a best-effort identifier
/// scan minus JS keywords/globals.
#[napi]
pub fn template_field_names(env: Env, template: String) -> Result<Vec<String>> {
    let mut engine = Engine::new().map_err(|err| raise_core_error(&env, &err))?;
    let compiled = Template::compile(&template, &mut engine).map_err(|err| raise_core_error(&env, &err))?;
    Ok(compiled.get_field_names())
}

// ── secondary indexing ─────────────────────────────────────────────────────────
//
// Lazy, in-memory indices built over the records under `base`. The binding
// lists once, builds the index in the core, and serves the lookups — the
// `Sheet`-level build caching / ref-move invalidation is downstream
// (`sheet-store-core`). `keySnippet` is the full keyFn source, e.g.
// `(r) => r.email.toLowerCase()`.

/// Build a **unique** index over the records under `base` and look up each key.
/// `results[i]` is the record for `keys[i]`, or `null` when no record carries
/// it. A duplicate key throws `IndexError(index_unique_conflict)` naming both
/// paths.
#[napi]
pub fn record_index_unique(
    env: Env,
    git_dir: String,
    tree_ref: String,
    base: String,
    key_snippet: String,
    keys: Vec<String>,
    extension: Option<String>,
) -> Result<Vec<Option<JsValue>>> {
    let ext = extension_of(extension);
    let records = record::list_records_at_ref(&git_dir, &tree_ref, &base, &ext)
        .map_err(|err| raise_core_error(&env, &err))?;
    let mut engine = Engine::new().map_err(|err| raise_core_error(&env, &err))?;
    let handle = engine
        .compile(&key_snippet)
        .map_err(|err| raise_core_error(&env, &err))?;
    let index = UniqueIndex::build(&records, handle, &mut engine).map_err(|err| raise_core_error(&env, &err))?;
    Ok(keys
        .iter()
        .map(|k| index.lookup(k).cloned().map(JsValue))
        .collect())
}

/// Build a **non-unique** index over the records under `base` and look up each
/// key. `results[i]` is every record carrying `keys[i]` (an empty array when
/// none).
#[napi]
pub fn record_index_multi(
    env: Env,
    git_dir: String,
    tree_ref: String,
    base: String,
    key_snippet: String,
    keys: Vec<String>,
    extension: Option<String>,
) -> Result<Vec<Vec<JsValue>>> {
    let ext = extension_of(extension);
    let records = record::list_records_at_ref(&git_dir, &tree_ref, &base, &ext)
        .map_err(|err| raise_core_error(&env, &err))?;
    let mut engine = Engine::new().map_err(|err| raise_core_error(&env, &err))?;
    let handle = engine
        .compile(&key_snippet)
        .map_err(|err| raise_core_error(&env, &err))?;
    let index = MultiIndex::build(&records, handle, &mut engine).map_err(|err| raise_core_error(&env, &err))?;
    Ok(keys
        .iter()
        .map(|k| {
            index
                .lookup(k)
                .iter()
                .map(|(_, record)| JsValue(record.clone()))
                .collect()
        })
        .collect())
}

/// Build a JS array of RFC 6902 ops, shaping `value` exactly like the `rfc6902`
/// package: a `remove` carries no `value` key, a null-replace carries
/// `value: null`, everything else carries the marshalled value.
fn build_patch_array(env: &Env, ops: &[PatchOp]) -> Result<JsObject> {
    let mut arr = env.create_array_with_length(ops.len())?;
    for (i, op) in ops.iter().enumerate() {
        let mut obj = env.create_object()?;
        obj.set_named_property("op", env.create_string(op.op.as_str())?)?;
        obj.set_named_property("path", env.create_string(&op.path)?)?;
        match &op.value {
            PatchValue::Absent => {}
            PatchValue::Null => {
                obj.set_named_property("value", env.get_null()?)?;
            }
            PatchValue::Value(v) => {
                let raw = unsafe { JsValue::to_napi_value(env.raw(), JsValue(v.clone()))? };
                let val = unsafe { JsUnknown::from_napi_value(env.raw(), raw)? };
                obj.set_named_property("value", val)?;
            }
        }
        arr.set_element(i as u32, obj)?;
    }
    Ok(arr)
}

/// Generate an RFC 6902 JSON Patch transforming `src` into `dst` — the core's
/// `createPatch`, matching the `rfc6902` package op-for-op. `null`/`undefined`
/// on either side is the JSON null `Sheet.diffFrom` passes for an added
/// (`src=null`) or deleted (`dst=null`) record.
#[napi]
pub fn create_patch(env: Env, src: Option<JsValue>, dst: Option<JsValue>) -> Result<JsObject> {
    let src_val = src.map(|j| j.0);
    let dst_val = dst.map(|j| j.0);
    let ops = gitsheets_core::create_patch(src_val.as_ref(), dst_val.as_ref());
    build_patch_array(&env, &ops)
}

/// Apply an RFC 7396 JSON Merge Patch to `target` (`null` ⇒ absent), returning
/// the merged record — the core's `mergePatch` behind `Sheet.patch`. A `null`
/// in the patch deletes that key; an object merges recursively; anything else
/// replaces wholesale. Returns `null` only when the patch deletes the record
/// outright.
#[napi]
pub fn apply_merge_patch(
    target: Option<JsValue>,
    patch: JsMergePatch,
) -> Result<Option<JsValue>> {
    let target_val = target.map(|j| j.0);
    Ok(gitsheets_core::apply_merge_patch(target_val.as_ref(), &patch.0).map(JsValue))
}

/// Diff records between two trees (`srcRef` → `dstRef`) under `base`, returning
/// one entry per change with status, src/dst blob hashes, the parsed src/dst
/// records, and the RFC 6902 patch — the full `Sheet.diffFrom({records,
/// patches})` payload, computed in the core. `srcRef` may be the empty-tree hash
/// for a from-scratch diff.
#[napi]
pub fn diff_records(
    env: Env,
    git_dir: String,
    src_ref: String,
    dst_ref: String,
    base: String,
    extension: Option<String>,
) -> Result<JsObject> {
    let ext = extension_of(extension);
    let diffs = match record::diff_records_at_refs(&git_dir, &src_ref, &dst_ref, &base, &ext) {
        Ok(d) => d,
        Err(err) => return Err(raise_core_error(&env, &err)),
    };
    let mut arr = env.create_array_with_length(diffs.len())?;
    for (i, d) in diffs.into_iter().enumerate() {
        let mut obj = env.create_object()?;
        obj.set_named_property("path", env.create_string(&d.change.path)?)?;
        obj.set_named_property("status", env.create_string(d.change.status.as_str())?)?;
        match &d.change.src_hash {
            Some(h) => obj.set_named_property("srcHash", env.create_string(h)?)?,
            None => obj.set_named_property("srcHash", env.get_null()?)?,
        }
        match &d.change.dst_hash {
            Some(h) => obj.set_named_property("dstHash", env.create_string(h)?)?,
            None => obj.set_named_property("dstHash", env.get_null()?)?,
        }
        set_optional_record(&env, &mut obj, "src", d.src)?;
        set_optional_record(&env, &mut obj, "dst", d.dst)?;
        let patch = build_patch_array(&env, &d.patch)?;
        obj.set_named_property("patch", patch)?;
        arr.set_element(i as u32, obj)?;
    }
    Ok(arr)
}

/// Set `key` on `obj` to the marshalled record, or `null` when absent.
fn set_optional_record(
    env: &Env,
    obj: &mut JsObject,
    key: &str,
    value: Option<Value>,
) -> Result<()> {
    match value {
        Some(v) => {
            let raw = unsafe { JsValue::to_napi_value(env.raw(), JsValue(v))? };
            let val = unsafe { JsUnknown::from_napi_value(env.raw(), raw)? };
            obj.set_named_property(key, val)?;
        }
        None => obj.set_named_property(key, env.get_null()?)?,
    }
    Ok(())
}

/// An RFC 7396 merge patch crossing the FFI — the structured form of a host
/// partial that *may* carry nulls (which the record `JsValue` rejects). A `null`
/// marshals to [`MergePatch::Delete`], a plain object to a recursive
/// [`MergePatch::Merge`], and everything else (scalar, array, `Date`) to a
/// wholesale [`MergePatch::Replace`].
pub struct JsMergePatch(pub MergePatch);

impl TypeName for JsMergePatch {
    fn type_name() -> &'static str {
        "any"
    }
    fn value_type() -> ValueType {
        ValueType::Unknown
    }
}

impl ValidateNapiValue for JsMergePatch {
    unsafe fn validate(
        _env: napi::sys::napi_env,
        _napi_val: napi::sys::napi_value,
    ) -> Result<napi::sys::napi_value> {
        Ok(std::ptr::null_mut())
    }
}

impl FromNapiValue for JsMergePatch {
    unsafe fn from_napi_value(
        env: napi::sys::napi_env,
        napi_val: napi::sys::napi_value,
    ) -> Result<Self> {
        let unknown = JsUnknown::from_napi_value(env, napi_val)?;
        let patch = match unknown.get_type()? {
            // The null delete-sentinel (RFC 7396). `undefined` is treated the
            // same — a missing/cleared key.
            ValueType::Null | ValueType::Undefined => MergePatch::Delete,
            ValueType::Object if !unknown.is_array()? && !unknown.is_date()? => {
                // A plain object merges recursively.
                let obj = JsObject::from_napi_value(env, napi_val)?;
                let names = obj.get_property_names()?;
                let len = names.get_array_length()?;
                let mut map = indexmap::IndexMap::new();
                for i in 0..len {
                    let key_js: JsString = names.get_element(i)?;
                    let key = key_js.into_utf8()?.as_str()?.to_owned();
                    let child: JsUnknown = obj.get_named_property(&key)?;
                    let child = JsMergePatch::from_napi_value(env, child.raw())?;
                    map.insert(key, child.0);
                }
                MergePatch::Merge(map)
            }
            // Scalars, arrays, and Dates replace wholesale — marshal through the
            // record value type (which preserves int/float + the datetime kind).
            _ => {
                let value = JsValue::from_napi_value(env, napi_val)?;
                MergePatch::Replace(value.0)
            }
        };
        Ok(JsMergePatch(patch))
    }
}

/// Set a structured JS exception pending for a core error and return the napi
/// sentinel that tells napi not to overwrite it. Shared by the real entry
/// points so a `gitsheets_core::Error` always crosses as its typed class.
fn raise_core_error(env: &Env, err: &gitsheets_core::Error) -> Error {
    if throw_structured_error(env, err).is_err() {
        return Error::new(Status::GenericFailure, err.message().to_string());
    }
    Error::new(Status::PendingException, err.message().to_string())
}

/// Throw the core error for a given stable `code`, surfaced as a **structured,
/// matchable** JS error (own `code`, `status`, `gitsheetsClass`, and any
/// `issues`/`conflictingPaths`). Boundary-test entry point: it exercises the
/// error-variant → typed-class mapping without standing up real engine paths.
#[napi]
pub fn simulate_core_error(env: Env, code: String) -> Result<()> {
    match gitsheets_core::example_error(&code) {
        Some(err) => {
            throw_structured_error(&env, &err)?;
            // The exception is already pending from `env.throw`; tell napi not
            // to overwrite it.
            Err(Error::new(
                Status::PendingException,
                err.message().to_string(),
            ))
        }
        None => Err(Error::new(
            Status::InvalidArg,
            format!("unknown error code '{code}'"),
        )),
    }
}

/// Construct a real JS `Error` (via the global `Error` constructor) and attach
/// the core error's structured discriminants + payload, then set it pending.
fn throw_structured_error(env: &Env, err: &gitsheets_core::Error) -> Result<()> {
    let global = env.get_global()?;
    let error_ctor: JsFunction = global.get_named_property("Error")?;
    let message = env.create_string(err.message())?;
    let mut obj: JsObject = error_ctor.new_instance(&[message])?;

    obj.set_named_property("code", env.create_string(err.code())?)?;
    obj.set_named_property("status", env.create_uint32(err.status() as u32)?)?;
    obj.set_named_property("gitsheetsClass", env.create_string(err.class().as_str())?)?;

    let issues = err.issues();
    if !issues.is_empty() {
        let mut arr = env.create_array_with_length(issues.len())?;
        for (i, issue) in issues.iter().enumerate() {
            let mut io = env.create_object()?;
            let mut path = env.create_array_with_length(issue.path.len())?;
            for (j, seg) in issue.path.iter().enumerate() {
                path.set_element(j as u32, env.create_string(seg)?)?;
            }
            io.set_named_property("path", path)?;
            io.set_named_property("message", env.create_string(&issue.message)?)?;
            io.set_named_property("source", env.create_string(issue.source.as_str())?)?;
            if let Some(sp) = &issue.schema_path {
                io.set_named_property("schemaPath", env.create_string(sp)?)?;
            }
            if let Some(c) = &issue.code {
                io.set_named_property("code", env.create_string(c)?)?;
            }
            arr.set_element(i as u32, io)?;
        }
        obj.set_named_property("issues", arr)?;
    }

    let paths = err.conflicting_paths();
    if !paths.is_empty() {
        let mut arr = env.create_array_with_length(paths.len())?;
        for (i, p) in paths.iter().enumerate() {
            arr.set_element(i as u32, env.create_string(p)?)?;
        }
        obj.set_named_property("conflictingPaths", arr)?;
    }

    env.throw(obj)?;
    Ok(())
}

// ── orchestration: Sheet / Transaction / Store (sheet-store-core) ──────────────
//
// A stateful `CoreTransaction` exposes the core's state machine to a `node
// --test` boundary suite. It demonstrates the lifecycle (commit / no-op /
// parent_moved / transaction_in_progress) and the **two-phase consumer-validator
// protocol**: `prepareUpsert` runs phase 1 (shape-validate → normalize → render →
// unique-check → serialize) and hands the candidate back to JS; the host runs its
// validator; `stageUpsert` runs phase 3 (write). No core lock is held across the
// host callback — `prepareUpsert` and `stageUpsert` are separate FFI calls.

use std::collections::HashMap;

use gitsheets_core::sheet::Sheet as CoreSheet;
use gitsheets_core::sheet::UpsertCandidate;
use gitsheets_core::store;
use gitsheets_core::transaction::{Author as CoreAuthor, Transaction, TransactionOptions};

/// Commit identity for the JS surface.
#[napi(object)]
pub struct JsAuthor {
    pub name: String,
    pub email: String,
}

/// One ordered commit trailer (`Key: value`).
#[napi(object)]
pub struct JsTrailer {
    pub key: String,
    pub value: String,
}

/// Options for opening a [`CoreTransaction`]. `timeSeconds` / `offsetMinutes`
/// carry the host clock + local-timezone offset (a host concern), exactly as the
/// JS `commitTreeWithRepo` computes them today.
#[napi(object)]
pub struct JsTransactionOptions {
    pub parent: Option<String>,
    pub branch: Option<String>,
    pub author: Option<JsAuthor>,
    pub committer: Option<JsAuthor>,
    pub message: String,
    pub trailers: Option<Vec<JsTrailer>>,
    pub time_seconds: i64,
    pub offset_minutes: i32,
}

/// The outcome of [`CoreTransaction::finalize`]. A no-op (no mutation, or the
/// resulting tree equals the parent's) returns `commitHash = null`.
#[napi(object)]
pub struct JsTransactionResult {
    pub commit_hash: Option<String>,
    pub tree_hash: Option<String>,
    pub ref_name: Option<String>,
    pub parent_commit_hash: Option<String>,
}

/// The outcome of [`CoreTransaction::stage_upsert`].
#[napi(object)]
pub struct JsStageOutcome {
    pub blob_hash: String,
    pub path: String,
}

/// A live transaction the JS boundary suite drives. Holds a `!Send`
/// `Transaction` (repo + private tree) and the opened `Sheet`s, so it is
/// constructed and used on its owning JS thread — the thread-confinement the
/// spec requires.
#[napi]
pub struct CoreTransaction {
    inner: Option<Transaction>,
    sheets: HashMap<String, CoreSheet>,
    pending: HashMap<String, UpsertCandidate>,
}

#[napi]
impl CoreTransaction {
    /// Open a transaction against `gitDir`. Resolves the parent/branch, builds
    /// the private tree, and acquires the single-writer slot. A concurrent open
    /// on the same repo throws `TransactionError(transaction_in_progress)`.
    #[napi(factory)]
    pub fn begin(env: Env, git_dir: String, opts: JsTransactionOptions) -> Result<Self> {
        let core_opts = TransactionOptions {
            parent: opts.parent,
            branch: opts.branch,
            author: opts.author.map(|a| CoreAuthor {
                name: a.name,
                email: a.email,
            }),
            committer: opts.committer.map(|a| CoreAuthor {
                name: a.name,
                email: a.email,
            }),
            message: opts.message,
            trailers: opts
                .trailers
                .unwrap_or_default()
                .into_iter()
                .map(|t| (t.key, t.value))
                .collect(),
            time_seconds: opts.time_seconds,
            offset_minutes: opts.offset_minutes,
        };
        match Transaction::begin(&git_dir, core_opts) {
            Ok(tx) => Ok(CoreTransaction {
                inner: Some(tx),
                sheets: HashMap::new(),
                pending: HashMap::new(),
            }),
            Err(err) => Err(raise_core_error(&env, &err)),
        }
    }

    /// Open a sheet against this transaction's tree (config read + template /
    /// schema / sort comparators compiled once).
    #[napi]
    pub fn open_sheet(
        &mut self,
        env: Env,
        name: String,
        config_path: String,
        open_root: String,
        prefix: String,
    ) -> Result<()> {
        let Self { inner, sheets, .. } = self;
        let tx = inner.as_mut().ok_or_else(|| {
            Error::new(Status::GenericFailure, "transaction is already finalized")
        })?;
        let (repo, tree) = tx.split();
        match CoreSheet::open(repo, tree, &name, &config_path, &open_root, &prefix) {
            Ok(sheet) => {
                sheets.insert(name, sheet);
                Ok(())
            }
            Err(err) => Err(raise_core_error(&env, &err)),
        }
    }

    /// Phase 1 of the two-phase protocol *(non-mutating)*. Returns the candidate
    /// (`path`, `nextText`, and the normalized `record`) for the host validator;
    /// the candidate is stashed for a subsequent `stageUpsert`. A JSON-Schema
    /// rejection throws `ValidationError` here, before any bytes are written.
    #[napi]
    pub fn prepare_upsert(
        &mut self,
        env: Env,
        name: String,
        record: JsValue,
        previous_path: Option<String>,
        allow_missing_body: Option<bool>,
    ) -> Result<JsObject> {
        let Self {
            inner,
            sheets,
            pending,
        } = self;
        let tx = inner.as_mut().ok_or_else(|| {
            Error::new(Status::GenericFailure, "transaction is already finalized")
        })?;
        let (repo, tree) = tx.split();
        let sheet = sheets
            .get_mut(&name)
            .ok_or_else(|| Error::new(Status::InvalidArg, format!("sheet {name:?} not opened")))?;
        let candidate = match sheet.prepare_upsert(
            repo,
            tree,
            &record.0,
            previous_path,
            allow_missing_body.unwrap_or(false),
        ) {
            Ok(c) => c,
            Err(err) => return Err(raise_core_error(&env, &err)),
        };

        let mut obj = env.create_object()?;
        obj.set_named_property("path", env.create_string(&candidate.record_path)?)?;
        obj.set_named_property("nextText", env.create_string(&candidate.next_text)?)?;
        let rec_raw =
            unsafe { JsValue::to_napi_value(env.raw(), JsValue(candidate.normalized.clone()))? };
        let rec = unsafe { JsUnknown::from_napi_value(env.raw(), rec_raw)? };
        obj.set_named_property("record", rec)?;

        pending.insert(name, candidate);
        Ok(obj)
    }

    /// Phase 3 *(mutating)*: write the stashed candidate from the last
    /// `prepareUpsert` for `name`. Marks the transaction mutated.
    #[napi]
    pub fn stage_upsert(&mut self, env: Env, name: String) -> Result<JsStageOutcome> {
        let Self {
            inner,
            sheets,
            pending,
        } = self;
        let candidate = pending.remove(&name).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("no prepared candidate for sheet {name:?}"),
            )
        })?;
        let tx = inner.as_mut().ok_or_else(|| {
            Error::new(Status::GenericFailure, "transaction is already finalized")
        })?;
        let outcome = {
            let (repo, tree) = tx.split();
            let sheet = sheets.get_mut(&name).ok_or_else(|| {
                Error::new(Status::InvalidArg, format!("sheet {name:?} not opened"))
            })?;
            match sheet.stage_upsert(repo, tree, &candidate) {
                Ok(o) => o,
                Err(err) => return Err(raise_core_error(&env, &err)),
            }
        };
        tx.mark_mutated();
        Ok(JsStageOutcome {
            blob_hash: outcome.blob_hash,
            path: outcome.path,
        })
    }

    /// Pre-flight idempotency check (`Sheet.willChange`) — same phase-1 pipeline,
    /// then a byte comparison to the existing blob. Non-mutating.
    #[napi]
    pub fn will_change(
        &mut self,
        env: Env,
        name: String,
        record: JsValue,
        previous_path: Option<String>,
        allow_missing_body: Option<bool>,
    ) -> Result<JsObject> {
        let Self { inner, sheets, .. } = self;
        let tx = inner.as_mut().ok_or_else(|| {
            Error::new(Status::GenericFailure, "transaction is already finalized")
        })?;
        let (repo, tree) = tx.split();
        let sheet = sheets
            .get_mut(&name)
            .ok_or_else(|| Error::new(Status::InvalidArg, format!("sheet {name:?} not opened")))?;
        let wc = match sheet.will_change(
            repo,
            tree,
            &record.0,
            previous_path,
            allow_missing_body.unwrap_or(false),
        ) {
            Ok(w) => w,
            Err(err) => return Err(raise_core_error(&env, &err)),
        };
        let mut obj = env.create_object()?;
        obj.set_named_property("changed", env.get_boolean(wc.changed)?)?;
        obj.set_named_property("path", env.create_string(&wc.path)?)?;
        match &wc.current_blob_hash {
            Some(h) => obj.set_named_property("currentBlobHash", env.create_string(h)?)?,
            None => obj.set_named_property("currentBlobHash", env.get_null()?)?,
        }
        obj.set_named_property("nextText", env.create_string(&wc.next_text)?)?;
        Ok(obj)
    }

    /// Delete a record by its sheet-relative path *(mutating)*. Throws
    /// `NotFoundError(record_not_found)` when absent.
    #[napi]
    pub fn delete(&mut self, env: Env, name: String, record_path: String) -> Result<()> {
        let Self { inner, sheets, .. } = self;
        let tx = inner.as_mut().ok_or_else(|| {
            Error::new(Status::GenericFailure, "transaction is already finalized")
        })?;
        {
            let (repo, tree) = tx.split();
            let sheet = sheets.get_mut(&name).ok_or_else(|| {
                Error::new(Status::InvalidArg, format!("sheet {name:?} not opened"))
            })?;
            if let Err(err) = sheet.delete_at_path(repo, tree, &record_path) {
                return Err(raise_core_error(&env, &err));
            }
        }
        tx.mark_mutated();
        Ok(())
    }

    /// `Sheet.clear` *(mutating)* — empties the sheet's data subtree.
    #[napi]
    pub fn clear(&mut self, env: Env, name: String) -> Result<()> {
        let Self { inner, sheets, .. } = self;
        let tx = inner.as_mut().ok_or_else(|| {
            Error::new(Status::GenericFailure, "transaction is already finalized")
        })?;
        {
            let (repo, tree) = tx.split();
            let sheet = sheets.get_mut(&name).ok_or_else(|| {
                Error::new(Status::InvalidArg, format!("sheet {name:?} not opened"))
            })?;
            if let Err(err) = sheet.clear(repo, tree) {
                return Err(raise_core_error(&env, &err));
            }
        }
        tx.mark_mutated();
        Ok(())
    }

    /// List every record under the sheet's base, decoded through the format
    /// codec, in sorted path order. `withBody` is the lazy-body switch for
    /// markdown sheets (`false` omits the body field); a no-op for TOML sheets.
    /// Read-only — does not mark the transaction mutated.
    #[napi]
    pub fn list(&mut self, env: Env, name: String, with_body: bool) -> Result<Vec<JsRecordEntry>> {
        let Self { inner, sheets, .. } = self;
        let tx = inner.as_mut().ok_or_else(|| {
            Error::new(Status::GenericFailure, "transaction is already finalized")
        })?;
        let (repo, tree) = tx.split();
        let sheet = sheets
            .get(&name)
            .ok_or_else(|| Error::new(Status::InvalidArg, format!("sheet {name:?} not opened")))?;
        match sheet.list(repo, tree, with_body) {
            Ok(rows) => Ok(rows
                .into_iter()
                .map(|(path, record)| JsRecordEntry {
                    path,
                    record: JsValue(record),
                })
                .collect()),
            Err(err) => Err(raise_core_error(&env, &err)),
        }
    }

    /// The parent commit hash captured at open (null on a fresh repo).
    #[napi]
    pub fn parent_commit_hash(&self) -> Option<String> {
        self.inner.as_ref().and_then(|t| t.parent_commit_hash())
    }

    /// Finalize: commit-on-success-only with no-op detection + `parent_moved`
    /// re-check + CAS ref movement. Consumes the transaction.
    #[napi]
    pub fn finalize(&mut self, env: Env) -> Result<JsTransactionResult> {
        let tx = self.inner.take().ok_or_else(|| {
            Error::new(Status::GenericFailure, "transaction is already finalized")
        })?;
        match tx.finalize() {
            Ok(r) => Ok(JsTransactionResult {
                commit_hash: r.commit_hash,
                tree_hash: r.tree_hash,
                ref_name: r.ref_name,
                parent_commit_hash: r.parent_commit_hash,
            }),
            Err(err) => Err(raise_core_error(&env, &err)),
        }
    }

    /// Discard without committing (handler threw). Releases the writer slot.
    #[napi]
    pub fn discard(&mut self) {
        if let Some(tx) = self.inner.take() {
            tx.discard();
        }
    }
}

/// Discover every sheet declared in `<openRoot>/.gitsheets/*.toml` in the tree
/// `treeRef`. Sorted bare names. The `Store` discovery half (`openStore`).
#[napi]
pub fn core_discover_sheets(
    env: Env,
    git_dir: String,
    tree_ref: String,
    open_root: String,
) -> Result<Vec<String>> {
    let repo = record::open_repo(&git_dir).map_err(|err| raise_core_error(&env, &err))?;
    let mut tree =
        record::resolve_tree(&repo, &tree_ref).map_err(|err| raise_core_error(&env, &err))?;
    store::discover_sheets(&repo, &mut tree, &open_root).map_err(|err| raise_core_error(&env, &err))
}

/// The `openStore` `config_missing` check: every validator must name a declared
/// sheet. Throws `ConfigError(config_missing)` otherwise.
#[napi]
pub fn core_check_validators(
    env: Env,
    declared: Vec<String>,
    validator_names: Vec<String>,
) -> Result<()> {
    store::check_validators(&declared, &validator_names).map_err(|err| raise_core_error(&env, &err))
}

// ── markdown / mdx content-type codec (markdown-codec-core) ─────────────────────
//
// The frontmatter+body codec, exposed directly so the boundary suite can assert
// byte-level parity with the JS oracle (`packages/gitsheets/src/format/markdown.ts`).
// markdownlint body-NORMALIZATION is NOT applied here — it is a host-side pre-pass
// (see gitsheets_core::codec module docs); these surface the byte-deterministic
// framing, title-from-H1, and lazy-body parts of the format.

use gitsheets_core::codec;
use gitsheets_core::config::{FormatConfig, FormatKind, Markdownlint};

/// Build a markdown `FormatConfig` for the direct codec entry points. The
/// markdownlint setting is irrelevant to these (the core never applies it).
fn markdown_format(body_field: String, title_field: Option<String>) -> FormatConfig {
    FormatConfig {
        kind: FormatKind::Markdown,
        body: Some(body_field),
        title: title_field,
        markdownlint: Markdownlint::Default,
    }
}

/// Serialize a record to its on-disk markdown bytes (`+++` frontmatter + body),
/// enforcing the title-from-H1 invariant when `titleField` is set. The body is
/// framed verbatim — markdownlint normalization is the host's pre-pass. A
/// non-string body or a title that disagrees with the body's H1 throws a typed
/// `ValidationError`.
#[napi]
pub fn markdown_serialize(
    env: Env,
    record: JsValue,
    body_field: String,
    title_field: Option<String>,
) -> Result<String> {
    let cfg = markdown_format(body_field, title_field);
    codec::serialize(&record.0, &cfg).map_err(|err| raise_core_error(&env, &err))
}

/// Parse on-disk markdown bytes into a full record (frontmatter fields + the
/// body under `bodyField`). Mirrors `markdownFormat.parse`.
#[napi]
pub fn markdown_parse(
    env: Env,
    text: String,
    body_field: String,
    title_field: Option<String>,
) -> Result<JsValue> {
    let cfg = markdown_format(body_field, title_field);
    codec::parse(&text, &cfg)
        .map(JsValue)
        .map_err(|err| raise_core_error(&env, &err))
}

/// Parse only the frontmatter — the lazy-body path. The body field is absent in
/// the returned record. Mirrors `markdownFormat.parseHeaderOnly`.
#[napi]
pub fn markdown_parse_header_only(
    env: Env,
    text: String,
    body_field: String,
) -> Result<JsValue> {
    let cfg = markdown_format(body_field, None);
    codec::parse_header_only(&text, &cfg)
        .map(JsValue)
        .map_err(|err| raise_core_error(&env, &err))
}

/// Extract the first ATX-style H1 from a markdown body, or `null` if absent.
/// Mirrors `extractFirstH1`.
#[napi]
pub fn markdown_extract_h1(body: String) -> Option<String> {
    codec::extract_first_h1(&body)
}

/// Rewrite (or prepend) the first ATX H1 of a markdown body to `title`. Mirrors
/// `rewriteLeadingH1` — the `Sheet.patch` title-reconciliation helper.
#[napi]
pub fn markdown_rewrite_h1(body: String, title: String) -> String {
    codec::rewrite_leading_h1(&body, &title)
}

/// The effective markdownlint config the host's normalization pre-pass should
/// apply, or `null` when disabled. The defaults (`default: true`, `MD013:
/// false`, `MD041: false`) layered with any `[gitsheet.format.markdownlint]`
/// overrides, plus the `MD041` auto-enable when title-from-H1 is on. The core
/// computes the ruleset but does NOT apply it (see the codec module docs).
#[napi]
pub fn markdown_resolve_lint_config(
    markdownlint: JsValue,
    title_is_set: bool,
) -> Option<JsValue> {
    // Marshal the raw `[gitsheet.format].markdownlint` value: `false` → disabled,
    // a table → user rules, anything else → defaults.
    let setting = match &markdownlint.0 {
        Value::Boolean(false) => Markdownlint::Disabled,
        Value::Table(t) => Markdownlint::Rules(t.clone()),
        _ => Markdownlint::Default,
    };
    setting.resolve(title_is_set).map(JsValue)
}
