//! `gitsheets-py` — the Python (pyo3) binding for [`gitsheets_core`].
//!
//! This crate is the **second** binding over the same Rust core, and its whole
//! reason to exist is to prove the thin-binding model: everything that
//! determines on-disk bytes lives in `gitsheets-core`, so a record written from
//! Python and the same record written from Node produce **byte-identical**
//! trees, blobs, and commits. The binding owns exactly one thing — **marshalling**
//! between Python host objects and the core's TOML-faithful
//! [`Value`](gitsheets_core::Value), with the type-fidelity rules from
//! [`specs/rust-core.md`](../../../specs/rust-core.md):
//!
//! - **Integers** — the core stores `i64`; Python's `int` is arbitrary-precision,
//!   so it maps directly (no 2^53 dance like JS). An inbound `int` outside the
//!   `i64` range TOML permits raises `OverflowError`.
//! - **Floats** — `f64`, kept distinct from integers (`1` and `1.0` differ).
//! - **Datetimes** — all four TOML kinds live in the core; the binding surfaces
//!   them as an aware UTC `datetime.datetime`, mirroring the Node `Date` mapping
//!   (an absolute instant at UTC), with the precise kind retained core-side.
//! - **Tables ↔ `dict`, arrays ↔ `list`, strings/bools** — obvious.
//!
//! Errors cross as typed Python exceptions (a `GitsheetsError` hierarchy mirroring
//! the Node `binding.cjs` classes), each carrying `code`/`status`/
//! `gitsheets_class` plus `issues`/`conflicting_paths` payloads.
//!
//! GIL / thread model: pyo3 holds the GIL across each call. The stateful classes
//! ([`CompiledDefinition`], [`CoreTransaction`]) hold a `!Send` boa engine and a
//! `gix::Repository`, so they are declared `unsendable` — pyo3 pins them to their
//! creating thread, which is exactly the thread-confinement the embedded engine
//! and holo-tree's thread-local cache require. The two-phase consumer-validator
//! protocol (`prepare_upsert` → host validates → `stage_upsert`) holds no core
//! borrow across the Python callback: they are separate FFI calls.

use std::collections::HashMap;

use chrono::{Datelike, Timelike};
use gitsheets_core::diff::{MergePatch, PatchOp, PatchValue};
use gitsheets_core::engine::Engine;
use gitsheets_core::index::{MultiIndex, UniqueIndex};
use gitsheets_core::path_template::Template;
use gitsheets_core::query::{self, Filter, FilterPred};
use gitsheets_core::record;
use gitsheets_core::sheet::{Sheet as CoreSheet, UpsertCandidate};
use gitsheets_core::store;
use gitsheets_core::transaction::{Author as CoreAuthor, Transaction, TransactionOptions};
use gitsheets_core::validation::CompiledSchema;
use gitsheets_core::{Datetime, Value};
use indexmap::IndexMap;
use pyo3::create_exception;
use pyo3::exceptions::{PyException, PyOverflowError, PyRuntimeError, PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyDict, PyFloat, PyInt, PyList, PyString, PyTuple};
use toml::value::{Date as TomlDate, Datetime as TomlDatetime, Offset, Time as TomlTime};

const DEFAULT_EXTENSION: &str = ".toml";

fn extension_of(extension: Option<String>) -> String {
    extension.unwrap_or_else(|| DEFAULT_EXTENSION.to_string())
}

// ── typed exception hierarchy (mirrors binding.cjs) ───────────────────────────

create_exception!(_gitsheets, GitsheetsError, PyException);
create_exception!(_gitsheets, ConfigError, GitsheetsError);
create_exception!(_gitsheets, ValidationError, GitsheetsError);
create_exception!(_gitsheets, TransactionError, GitsheetsError);
create_exception!(_gitsheets, IndexError, GitsheetsError);
create_exception!(_gitsheets, RefError, GitsheetsError);
create_exception!(_gitsheets, PathTemplateError, GitsheetsError);
create_exception!(_gitsheets, NotFoundError, GitsheetsError);

/// Map a structured core error onto its typed Python exception, attaching the
/// `code`/`status`/`gitsheets_class` discriminants and any `issues` /
/// `conflicting_paths` payloads — the Python analogue of `binding.cjs`'s
/// `mapCoreError` + the napi `throw_structured_error`.
fn raise_core_error(py: Python<'_>, err: &gitsheets_core::Error) -> PyErr {
    let class = err.class().as_str();
    let message = err.message().to_string();
    let pyerr = match class {
        "ConfigError" => ConfigError::new_err(message),
        "ValidationError" => ValidationError::new_err(message),
        "TransactionError" => TransactionError::new_err(message),
        "IndexError" => IndexError::new_err(message),
        "RefError" => RefError::new_err(message),
        "PathTemplateError" => PathTemplateError::new_err(message),
        "NotFoundError" => NotFoundError::new_err(message),
        _ => GitsheetsError::new_err(message),
    };
    let value = pyerr.value(py);
    let _ = value.setattr("code", err.code());
    let _ = value.setattr("status", err.status());
    let _ = value.setattr("gitsheets_class", class);

    let issues = err.issues();
    if !issues.is_empty() {
        let list = PyList::empty(py);
        for issue in issues {
            let d = PyDict::new(py);
            let _ = d.set_item("path", issue.path.clone());
            let _ = d.set_item("message", issue.message.clone());
            let _ = d.set_item("source", issue.source.as_str());
            let _ = d.set_item("schema_path", issue.schema_path.clone());
            let _ = d.set_item("code", issue.code.clone());
            let _ = list.append(d);
        }
        let _ = value.setattr("issues", list);
    }
    let paths = err.conflicting_paths();
    if !paths.is_empty() {
        let _ = value.setattr("conflicting_paths", paths.to_vec());
    }
    pyerr
}

// ── core Value <-> Python marshalling ─────────────────────────────────────────

/// Is this object a `datetime.datetime`? Detected by `isinstance` against the
/// runtime `datetime` class (abi3-safe — no datetime C-API needed).
fn is_py_datetime(obj: &Bound<'_, PyAny>) -> PyResult<bool> {
    let cls = obj.py().import("datetime")?.getattr("datetime")?;
    obj.is_instance(&cls)
}

