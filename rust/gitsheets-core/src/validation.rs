//! Persisted-shape validation — JSON Schema, natively in the core.
//!
//! A behavior-preserving Rust port of the host's `ajv`-based first validation
//! layer (`packages/gitsheets/src/validation.ts`), per
//! [`specs/behaviors/validation.md`](../../../specs/behaviors/validation.md).
//! The `[gitsheet.schema]` block is **persisted with the data**, so the shape
//! contract it expresses must be enforced identically by every binding — hence
//! it lives in the core. The *second* layer (the consumer-supplied Standard
//! Schema / Zod / Pydantic validator) legitimately stays in the binding and is
//! out of scope here.
//!
//! ## Engine & ajv-parity
//!
//! Validation runs through the pure-Rust [`jsonschema`] crate, configured to
//! mirror the host `ajv` setup as closely as a different library allows:
//!
//! - **Draft 7** — `ajv` v8's default meta-schema (the gitsheets schemas don't
//!   declare `$schema`), so we pin `Draft::Draft7` rather than let the crate
//!   auto-detect 2020-12.
//! - **Formats asserted** — `ajv-formats` makes `email`/`date-time`/`uri`/`uuid`
//!   assertions; we enable `should_validate_formats(true)` to match (formats are
//!   annotation-only by default in the crate).
//! - **All errors** — `ajv` runs with `allErrors: true`; the crate's
//!   `iter_errors` is likewise exhaustive.
//!
//! Each failure maps to a [`ValidationIssue`] with `source = json-schema`, the
//! instance path split like `ajv`'s `instancePath`, the `schemaPath` (`#`-
//! prefixed to match `ajv`), and a `code` taken from the failing keyword (the
//! last `schemaPath` segment — exactly `ajv`'s `keyword`). Issue *message text*
//! is the one field that legitimately differs between the two libraries; the
//! binding's `ajv-parity.mjs` suite asserts validity + path + keyword parity and
//! excludes prose. Enumerated divergences live in the plan's Notes.

use jsonschema::{Draft, Validator};
use serde_json::Value as Json;

use crate::error::{Error, IssueSource, Result, ValidationIssue};
use crate::value::Value;

/// A schema compiled once (on sheet-open) and reused to validate every record.
pub struct CompiledSchema {
    validator: Validator,
}

impl CompiledSchema {
    /// Compile a `[gitsheet.schema]` block (carried as a core [`Value`]) into a
    /// reusable validator. A schema the crate can't build (bad regex, malformed
    /// structure, …) is a [`Error::ConfigInvalid`] — the config-time failure
    /// bucket, matching the host raising `ConfigError(config_invalid)` when
    /// `ajv.compile` throws.
    ///
    /// **Strict-mode divergence (enumerated):** `ajv` runs `strict: true`, which
    /// rejects *unknown keywords* at compile with `config_invalid`. The
    /// `jsonschema` crate silently ignores unknown keywords instead, so a schema
    /// with a typo'd keyword compiles here where `ajv` would reject it. See the
    /// plan Notes.
    pub fn compile(schema: &Value) -> Result<Self> {
        let json = value_to_json(schema);
        let validator = jsonschema::options()
            .with_draft(Draft::Draft7)
            .should_validate_formats(true)
            .should_ignore_unknown_formats(true)
            .build(&json)
            .map_err(|e| Error::ConfigInvalid {
                message: format!("[gitsheet.schema] failed to compile: {e}"),
            })?;
        Ok(CompiledSchema { validator })
    }

    /// Validate one record, returning every issue (empty ⇒ valid). The caller
    /// wraps a non-empty result in [`Error::ValidationFailed`] (the host's
    /// `ValidationError`); see [`validate_or_error`].
    pub fn validate(&self, record: &Value) -> Vec<ValidationIssue> {
        let json = value_to_json(record);
        let mut issues = Vec::new();
        for err in self.validator.iter_errors(&json) {
            let instance_path = err.instance_path().as_str().to_string();
            let schema_path = err.schema_path().as_str().to_string();
            issues.push(ValidationIssue {
                path: split_pointer(&instance_path),
                message: err.to_string(),
                source: IssueSource::JsonSchema,
                schema_path: Some(format!("#{schema_path}")),
                // ajv's `keyword` is the last schemaPath segment — same here.
                code: keyword_from_schema_path(&schema_path),
            });
        }
        issues
    }

    /// Validate, returning `Ok(())` when valid or [`Error::ValidationFailed`]
    /// carrying all issues — the shape the host surfaces as `ValidationError`.
    pub fn validate_or_error(&self, record: &Value) -> Result<()> {
        let issues = self.validate(record);
        if issues.is_empty() {
            Ok(())
        } else {
            Err(Error::ValidationFailed {
                message: "record failed JSON Schema validation".into(),
                issues,
            })
        }
    }
}

