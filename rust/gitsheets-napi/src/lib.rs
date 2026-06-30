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
use gitsheets_core::{Datetime, Value};
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