/// Marshal a Python object into a core [`Value`] with full type fidelity. The
/// type order matters: `bool` is a subclass of `int` in Python, so it is checked
/// first.
fn py_to_value(obj: &Bound<'_, PyAny>) -> PyResult<Value> {
    if let Ok(b) = obj.cast::<PyBool>() {
        return Ok(Value::Boolean(b.is_true()));
    }
    if obj.cast::<PyInt>().is_ok() {
        let v: i64 = obj.extract().map_err(|_| {
            PyOverflowError::new_err("integer is outside the i64 range TOML permits")
        })?;
        return Ok(Value::Integer(v));
    }
    if let Ok(f) = obj.cast::<PyFloat>() {
        return Ok(Value::Float(f.value()));
    }
    if let Ok(s) = obj.cast::<PyString>() {
        return Ok(Value::String(s.extract::<String>()?));
    }
    if is_py_datetime(obj)? {
        return Ok(Value::Datetime(py_datetime_to_core(obj)?));
    }
    if let Ok(d) = obj.cast::<PyDict>() {
        let mut map = IndexMap::new();
        for (k, v) in d.iter() {
            let key: String = k
                .extract()
                .map_err(|_| PyTypeError::new_err("table (dict) keys must be strings"))?;
            map.insert(key, py_to_value(&v)?);
        }
        return Ok(Value::Table(map));
    }
    if let Ok(l) = obj.cast::<PyList>() {
        let mut items = Vec::with_capacity(l.len());
        for item in l.iter() {
            items.push(py_to_value(&item)?);
        }
        return Ok(Value::Array(items));
    }
    if let Ok(t) = obj.cast::<PyTuple>() {
        let mut items = Vec::with_capacity(t.len());
        for item in t.iter() {
            items.push(py_to_value(&item)?);
        }
        return Ok(Value::Array(items));
    }
    let type_name = obj.get_type().name()?.to_string();
    Err(PyTypeError::new_err(format!(
        "cannot marshal Python value of type {type_name} to a TOML value (None has no TOML representation)"
    )))
}

/// Marshal a core [`Value`] back to a Python object.
fn value_to_py<'py>(py: Python<'py>, value: Value) -> PyResult<Bound<'py, PyAny>> {
    Ok(match value {
        Value::String(s) => s.into_pyobject(py)?.into_any(),
        Value::Boolean(b) => b.into_pyobject(py)?.to_owned().into_any(),
        Value::Integer(i) => i.into_pyobject(py)?.into_any(),
        Value::Float(f) => f.into_pyobject(py)?.into_any(),
        Value::Datetime(dt) => core_datetime_to_py(py, &dt)?,
        Value::Array(items) => {
            let list = PyList::empty(py);
            for item in items {
                list.append(value_to_py(py, item)?)?;
            }
            list.into_any()
        }
        Value::Table(map) => {
            let dict = PyDict::new(py);
            for (k, v) in map {
                dict.set_item(k, value_to_py(py, v)?)?;
            }
            dict.into_any()
        }
    })
}

fn opt_value_to_py<'py>(py: Python<'py>, value: Option<Value>) -> PyResult<Bound<'py, PyAny>> {
    match value {
        Some(v) => value_to_py(py, v),
        None => Ok(py.None().into_bound(py)),
    }
}

/// Marshal an iterable of Python records into a `Vec<Value>` (one FFI crossing
/// for the whole batch).
fn py_records_to_values(obj: &Bound<'_, PyAny>) -> PyResult<Vec<Value>> {
    let mut out = Vec::new();
    for item in obj.try_iter()? {
        out.push(py_to_value(&item?)?);
    }
    Ok(out)
}

// ── datetime <-> Python datetime bridge (host-surface concern) ────────────────

/// Build an offset-datetime (UTC `Z`) core datetime from epoch milliseconds —
/// byte-identical to the napi `unix_millis_to_datetime`, so a Python `datetime`
/// and a JS `Date` at the same instant produce the same core value.
fn unix_millis_to_datetime(ms: i64) -> PyResult<Datetime> {
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .ok_or_else(|| PyValueError::new_err(format!("datetime {ms} ms is out of range")))?;
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

/// Epoch milliseconds for any of the four datetime kinds — byte-identical to the
/// napi `datetime_to_unix_millis` (local kinds projected to UTC for the surface;
/// the core retains the precise kind for re-serialization).
fn datetime_to_unix_millis(dt: &Datetime) -> PyResult<i64> {
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
            .ok_or_else(|| PyValueError::new_err("datetime has an invalid date"))?;
    let naive_time = chrono::NaiveTime::from_hms_nano_opt(
        time.hour as u32,
        time.minute as u32,
        time.second as u32,
        time.nanosecond,
    )
    .ok_or_else(|| PyValueError::new_err("datetime has an invalid time"))?;
    let naive = chrono::NaiveDateTime::new(naive_date, naive_time);
    let offset_minutes: i64 = match offset {
        Some(Offset::Z) => 0,
        Some(Offset::Custom { minutes }) => minutes as i64,
        None => 0,
    };
    Ok(naive.and_utc().timestamp_millis() - offset_minutes * 60_000)
}

/// Convert a Python `datetime.datetime` to a core datetime. Aware datetimes are
/// converted to UTC; naive ones are interpreted as UTC (matching the Node
/// `Date`-as-instant projection). The instant funnels through the same
/// epoch-millis bridge as napi, so the resulting core value is byte-identical.
fn py_datetime_to_core(obj: &Bound<'_, PyAny>) -> PyResult<Datetime> {
    let py = obj.py();
    let utc = py.import("datetime")?.getattr("timezone")?.getattr("utc")?;
    let tzinfo = obj.getattr("tzinfo")?;
    let norm = if tzinfo.is_none() {
        obj.clone()
    } else {
        obj.call_method1("astimezone", (utc,))?
    };
    let year: i32 = norm.getattr("year")?.extract()?;
    let month: u32 = norm.getattr("month")?.extract()?;
    let day: u32 = norm.getattr("day")?.extract()?;
    let hour: u32 = norm.getattr("hour")?.extract()?;
    let minute: u32 = norm.getattr("minute")?.extract()?;
    let second: u32 = norm.getattr("second")?.extract()?;
    let micro: u32 = norm.getattr("microsecond")?.extract()?;
    let date = chrono::NaiveDate::from_ymd_opt(year, month, day)
        .ok_or_else(|| PyValueError::new_err("datetime has an invalid date"))?;
    let time = chrono::NaiveTime::from_hms_micro_opt(hour, minute, second, micro)
        .ok_or_else(|| PyValueError::new_err("datetime has an invalid time"))?;
    let ms = chrono::NaiveDateTime::new(date, time).and_utc().timestamp_millis();
    unix_millis_to_datetime(ms)
}

/// Build an aware UTC Python `datetime.datetime` from a core datetime, mirroring
/// the napi `Date` projection (the absolute instant at UTC).
fn core_datetime_to_py<'py>(py: Python<'py>, dt: &Datetime) -> PyResult<Bound<'py, PyAny>> {
    let ms = datetime_to_unix_millis(dt)?;
    let cdt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .ok_or_else(|| PyValueError::new_err("datetime is out of range"))?;
    let dt_mod = py.import("datetime")?;
    let utc = dt_mod.getattr("timezone")?.getattr("utc")?;
    let cls = dt_mod.getattr("datetime")?;
    let micro = cdt.nanosecond() / 1000;
    let args = (
        cdt.year(),
        cdt.month(),
        cdt.day(),
        cdt.hour(),
        cdt.minute(),
        cdt.second(),
        micro,
        utc,
    );
    cls.call1(args)
}

