//! TOML parse + serialize + canonical normalization — the **bytes-authority**.
//!
//! This module is where gitsheets decides the exact on-disk bytes of a record.
//! Per [`specs/rust-core.md`](../../../specs/rust-core.md), anything that
//! determines on-disk bytes lives in the core so every language binding agrees
//! byte-for-byte; this is that machinery, re-implementing the canonical-form
//! rules of [`specs/behaviors/normalization.md`](../../../specs/behaviors/normalization.md)
//! in Rust on top of the core [`Value`].
//!
//! ## What "canonical" means here
//!
//! - **Deep key sort.** Table keys are sorted alphabetically, recursively. This
//!   falls out for free from the `toml` crate's default [`toml::Table`] being a
//!   `BTreeMap`, and is also exposed explicitly as [`normalize`] for callers
//!   that need a sorted [`Value`] without serializing.
//! - **`toml`-crate default formatting.** Multiline strings stay triple-quoted
//!   and readable, strings containing `"` use literal single-quotes — matching
//!   the previous `@iarna/toml` canonical form. (Decided in
//!   [#196](https://github.com/JarvusInnovations/gitsheets/issues/196); the one
//!   sanctioned byte change vs `@iarna` is integer-underscore normalization,
//!   `31_618` → `31618`, because gitsheets always serializes *fresh* from a
//!   `Value` rather than format-preserving the source.)
//! - **Array order is preserved.** Insertion order is the default per the
//!   normalization spec; declared array-sort rules are a sheet-config concern
//!   owned by the record engine, not this byte layer.
//!
//! Serialization is the inverse of parsing for any value that originated from
//! TOML, and is **idempotent**: `serialize(parse(serialize(v))) == serialize(v)`.

use crate::error::{Error, Result};
use crate::value::{Datetime, Value};
use indexmap::IndexMap;
use toml::Value as TomlValue;

/// Parse a TOML document into a core [`Value`] (always a [`Value::Table`] at the
/// top level, as TOML documents are tables).
///
/// Lossless: integer/float distinction and all four datetime kinds are
/// preserved (the value type carries them; see [`crate::value`]). A malformed
/// document maps to [`Error::ConfigInvalid`] — the taxonomy's "TOML malformed"
/// bucket. (The record engine may re-map record-vs-config parse failures once a
/// record-specific code exists; `errors.md` has none today.)
pub fn parse(input: &str) -> Result<Value> {
    let toml_value: TomlValue =
        input
            .parse()
            .map_err(|e: toml::de::Error| Error::ConfigInvalid {
                message: format!("TOML parse failed: {e}"),
            })?;
    Ok(from_toml(toml_value))
}

/// Serialize a core [`Value`] to its canonical TOML bytes: deep key sort +
/// `toml`-crate default formatting (see the module docs).
///
/// The top-level value must be a [`Value::Table`] (TOML documents are tables);
/// anything else — or a value TOML can't represent, e.g. a non-finite float —
/// maps to [`Error::ConfigInvalid`].
pub fn serialize(value: &Value) -> Result<String> {
    let toml_value = to_toml(value);
    toml::to_string(&toml_value).map_err(|e| Error::ConfigInvalid {
        message: format!("TOML serialize failed: {e}"),
    })
}