/// Split a JSON-Pointer instance path (`/address/city`, `/tags/0`) into segment
/// strings, exactly like the host's `instancePath.split('/').slice(1)` with
/// `~1`/`~0` unescaping.
fn split_pointer(pointer: &str) -> Vec<String> {
    if pointer.is_empty() {
        return Vec::new();
    }
    pointer
        .split('/')
        .skip(1)
        .map(|seg| seg.replace("~1", "/").replace("~0", "~"))
        .collect()
}

/// The failing keyword — the last segment of the schema path. `ajv` reports
/// exactly this in `err.keyword`.
fn keyword_from_schema_path(schema_path: &str) -> Option<String> {
    schema_path
        .rsplit('/')
        .find(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Marshal a core [`Value`] into a `serde_json::Value` for validation.
///
/// **Datetime divergence (enumerated):** a [`Value::Datetime`] becomes its TOML
/// string form here, whereas the host validates the record with a JS `Date`
/// *object*. So a schema asserting `type: 'string'` + `format: 'date-time'` on a
/// datetime field passes here but the host would see an object. Datetime-typed
/// schema fields are uncommon (the spec's example schemas are string/number);
/// the parity fixtures stay JSON-representable and this case is enumerated.
fn value_to_json(value: &Value) -> Json {
    match value {
        Value::String(s) => Json::String(s.clone()),
        Value::Integer(i) => Json::Number((*i).into()),
        Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(Json::Number)
            .unwrap_or(Json::Null),
        Value::Boolean(b) => Json::Bool(*b),
        Value::Datetime(dt) => Json::String(dt.to_toml_string()),
        Value::Array(items) => Json::Array(items.iter().map(value_to_json).collect()),
        Value::Table(map) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in map {
                obj.insert(k.clone(), value_to_json(v));
            }
            Json::Object(obj)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::parse;

    fn schema() -> Value {
        // The validation.md example, encoded as TOML for convenience.
        parse(
            r#"
type = 'object'
required = ['slug', 'email', 'fullName']
additionalProperties = false

[properties.slug]
type = 'string'
pattern = '^[a-z0-9][a-z0-9-]{1,49}$'

[properties.email]
type = 'string'
format = 'email'

[properties.fullName]
type = 'string'
minLength = 1
maxLength = 120
"#,
        )
        .expect("schema parses")
    }

    fn record(toml: &str) -> Value {
        parse(toml).expect("record parses")
    }

    #[test]
    fn valid_record_has_no_issues() {
        let s = CompiledSchema::compile(&schema()).unwrap();
        let r = record("slug = 'jane'\nemail = 'jane@example.org'\nfullName = 'Jane'\n");
        assert!(s.validate(&r).is_empty());
    }

    #[test]
    fn pattern_violation_reports_keyword_and_path() {
        let s = CompiledSchema::compile(&schema()).unwrap();
        let r = record("slug = 'JANE!'\nemail = 'jane@example.org'\nfullName = 'Jane'\n");
        let issues = s.validate(&r);
        let pattern = issues
            .iter()
            .find(|i| i.code.as_deref() == Some("pattern"))
            .expect("a pattern issue");
        assert_eq!(pattern.path, vec!["slug".to_string()]);
        assert_eq!(pattern.source, IssueSource::JsonSchema);
        assert!(pattern.schema_path.as_deref().unwrap().starts_with('#'));
    }

    #[test]
    fn missing_required_reports_required_keyword() {
        let s = CompiledSchema::compile(&schema()).unwrap();
        let r = record("slug = 'jane'\nfullName = 'Jane'\n");
        let issues = s.validate(&r);
        assert!(issues.iter().any(|i| i.code.as_deref() == Some("required")));
    }

    #[test]
    fn additional_property_is_rejected() {
        let s = CompiledSchema::compile(&schema()).unwrap();
        let r = record(
            "slug = 'jane'\nemail = 'jane@example.org'\nfullName = 'Jane'\nextra = 'nope'\n",
        );
        let issues = s.validate(&r);
        assert!(issues
            .iter()
            .any(|i| i.code.as_deref() == Some("additionalProperties")));
    }

    #[test]
    fn bad_email_format_is_rejected() {
        let s = CompiledSchema::compile(&schema()).unwrap();
        let r = record("slug = 'jane'\nemail = 'not-an-email'\nfullName = 'Jane'\n");
        let issues = s.validate(&r);
        assert!(issues.iter().any(|i| i.code.as_deref() == Some("format")));
    }

    #[test]
    fn validate_or_error_wraps_issues() {
        let s = CompiledSchema::compile(&schema()).unwrap();
        let r = record("slug = 'jane'\n");
        let err = s.validate_or_error(&r).unwrap_err();
        assert_eq!(err.code(), "validation_failed");
        assert!(!err.issues().is_empty());
    }
}