// ── marshalling round-trip + canonical bytes-authority (batch-first) ──────────

/// Round-trip a batch of records through the core, preserving full type
/// fidelity. The whole list crosses the FFI once.
#[pyfunction]
fn roundtrip<'py>(py: Python<'py>, records: &Bound<'py, PyAny>) -> PyResult<Bound<'py, PyList>> {
    let core = py_records_to_values(records)?;
    let out = PyList::empty(py);
    for v in gitsheets_core::echo_batch(core) {
        out.append(value_to_py(py, v)?)?;
    }
    Ok(out)
}

/// Parse a batch of TOML documents into records with full type fidelity.
#[pyfunction]
fn parse_records<'py>(py: Python<'py>, documents: Vec<String>) -> PyResult<Bound<'py, PyList>> {
    match gitsheets_core::parse_batch(documents) {
        Ok(values) => {
            let out = PyList::empty(py);
            for v in values {
                out.append(value_to_py(py, v)?)?;
            }
            Ok(out)
        }
        Err(err) => Err(raise_core_error(py, &err)),
    }
}

/// Serialize a batch of records to their canonical TOML bytes in one call.
#[pyfunction]
fn serialize_records(py: Python<'_>, records: &Bound<'_, PyAny>) -> PyResult<Vec<String>> {
    let values = py_records_to_values(records)?;
    gitsheets_core::serialize_batch(&values).map_err(|err| raise_core_error(py, &err))
}

// ── definition logic: path templates, validation, embedded engine ────────────

/// Render a path template against a batch of records (the template + its embedded
/// snippets compiled once, reused across the batch).
#[pyfunction]
fn render_paths_batch(
    py: Python<'_>,
    template: String,
    records: &Bound<'_, PyAny>,
) -> PyResult<Vec<String>> {
    let values = py_records_to_values(records)?;
    let mut engine = Engine::new().map_err(|err| raise_core_error(py, &err))?;
    let compiled = Template::compile(&template, &mut engine).map_err(|e| raise_core_error(py, &e))?;
    let mut out = Vec::with_capacity(values.len());
    for record in &values {
        out.push(
            compiled
                .render(record, &mut engine)
                .map_err(|e| raise_core_error(py, &e))?,
        );
    }
    Ok(out)
}

/// Validate a batch of records against a JSON Schema (compiled once). Returns the
/// issues per record (an empty inner list ⇒ valid).
#[pyfunction]
fn validate_batch<'py>(
    py: Python<'py>,
    schema: &Bound<'py, PyAny>,
    records: &Bound<'py, PyAny>,
) -> PyResult<Bound<'py, PyList>> {
    let schema_val = py_to_value(schema)?;
    let values = py_records_to_values(records)?;
    let compiled = CompiledSchema::compile(&schema_val).map_err(|e| raise_core_error(py, &e))?;
    let out = PyList::empty(py);
    for record in &values {
        let issues = PyList::empty(py);
        for issue in compiled.validate(record) {
            let d = PyDict::new(py);
            d.set_item("path", issue.path)?;
            d.set_item("message", issue.message)?;
            d.set_item("source", issue.source.as_str())?;
            d.set_item("schema_path", issue.schema_path)?;
            d.set_item("code", issue.code)?;
            issues.append(d)?;
        }
        out.append(issues)?;
    }
    Ok(out)
}

/// Compile a raw-JS sort comparator (`rule`, the body of `(a, b) => { … }`) and
/// run it once against `a`/`b` in the **core's** boa engine — so Python's result
/// matches Node's for the identical snippet.
#[pyfunction]
fn run_comparator(
    py: Python<'_>,
    rule: String,
    a: &Bound<'_, PyAny>,
    b: &Bound<'_, PyAny>,
) -> PyResult<f64> {
    let a_val = py_to_value(a)?;
    let b_val = py_to_value(b)?;
    let mut engine = Engine::new().map_err(|err| raise_core_error(py, &err))?;
    let wrapped = format!("(a, b) => {{ {rule} }}");
    let handle = engine.compile(&wrapped).map_err(|e| raise_core_error(py, &e))?;
    let result = engine
        .call(handle, &[a_val, b_val])
        .map_err(|e| PyRuntimeError::new_err(format!("{e:?}")))?;
    engine.to_number(&result).map_err(|e| raise_core_error(py, &e))
}

/// A compiled sheet definition: the embedded engine plus the path template (and
/// optional raw-JS sort comparator), compiled once and reused. Holds a `!Send`
/// boa context → `unsendable` (pinned to its creating thread).
#[pyclass(unsendable)]
struct CompiledDefinition {
    engine: Engine,
    template: Template,
    sort_handle: Option<usize>,
}

#[pymethods]
impl CompiledDefinition {
    #[new]
    #[pyo3(signature = (path_template, sort_rule=None))]
    fn new(py: Python<'_>, path_template: String, sort_rule: Option<String>) -> PyResult<Self> {
        let mut engine = Engine::new().map_err(|err| raise_core_error(py, &err))?;
        let template =
            Template::compile(&path_template, &mut engine).map_err(|e| raise_core_error(py, &e))?;
        let sort_handle = match sort_rule {
            Some(rule) => {
                let wrapped = format!("(a, b) => {{ {rule} }}");
                Some(engine.compile(&wrapped).map_err(|e| raise_core_error(py, &e))?)
            }
            None => None,
        };
        Ok(CompiledDefinition {
            engine,
            template,
            sort_handle,
        })
    }