/// Canonical normalization of a [`Value`] *without* serializing: table keys
/// sorted alphabetically, deep. Arrays keep their order (declared array-sort
/// rules are a sheet-config concern owned by the record engine).
///
/// Idempotent and byte-stable: `normalize(normalize(v)) == normalize(v)`, and
/// [`serialize`] of either yields identical bytes (serialize sorts too, via the
/// `toml` crate's `BTreeMap`-backed table). Exposed for callers — like the
/// record engine — that need the sorted value itself.
pub fn normalize(value: &Value) -> Value {
    match value {
        Value::Table(table) => {
            let mut keys: Vec<&String> = table.keys().collect();
            keys.sort();
            let mut sorted = IndexMap::with_capacity(table.len());
            for key in keys {
                sorted.insert(key.clone(), normalize(&table[key]));
            }
            Value::Table(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(normalize).collect()),
        scalar => scalar.clone(),
    }
}

/// Parse a **batch** of TOML documents in one call, mirroring the foundation's
/// batch-first signatures (the bulk path crosses the FFI once). Fails on the
/// first malformed document.
pub fn parse_batch(inputs: Vec<String>) -> Result<Vec<Value>> {
    inputs.iter().map(|s| parse(s)).collect()
}

/// Serialize a **batch** of values to their canonical TOML bytes in one call.
/// Fails on the first value TOML can't represent.
pub fn serialize_batch(values: &[Value]) -> Result<Vec<String>> {
    values.iter().map(serialize).collect()
}

// ── core Value <-> toml::Value bridge ────────────────────────────────────────

/// Lower a parsed `toml::Value` into the core [`Value`], preserving the
/// integer/float distinction and the precise datetime kind.
fn from_toml(value: TomlValue) -> Value {
    match value {
        TomlValue::String(s) => Value::String(s),
        TomlValue::Integer(i) => Value::Integer(i),
        TomlValue::Float(f) => Value::Float(f),
        TomlValue::Boolean(b) => Value::Boolean(b),
        TomlValue::Datetime(dt) => Value::Datetime(Datetime(dt)),
        TomlValue::Array(items) => Value::Array(items.into_iter().map(from_toml).collect()),
        TomlValue::Table(table) => {
            Value::Table(table.into_iter().map(|(k, v)| (k, from_toml(v))).collect())
        }
    }
}

/// Raise a core [`Value`] into a `toml::Value` for serialization. The `toml`
/// crate's default [`toml::Table`] is a `BTreeMap`, so building tables here
/// **sorts keys** — that is the deep canonical key sort, applied as bytes are
/// produced.
fn to_toml(value: &Value) -> TomlValue {
    match value {
        Value::String(s) => TomlValue::String(s.clone()),
        Value::Integer(i) => TomlValue::Integer(*i),
        Value::Float(f) => TomlValue::Float(*f),
        Value::Boolean(b) => TomlValue::Boolean(*b),
        Value::Datetime(dt) => TomlValue::Datetime(dt.0),
        Value::Array(items) => TomlValue::Array(items.iter().map(to_toml).collect()),
        Value::Table(table) => {
            let mut out = toml::value::Table::new();
            for (key, val) in table {
                out.insert(key.clone(), to_toml(val));
            }
            TomlValue::Table(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_preserves_integer_float_and_datetime_kinds() {
        let v = parse("i = 1\nf = 1.0\nd = 1979-05-27\ndt = 1979-05-27T07:32:00Z\ns = 'x'\n")
            .expect("parse");
        let Value::Table(t) = v else {
            panic!("top level is a table")
        };
        assert_eq!(t["i"], Value::Integer(1));
        assert_eq!(t["f"], Value::Float(1.0));
        assert_eq!(t["i"].type_name(), "integer");
        assert_eq!(t["f"].type_name(), "float");
        assert_eq!(t["d"].type_name(), "datetime");
        assert_eq!(t["dt"].type_name(), "datetime");
    }

    #[test]
    fn serialize_sorts_keys_deep() {
        let input = "slug = 'jane'\nemail = 'jane@x.org'\nfullName = 'Jane'\n";
        let value = parse(input).expect("parse");
        let out = serialize(&value).expect("serialize");
        assert_eq!(
            out,
            "email = \"jane@x.org\"\nfullName = \"Jane\"\nslug = \"jane\"\n"
        );
    }

    #[test]
    fn serialize_sorts_nested_table_keys() {
        let value = parse("[outer]\nz = 1\na = 2\n").expect("parse");
        let out = serialize(&value).expect("serialize");
        assert_eq!(out, "[outer]\na = 2\nz = 1\n");
    }

    #[test]
    fn integer_underscores_are_normalized_away() {
        // The one sanctioned byte change vs @iarna (#196): fresh serialization
        // drops the digit-group underscores.
        let value = parse("legacyId = 31_618\n").expect("parse");
        let out = serialize(&value).expect("serialize");
        assert_eq!(out, "legacyId = 31618\n");
    }

    #[test]
    fn multiline_strings_stay_triple_quoted_not_single_line_escaped() {
        // The outcome #196 says to avoid: readable markdown bodies must NOT
        // collapse to single-line escaped blobs.
        let value = parse("body = \"\"\"\n# Title\n\nA paragraph.\"\"\"\n").expect("parse");
        let out = serialize(&value).expect("serialize");
        assert!(out.contains("\"\"\""), "stays triple-quoted: {out:?}");
        assert!(
            out.contains("\n# Title\n"),
            "newlines stay literal: {out:?}"
        );
    }

    #[test]
    fn normalize_is_idempotent_and_byte_stable() {
        let value = parse("z = 1\na = 2\n[t]\ny = 3\nb = 4\n").expect("parse");
        let once = normalize(&value);
        let twice = normalize(&once);
        assert_eq!(once, twice, "normalize is idempotent");
        assert_eq!(
            serialize(&once).expect("serialize"),
            serialize(&value).expect("serialize"),
            "normalize doesn't change the canonical bytes (serialize already sorts)"
        );
    }

    #[test]
    fn serialize_round_trip_is_idempotent() {
        let original = "b = 2\na = 1\nbody = \"\"\"\nline 1\n\nline 3\"\"\"\nbig = 1000000\n";
        let once = serialize(&parse(original).expect("parse")).expect("serialize");
        let twice = serialize(&parse(&once).expect("parse")).expect("serialize");
        assert_eq!(once, twice, "serialize∘parse∘serialize == serialize");
    }

    #[test]
    fn batch_parse_and_serialize_round_trip() {
        let docs = vec!["a = 1\nb = 2\n".to_string(), "x = 'hi'\n".to_string()];
        let values = parse_batch(docs.clone()).expect("parse batch");
        assert_eq!(values.len(), 2);
        let bytes = serialize_batch(&values).expect("serialize batch");
        assert_eq!(bytes[0], "a = 1\nb = 2\n");
        assert_eq!(bytes[1], "x = \"hi\"\n");
    }

    #[test]
    fn malformed_toml_is_config_invalid() {
        let err = parse("not valid toml = = =\n").unwrap_err();
        assert_eq!(err.code(), "config_invalid");
    }
}