    fn render_path(&mut self, py: Python<'_>, record: &Bound<'_, PyAny>) -> PyResult<String> {
        let value = py_to_value(record)?;
        self.template
            .render(&value, &mut self.engine)
            .map_err(|e| raise_core_error(py, &e))
    }

    fn compare(&mut self, a: &Bound<'_, PyAny>, b: &Bound<'_, PyAny>) -> PyResult<f64> {
        let handle = self
            .sort_handle
            .ok_or_else(|| PyValueError::new_err("definition has no sort rule"))?;
        let a_val = py_to_value(a)?;
        let b_val = py_to_value(b)?;
        let result = self
            .engine
            .call(handle, &[a_val, b_val])
            .map_err(|e| PyRuntimeError::new_err(format!("{e:?}")))?;
        self.engine
            .to_number(&result)
            .map_err(|e| PyRuntimeError::new_err(e.message().to_string()))
    }

    fn snippet_count(&self) -> u32 {
        self.engine.snippet_count() as u32
    }
}

// ── record CRUD + diff/patch over the holo-tree substrate (batch-first) ───────

/// Read a batch of records by path. Each result is the record (a `dict` with full
/// TOML type fidelity) or `None` when no blob lives at that path.
#[pyfunction]
#[pyo3(signature = (git_dir, tree_ref, base, paths, extension=None))]
fn record_read<'py>(
    py: Python<'py>,
    git_dir: String,
    tree_ref: String,
    base: String,
    paths: Vec<String>,
    extension: Option<String>,
) -> PyResult<Bound<'py, PyList>> {
    let ext = extension_of(extension);
    match record::read_records_at_ref(&git_dir, &tree_ref, &base, &paths, &ext) {
        Ok(values) => {
            let out = PyList::empty(py);
            for v in values {
                out.append(opt_value_to_py(py, v)?)?;
            }
            Ok(out)
        }
        Err(err) => Err(raise_core_error(py, &err)),
    }
}

/// Write a batch of records (canonical TOML) under `base` starting from the tree
/// `base_ref`. Returns `{ "tree_hash", "blob_hashes" }`. The bytes come from the
/// core's bytes-authority, so two bindings writing the same record agree
/// byte-for-byte.
#[pyfunction]
#[pyo3(signature = (git_dir, base_ref, base, paths, records, extension=None))]
fn record_write<'py>(
    py: Python<'py>,
    git_dir: String,
    base_ref: String,
    base: String,
    paths: Vec<String>,
    records: &Bound<'py, PyAny>,
    extension: Option<String>,
) -> PyResult<Bound<'py, PyDict>> {
    let values = py_records_to_values(records)?;
    if paths.len() != values.len() {
        return Err(PyValueError::new_err(format!(
            "record_write: paths ({}) and records ({}) length mismatch",
            paths.len(),
            values.len()
        )));
    }
    let items: Vec<(String, Value)> = paths.into_iter().zip(values).collect();
    let ext = extension_of(extension);
    match record::write_records_at_ref(&git_dir, &base_ref, &base, &items, &ext) {
        Ok(outcome) => {
            let d = PyDict::new(py);
            d.set_item("tree_hash", outcome.tree_hash)?;
            d.set_item("blob_hashes", outcome.blob_hashes)?;
            Ok(d)
        }
        Err(err) => Err(raise_core_error(py, &err)),
    }
}

/// Delete a batch of records by path under `base`. Returns
/// `{ "tree_hash", "existed" }`.
#[pyfunction]
#[pyo3(signature = (git_dir, base_ref, base, paths, extension=None))]
fn record_delete<'py>(
    py: Python<'py>,
    git_dir: String,
    base_ref: String,
    base: String,
    paths: Vec<String>,
    extension: Option<String>,
) -> PyResult<Bound<'py, PyDict>> {
    let ext = extension_of(extension);
    match record::delete_records_at_ref(&git_dir, &base_ref, &base, &paths, &ext) {
        Ok(outcome) => {
            let d = PyDict::new(py);
            d.set_item("tree_hash", outcome.tree_hash)?;
            d.set_item("existed", outcome.existed)?;
            Ok(d)
        }
        Err(err) => Err(raise_core_error(py, &err)),
    }
}

/// List every record under `base` in sorted (git-canonical) path order. Each
/// entry is `{ "path", "record" }`.
#[pyfunction]
#[pyo3(signature = (git_dir, tree_ref, base, extension=None))]
fn record_list<'py>(
    py: Python<'py>,
    git_dir: String,
    tree_ref: String,
    base: String,
    extension: Option<String>,
) -> PyResult<Bound<'py, PyList>> {
    let ext = extension_of(extension);
    match record::list_records_at_ref(&git_dir, &tree_ref, &base, &ext) {
        Ok(entries) => {
            let out = PyList::empty(py);
            for (path, rec) in entries {
                let d = PyDict::new(py);
                d.set_item("path", path)?;
                d.set_item("record", value_to_py(py, rec)?)?;
                out.append(d)?;
            }
            Ok(out)
        }
        Err(err) => Err(raise_core_error(py, &err)),
    }
}

/// A snapshot of holo-tree's process-wide tree/blob counters.
#[pyfunction]
fn substrate_stats(py: Python<'_>) -> PyResult<Bound<'_, PyDict>> {
    let s = record::substrate_stats();
    let d = PyDict::new(py);
    d.set_item("trees_read", s.trees_read as i64)?;
    d.set_item("trees_written", s.trees_written as i64)?;
    d.set_item("trees_skipped_clean", s.trees_skipped_clean as i64)?;
    d.set_item("cache_hits", s.cache_hits as i64)?;
    d.set_item("cache_misses", s.cache_misses as i64)?;
    d.set_item("blobs_read", s.blobs_read as i64)?;
    Ok(d)
}

/// Reset the substrate counters + the thread-local tree cache.
#[pyfunction]
fn substrate_reset() {
    record::substrate_reset();
}

// ── diff / patch primitives (RFC 6902 / RFC 7396) ─────────────────────────────

/// Build a Python list of RFC 6902 ops shaped like the `rfc6902` package: a
/// `remove` carries no `value` key, a null-replace carries `value: None`,
/// everything else carries the marshalled value.
fn build_patch_list<'py>(py: Python<'py>, ops: &[PatchOp]) -> PyResult<Bound<'py, PyList>> {
    let list = PyList::empty(py);
    for op in ops {
        let d = PyDict::new(py);
        d.set_item("op", op.op.as_str())?;
        d.set_item("path", op.path.clone())?;
        match &op.value {
            PatchValue::Absent => {}
            PatchValue::Null => d.set_item("value", py.None())?,
            PatchValue::Value(v) => d.set_item("value", value_to_py(py, v.clone())?)?,
        }
        list.append(d)?;
    }
    Ok(list)
}

/// Generate an RFC 6902 JSON Patch transforming `src` into `dst`. `None` on
/// either side is the JSON null `Sheet.diffFrom` passes for an added/deleted
/// record.
#[pyfunction]
#[pyo3(signature = (src=None, dst=None))]
fn create_patch<'py>(
    py: Python<'py>,
    src: Option<&Bound<'py, PyAny>>,
    dst: Option<&Bound<'py, PyAny>>,
) -> PyResult<Bound<'py, PyList>> {
    let src_val = match src {
        Some(o) if !o.is_none() => Some(py_to_value(o)?),
        _ => None,
    };
    let dst_val = match dst {
        Some(o) if !o.is_none() => Some(py_to_value(o)?),
        _ => None,
    };
    let ops = gitsheets_core::create_patch(src_val.as_ref(), dst_val.as_ref());
    build_patch_list(py, &ops)
}

/// Parse a Python object into an RFC 7396 merge patch: `None` ⇒ delete, a `dict`
/// ⇒ recursive merge, anything else ⇒ wholesale replace.
fn py_to_merge_patch(obj: &Bound<'_, PyAny>) -> PyResult<MergePatch> {
    if obj.is_none() {
        return Ok(MergePatch::Delete);
    }
    if let Ok(d) = obj.cast::<PyDict>() {
        // A datetime is a dict? No — only plain dicts merge; datetimes are caught
        // by py_to_value below. (PyDict downcast only matches real dicts.)
        let mut map = IndexMap::new();
        for (k, v) in d.iter() {
            let key: String = k
                .extract()
                .map_err(|_| PyTypeError::new_err("merge-patch keys must be strings"))?;
            map.insert(key, py_to_merge_patch(&v)?);
        }
        return Ok(MergePatch::Merge(map));
    }
    Ok(MergePatch::Replace(py_to_value(obj)?))
}

/// Apply an RFC 7396 JSON Merge Patch to `target` (`None` ⇒ absent). Returns the
/// merged record, or `None` only when the patch deletes the record outright.
#[pyfunction]
#[pyo3(signature = (target, patch))]
fn apply_merge_patch<'py>(
    py: Python<'py>,
    target: Option<&Bound<'py, PyAny>>,
    patch: &Bound<'py, PyAny>,
) -> PyResult<Bound<'py, PyAny>> {
    let target_val = match target {
        Some(o) if !o.is_none() => Some(py_to_value(o)?),
        _ => None,
    };
    let merge = py_to_merge_patch(patch)?;
    let merged = gitsheets_core::apply_merge_patch(target_val.as_ref(), &merge);
    opt_value_to_py(py, merged)
}

/// Diff records between two trees (`src_ref` → `dst_ref`) under `base`, returning
/// one entry per change with `status`, `src_hash`/`dst_hash`, the parsed
/// `src`/`dst` records, and the RFC 6902 `patch`.
#[pyfunction]
#[pyo3(signature = (git_dir, src_ref, dst_ref, base, extension=None))]
fn diff_records<'py>(
    py: Python<'py>,
    git_dir: String,
    src_ref: String,
    dst_ref: String,
    base: String,
    extension: Option<String>,
) -> PyResult<Bound<'py, PyList>> {
    let ext = extension_of(extension);
    let diffs = record::diff_records_at_refs(&git_dir, &src_ref, &dst_ref, &base, &ext)
        .map_err(|e| raise_core_error(py, &e))?;
    let out = PyList::empty(py);
    for d in diffs {
        let obj = PyDict::new(py);
        obj.set_item("path", d.change.path)?;
        obj.set_item("status", d.change.status.as_str())?;
        obj.set_item("src_hash", d.change.src_hash)?;
        obj.set_item("dst_hash", d.change.dst_hash)?;
        obj.set_item("src", opt_value_to_py(py, d.src)?)?;
        obj.set_item("dst", opt_value_to_py(py, d.dst)?)?;
        obj.set_item("patch", build_patch_list(py, &d.patch)?)?;
        out.append(obj)?;
    }
    Ok(out)
}

// ── query traversal + filtering ───────────────────────────────────────────────

fn parse_filter(obj: &Bound<'_, PyDict>, engine: &mut Engine) -> PyResult<Filter> {
    let mut filter = Filter::new();
    for (k, v) in obj.iter() {
        let key: String = k
            .extract()
            .map_err(|_| PyTypeError::new_err("filter keys must be strings"))?;
        filter.push(key, parse_filter_pred(&v, engine)?);
    }
    Ok(filter)
}

fn parse_filter_pred(val: &Bound<'_, PyAny>, engine: &mut Engine) -> PyResult<FilterPred> {
    if let Ok(d) = val.cast::<PyDict>() {
        if let Some(pred) = d.get_item("$pred")? {
            if let Ok(s) = pred.cast::<PyString>() {
                let src = s.extract::<String>()?;
                let wrapped = format!("(value, record) => ( {src} )");
                let handle = engine
                    .compile(&wrapped)
                    .map_err(|e| raise_core_error(val.py(), &e))?;
                return Ok(FilterPred::Predicate(handle));
            }
        }
        let nested = parse_filter(d, engine)?;
        return Ok(FilterPred::Nested(nested));
    }
    Ok(FilterPred::Equals(py_to_value(val)?))
}

/// Query records under `base` in the tree `tree_ref`, returning each matched
/// `{ "path", "record" }` in sorted path order. The template prunes the walk; the
/// filter (equality / nested / `{"$pred": "<js>"}` snippets) runs in the core.
#[pyfunction]
#[pyo3(signature = (git_dir, tree_ref, base, template, filter, extension=None))]
fn record_query<'py>(
    py: Python<'py>,
    git_dir: String,
    tree_ref: String,
    base: String,
    template: String,
    filter: &Bound<'py, PyDict>,
    extension: Option<String>,
) -> PyResult<Bound<'py, PyList>> {
    let ext = extension_of(extension);
    let repo = record::open_repo(&git_dir).map_err(|e| raise_core_error(py, &e))?;
    let mut tree = record::resolve_tree(&repo, &tree_ref).map_err(|e| raise_core_error(py, &e))?;
    let mut engine = Engine::new().map_err(|e| raise_core_error(py, &e))?;
    let compiled = Template::compile(&template, &mut engine).map_err(|e| raise_core_error(py, &e))?;
    let parsed = parse_filter(filter, &mut engine)?;
    match query::query_records(&repo, &mut tree, &base, &compiled, &parsed, &mut engine, &ext) {
        Ok(rows) => {
            let out = PyList::empty(py);
            for (path, rec) in rows {
                let d = PyDict::new(py);
                d.set_item("path", path)?;
                d.set_item("record", value_to_py(py, rec)?)?;
                out.append(d)?;
            }
            Ok(out)
        }
        Err(err) => Err(raise_core_error(py, &err)),
    }
}

/// The pruning candidate set alone (no content filter) — the `Template.queryTree`
/// parity target. `query` is a partial record of the path-template input fields.
#[pyfunction]
#[pyo3(signature = (git_dir, tree_ref, base, template, query, extension=None))]
fn record_query_candidates(
    py: Python<'_>,
    git_dir: String,
    tree_ref: String,
    base: String,
    template: String,
    query: &Bound<'_, PyAny>,
    extension: Option<String>,
) -> PyResult<Vec<String>> {
    let ext = extension_of(extension);
    let query_val = py_to_value(query)?;
    let repo = record::open_repo(&git_dir).map_err(|e| raise_core_error(py, &e))?;
    let mut tree = record::resolve_tree(&repo, &tree_ref).map_err(|e| raise_core_error(py, &e))?;
    let mut engine = Engine::new().map_err(|e| raise_core_error(py, &e))?;
    let compiled = Template::compile(&template, &mut engine).map_err(|e| raise_core_error(py, &e))?;
    query::query_candidate_paths(&repo, &mut tree, &base, &compiled, &query_val, &mut engine, &ext)
        .map_err(|e| raise_core_error(py, &e))
}

/// The record fields that contribute to rendering `template` (the query
/// auto-derivation set).
#[pyfunction]
fn template_field_names(py: Python<'_>, template: String) -> PyResult<Vec<String>> {
    let mut engine = Engine::new().map_err(|e| raise_core_error(py, &e))?;
    let compiled = Template::compile(&template, &mut engine).map_err(|e| raise_core_error(py, &e))?;
    Ok(compiled.get_field_names())
}

// ── secondary indexing ─────────────────────────────────────────────────────────

/// Build a unique index over the records under `base` and look up each key.
/// `results[i]` is the record for `keys[i]`, or `None`.
#[pyfunction]
#[pyo3(signature = (git_dir, tree_ref, base, key_snippet, keys, extension=None))]
fn record_index_unique<'py>(
    py: Python<'py>,
    git_dir: String,
    tree_ref: String,
    base: String,
    key_snippet: String,
    keys: Vec<String>,
    extension: Option<String>,
) -> PyResult<Bound<'py, PyList>> {
    let ext = extension_of(extension);
    let records = record::list_records_at_ref(&git_dir, &tree_ref, &base, &ext)
        .map_err(|e| raise_core_error(py, &e))?;
    let mut engine = Engine::new().map_err(|e| raise_core_error(py, &e))?;
    let handle = engine.compile(&key_snippet).map_err(|e| raise_core_error(py, &e))?;
    let index =
        UniqueIndex::build(&records, handle, &mut engine).map_err(|e| raise_core_error(py, &e))?;
    let out = PyList::empty(py);
    for k in &keys {
        out.append(opt_value_to_py(py, index.lookup(k).cloned())?)?;
    }
    Ok(out)
}

/// Build a non-unique index over the records under `base` and look up each key.
/// `results[i]` is every record carrying `keys[i]` (an empty list when none).
#[pyfunction]
#[pyo3(signature = (git_dir, tree_ref, base, key_snippet, keys, extension=None))]
fn record_index_multi<'py>(
    py: Python<'py>,
    git_dir: String,
    tree_ref: String,
    base: String,
    key_snippet: String,
    keys: Vec<String>,
    extension: Option<String>,
) -> PyResult<Bound<'py, PyList>> {
    let ext = extension_of(extension);
    let records = record::list_records_at_ref(&git_dir, &tree_ref, &base, &ext)
        .map_err(|e| raise_core_error(py, &e))?;
    let mut engine = Engine::new().map_err(|e| raise_core_error(py, &e))?;
    let handle = engine.compile(&key_snippet).map_err(|e| raise_core_error(py, &e))?;
    let index =
        MultiIndex::build(&records, handle, &mut engine).map_err(|e| raise_core_error(py, &e))?;
    let out = PyList::empty(py);
    for k in &keys {
        let inner = PyList::empty(py);
        for (_, rec) in index.lookup(k) {
            inner.append(value_to_py(py, rec.clone())?)?;
        }
        out.append(inner)?;
    }
    Ok(out)
}

// ── orchestration: Sheet / Transaction / Store ────────────────────────────────

/// A live transaction driving the core's state machine, exposing the two-phase
/// consumer-validator protocol. Holds a `!Send` `Transaction` (repo + private
/// tree) → `unsendable` (pinned to its creating thread).
#[pyclass(unsendable)]
struct CoreTransaction {
    inner: Option<Transaction>,
    sheets: HashMap<String, CoreSheet>,
    pending: HashMap<String, UpsertCandidate>,
}

#[pymethods]
impl CoreTransaction {
    /// Open a transaction against `git_dir`. `author`/`committer` are
    /// `(name, email)` tuples; `trailers` a list of `(key, value)` tuples. A
    /// concurrent open on the same repo raises `TransactionError`.
    #[staticmethod]
    #[pyo3(signature = (git_dir, message, time_seconds, offset_minutes=0, parent=None, branch=None, author=None, committer=None, trailers=None))]
    #[allow(clippy::too_many_arguments)]
    fn begin(
        py: Python<'_>,
        git_dir: String,
        message: String,
        time_seconds: i64,
        offset_minutes: i32,
        parent: Option<String>,
        branch: Option<String>,
        author: Option<(String, String)>,
        committer: Option<(String, String)>,
        trailers: Option<Vec<(String, String)>>,
    ) -> PyResult<Self> {
        let core_opts = TransactionOptions {
            parent,
            branch,
            author: author.map(|(name, email)| CoreAuthor { name, email }),
            committer: committer.map(|(name, email)| CoreAuthor { name, email }),
            message,
            trailers: trailers.unwrap_or_default(),
            time_seconds,
            offset_minutes,
        };
        match Transaction::begin(&git_dir, core_opts) {
            Ok(tx) => Ok(CoreTransaction {
                inner: Some(tx),
                sheets: HashMap::new(),
                pending: HashMap::new(),
            }),
            Err(err) => Err(raise_core_error(py, &err)),
        }
    }

    /// Open a sheet against this transaction's tree (config read + template /
    /// schema / sort comparators compiled once).
    fn open_sheet(
        &mut self,
        py: Python<'_>,
        name: String,
        config_path: String,
        open_root: String,
        prefix: String,
    ) -> PyResult<()> {
        let Self { inner, sheets, .. } = self;
        let tx = inner
            .as_mut()
            .ok_or_else(|| PyRuntimeError::new_err("transaction is already finalized"))?;
        let (repo, tree) = tx.split();
        match CoreSheet::open(repo, tree, &name, &config_path, &open_root, &prefix) {
            Ok(sheet) => {
                sheets.insert(name, sheet);
                Ok(())
            }
            Err(err) => Err(raise_core_error(py, &err)),
        }
    }

    /// Phase 1 (non-mutating): returns `{ "path", "next_text", "record" }` for the
    /// host validator and stashes the candidate for `stage_upsert`. A JSON-Schema
    /// rejection raises `ValidationError` here, before any bytes are written.
    #[pyo3(signature = (name, record, previous_path=None))]
    fn prepare_upsert<'py>(
        &mut self,
        py: Python<'py>,
        name: String,
        record: &Bound<'py, PyAny>,
        previous_path: Option<String>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let record_val = py_to_value(record)?;
        let Self {
            inner,
            sheets,
            pending,
        } = self;
        let tx = inner
            .as_mut()
            .ok_or_else(|| PyRuntimeError::new_err("transaction is already finalized"))?;
        let (repo, tree) = tx.split();
        let sheet = sheets
            .get_mut(&name)
            .ok_or_else(|| PyValueError::new_err(format!("sheet {name:?} not opened")))?;
        let candidate = sheet
            .prepare_upsert(repo, tree, &record_val, previous_path, false)
            .map_err(|e| raise_core_error(py, &e))?;

        let d = PyDict::new(py);
        d.set_item("path", candidate.record_path.clone())?;
        d.set_item("next_text", candidate.next_text.clone())?;
        d.set_item("record", value_to_py(py, candidate.normalized.clone())?)?;
        pending.insert(name, candidate);
        Ok(d)
    }

    /// Phase 3 (mutating): write the stashed candidate from the last
    /// `prepare_upsert` for `name`. Returns `{ "blob_hash", "path" }`.
    fn stage_upsert<'py>(&mut self, py: Python<'py>, name: String) -> PyResult<Bound<'py, PyDict>> {
        let Self {
            inner,
            sheets,
            pending,
        } = self;
        let candidate = pending
            .remove(&name)
            .ok_or_else(|| PyValueError::new_err(format!("no prepared candidate for sheet {name:?}")))?;
        let tx = inner
            .as_mut()
            .ok_or_else(|| PyRuntimeError::new_err("transaction is already finalized"))?;
        let outcome = {
            let (repo, tree) = tx.split();
            let sheet = sheets
                .get_mut(&name)
                .ok_or_else(|| PyValueError::new_err(format!("sheet {name:?} not opened")))?;
            sheet
                .stage_upsert(repo, tree, &candidate)
                .map_err(|e| raise_core_error(py, &e))?
        };
        tx.mark_mutated();
        let d = PyDict::new(py);
        d.set_item("blob_hash", outcome.blob_hash)?;
        d.set_item("path", outcome.path)?;
        Ok(d)
    }

    /// Pre-flight idempotency check (`Sheet.willChange`). Non-mutating. Returns
    /// `{ "changed", "path", "current_blob_hash", "next_text" }`.
    #[pyo3(signature = (name, record, previous_path=None))]
    fn will_change<'py>(
        &mut self,
        py: Python<'py>,
        name: String,
        record: &Bound<'py, PyAny>,
        previous_path: Option<String>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let record_val = py_to_value(record)?;
        let Self { inner, sheets, .. } = self;
        let tx = inner
            .as_mut()
            .ok_or_else(|| PyRuntimeError::new_err("transaction is already finalized"))?;
        let (repo, tree) = tx.split();
        let sheet = sheets
            .get_mut(&name)
            .ok_or_else(|| PyValueError::new_err(format!("sheet {name:?} not opened")))?;
        let wc = sheet
            .will_change(repo, tree, &record_val, previous_path, false)
            .map_err(|e| raise_core_error(py, &e))?;
        let d = PyDict::new(py);
        d.set_item("changed", wc.changed)?;
        d.set_item("path", wc.path)?;
        d.set_item("current_blob_hash", wc.current_blob_hash)?;
        d.set_item("next_text", wc.next_text)?;
        Ok(d)
    }

    /// Delete a record by its sheet-relative path (mutating). Raises
    /// `NotFoundError` when absent.
    fn delete(&mut self, py: Python<'_>, name: String, record_path: String) -> PyResult<()> {
        let Self { inner, sheets, .. } = self;
        let tx = inner
            .as_mut()
            .ok_or_else(|| PyRuntimeError::new_err("transaction is already finalized"))?;
        {
            let (repo, tree) = tx.split();
            let sheet = sheets
                .get_mut(&name)
                .ok_or_else(|| PyValueError::new_err(format!("sheet {name:?} not opened")))?;
            sheet
                .delete_at_path(repo, tree, &record_path)
                .map_err(|e| raise_core_error(py, &e))?;
        }
        tx.mark_mutated();
        Ok(())
    }

    /// `Sheet.clear` (mutating) — empties the sheet's data subtree.
    fn clear(&mut self, py: Python<'_>, name: String) -> PyResult<()> {
        let Self { inner, sheets, .. } = self;
        let tx = inner
            .as_mut()
            .ok_or_else(|| PyRuntimeError::new_err("transaction is already finalized"))?;
        {
            let (repo, tree) = tx.split();
            let sheet = sheets
                .get_mut(&name)
                .ok_or_else(|| PyValueError::new_err(format!("sheet {name:?} not opened")))?;
            sheet.clear(repo, tree).map_err(|e| raise_core_error(py, &e))?;
        }
        tx.mark_mutated();
        Ok(())
    }

    /// The parent commit hash captured at open (`None` on a fresh repo).
    fn parent_commit_hash(&self) -> Option<String> {
        self.inner.as_ref().and_then(|t| t.parent_commit_hash())
    }

    /// Finalize: commit-on-success-only with no-op detection + `parent_moved`
    /// re-check + CAS ref movement. Returns `{ "commit_hash", "tree_hash",
    /// "ref_name", "parent_commit_hash" }` (a no-op leaves `commit_hash = None`).
    fn finalize<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let tx = self
            .inner
            .take()
            .ok_or_else(|| PyRuntimeError::new_err("transaction is already finalized"))?;
        match tx.finalize() {
            Ok(r) => {
                let d = PyDict::new(py);
                d.set_item("commit_hash", r.commit_hash)?;
                d.set_item("tree_hash", r.tree_hash)?;
                d.set_item("ref_name", r.ref_name)?;
                d.set_item("parent_commit_hash", r.parent_commit_hash)?;
                Ok(d)
            }
            Err(err) => Err(raise_core_error(py, &err)),
        }
    }

    /// Discard without committing (handler raised). Releases the writer slot.
    fn discard(&mut self) {
        if let Some(tx) = self.inner.take() {
            tx.discard();
        }
    }
}

/// Discover every sheet declared in `<open_root>/.gitsheets/*.toml` in the tree
/// `tree_ref`. Sorted bare names.
#[pyfunction]
fn core_discover_sheets(
    py: Python<'_>,
    git_dir: String,
    tree_ref: String,
    open_root: String,
) -> PyResult<Vec<String>> {
    let repo = record::open_repo(&git_dir).map_err(|e| raise_core_error(py, &e))?;
    let mut tree = record::resolve_tree(&repo, &tree_ref).map_err(|e| raise_core_error(py, &e))?;
    store::discover_sheets(&repo, &mut tree, &open_root).map_err(|e| raise_core_error(py, &e))
}

/// The `open_store` `config_missing` check: every validator must name a declared
/// sheet. Raises `ConfigError` otherwise.
#[pyfunction]
fn core_check_validators(
    py: Python<'_>,
    declared: Vec<String>,
    validator_names: Vec<String>,
) -> PyResult<()> {
    store::check_validators(&declared, &validator_names).map_err(|e| raise_core_error(py, &e))
}

/// Raise the typed exception for a given stable error `code` — the boundary-test
/// entry point exercising the error-variant → typed-class mapping.
#[pyfunction]
fn simulate_core_error(py: Python<'_>, code: String) -> PyResult<()> {
    match gitsheets_core::example_error(&code) {
        Some(err) => Err(raise_core_error(py, &err)),
        None => Err(PyValueError::new_err(format!("unknown error code '{code}'"))),
    }
}

// ── module ────────────────────────────────────────────────────────────────────

#[pymodule]
fn _gitsheets(m: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = m.py();

    // Typed exceptions.
    m.add("GitsheetsError", py.get_type::<GitsheetsError>())?;
    m.add("ConfigError", py.get_type::<ConfigError>())?;
    m.add("ValidationError", py.get_type::<ValidationError>())?;
    m.add("TransactionError", py.get_type::<TransactionError>())?;
    m.add("IndexError", py.get_type::<IndexError>())?;
    m.add("RefError", py.get_type::<RefError>())?;
    m.add("PathTemplateError", py.get_type::<PathTemplateError>())?;
    m.add("NotFoundError", py.get_type::<NotFoundError>())?;

    // Stateful classes.
    m.add_class::<CompiledDefinition>()?;
    m.add_class::<CoreTransaction>()?;

    // Functions.
    m.add_function(wrap_pyfunction!(roundtrip, m)?)?;
    m.add_function(wrap_pyfunction!(parse_records, m)?)?;
    m.add_function(wrap_pyfunction!(serialize_records, m)?)?;
    m.add_function(wrap_pyfunction!(render_paths_batch, m)?)?;
    m.add_function(wrap_pyfunction!(validate_batch, m)?)?;
    m.add_function(wrap_pyfunction!(run_comparator, m)?)?;
    m.add_function(wrap_pyfunction!(record_read, m)?)?;
    m.add_function(wrap_pyfunction!(record_write, m)?)?;
    m.add_function(wrap_pyfunction!(record_delete, m)?)?;
    m.add_function(wrap_pyfunction!(record_list, m)?)?;
    m.add_function(wrap_pyfunction!(substrate_stats, m)?)?;
    m.add_function(wrap_pyfunction!(substrate_reset, m)?)?;
    m.add_function(wrap_pyfunction!(create_patch, m)?)?;
    m.add_function(wrap_pyfunction!(apply_merge_patch, m)?)?;
    m.add_function(wrap_pyfunction!(diff_records, m)?)?;
    m.add_function(wrap_pyfunction!(record_query, m)?)?;
    m.add_function(wrap_pyfunction!(record_query_candidates, m)?)?;
    m.add_function(wrap_pyfunction!(template_field_names, m)?)?;
    m.add_function(wrap_pyfunction!(record_index_unique, m)?)?;
    m.add_function(wrap_pyfunction!(record_index_multi, m)?)?;
    m.add_function(wrap_pyfunction!(core_discover_sheets, m)?)?;
    m.add_function(wrap_pyfunction!(core_check_validators, m)?)?;
    m.add_function(wrap_pyfunction!(simulate_core_error, m)?)?;

    Ok(())
}
