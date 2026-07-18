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
//!
//! ## Strict-mode keyword rejection (ajv `strict: true` parity)
//!
//! The `jsonschema` crate is *lenient* — it silently ignores unknown/typo'd
//! keywords — whereas the host `ajv` ran with `strict: true`, which rejects an
//! unknown keyword at compile with `ConfigError(config_invalid)`. To keep that
//! persisted-shape guard identical across every binding, [`CompiledSchema::compile`]
//! walks the schema before building it and raises [`Error::ConfigInvalid`] on any
//! keyword outside the known Draft-07 vocabulary (see [`reject_unknown_keywords`]).

use jsonschema::{Draft, Validator};
use serde_json::Value as Json;

use crate::error::{Error, IssueSource, Result, ValidationIssue};
use crate::value::Value;

/// A schema compiled once (on sheet-open) and reused to validate every record.
pub struct CompiledSchema {
    validator: Validator,
    /// Contract names in `allOf` branch order, when this compiled schema is a
    /// contract composition (`specs/behaviors/contracts.md` "Composition and
    /// enforcement"); empty for a bare `[gitsheet.schema]` compile. Used by
    /// [`Self::validate`] to tag an issue's `contract` field by its `allOf`
    /// branch index — empty here means every issue's `contract` is `None`,
    /// so a sheet with no `implements` is byte/behavior-identical to before
    /// contracts existed.
    contract_names: Vec<String>,
}

impl CompiledSchema {
    /// Compile a `[gitsheet.schema]` block (carried as a core [`Value`]) into a
    /// reusable validator. A schema the crate can't build (bad regex, malformed
    /// structure, …) is a [`Error::ConfigInvalid`] — the config-time failure
    /// bucket, matching the host raising `ConfigError(config_invalid)` when
    /// `ajv.compile` throws.
    ///
    /// **Strict-mode parity:** `ajv` runs `strict: true`, which rejects *unknown
    /// keywords* at compile with `config_invalid`. The `jsonschema` crate is
    /// lenient and silently ignores them, so before building we walk the schema
    /// and raise [`Error::ConfigInvalid`] on any keyword outside the known
    /// Draft-07 vocabulary — restoring ajv's strict-mode guard. See
    /// [`reject_unknown_keywords`].
    pub fn compile(schema: &Value) -> Result<Self> {
        let json = value_to_json(schema);
        reject_unknown_keywords(&json)?;
        Ok(CompiledSchema {
            validator: build_validator(&json)?,
            contract_names: Vec::new(),
        })
    }

    /// Build a compiled schema from an already-checked composed `allOf`
    /// document — the contract-composition path
    /// ([`crate::contract::compile_effective_schema`]). Each `allOf` branch
    /// (every declared contract, plus the local `[gitsheet.schema]`) has
    /// already individually passed strict-mode + document-requirement checks
    /// before being wrapped, so this skips re-running [`reject_unknown_keywords`]
    /// on the whole tree. `contract_names` is the ordered list of declared
    /// contract names, aligned with the first N `allOf` branches (the final
    /// branch is always the local schema).
    pub(crate) fn compile_composed(json: Json, contract_names: Vec<String>) -> Result<Self> {
        Ok(CompiledSchema {
            validator: build_validator(&json)?,
            contract_names,
        })
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
            let contract = self.contract_for_schema_path(&schema_path);
            issues.push(ValidationIssue {
                path: split_pointer(&instance_path),
                message: err.to_string(),
                source: IssueSource::JsonSchema,
                schema_path: Some(format!("#{schema_path}")),
                // ajv's `keyword` is the last schemaPath segment — same here.
                code: keyword_from_schema_path(&schema_path),
                contract,
                // Single-record write-time validation — no multi-record report.
                record: None,
            });
        }
        issues
    }

    /// Which declared contract (if any) a failing `allOf` branch belongs to,
    /// by parsing the `/allOf/<i>` prefix `jsonschema` reports in
    /// `schema_path` for an `allOf`-composed validator. `None` when this
    /// schema isn't a contract composition, or the branch index is the final
    /// (local-schema) branch.
    fn contract_for_schema_path(&self, schema_path: &str) -> Option<String> {
        if self.contract_names.is_empty() {
            return None;
        }
        let mut parts = schema_path.trim_start_matches('/').split('/');
        if parts.next() != Some("allOf") {
            return None;
        }
        let idx: usize = parts.next()?.parse().ok()?;
        self.contract_names.get(idx).cloned()
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

/// Build a `jsonschema` [`Validator`] from an already-vocabulary-checked JSON
/// document, configured to mirror the host `ajv` setup (see the module docs):
/// Draft 7 pinned, formats asserted, unknown formats ignored (not rejected). A
/// build failure (bad regex, malformed structure, an incoherent composition)
/// is [`Error::ConfigInvalid`].
fn build_validator(json: &Json) -> Result<Validator> {
    jsonschema::options()
        .with_draft(Draft::Draft7)
        .should_validate_formats(true)
        .should_ignore_unknown_formats(true)
        .build(json)
        .map_err(|e| Error::ConfigInvalid {
            message: format!("schema failed to compile: {e}"),
        })
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
pub(crate) fn value_to_json(value: &Value) -> Json {
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

// --- Strict-mode unknown-keyword rejection (ajv `strict: true` parity) --------

/// How a known keyword's value nests further subschemas — so the walker descends
/// *into subschemas* (checking their keywords) without ever mistaking a data
/// position (a `properties` name, an `enum` value, a `default`) for a keyword.
enum Descent {
    /// The value carries no subschema (data / scalar / plain array). Don't recurse.
    None,
    /// The value *is* a subschema (`not`, `if`, `additionalProperties`, …).
    Schema,
    /// The value is an array of subschemas (`allOf`, `anyOf`, `oneOf`).
    SchemaArray,
    /// The value is an object whose *values* are subschemas and whose keys are
    /// arbitrary (`properties`, `patternProperties`, `definitions`, `$defs`,
    /// `dependentSchemas`).
    SchemaMap,
    /// `items`: either a single subschema or an array of subschemas (tuple form).
    Items,
    /// `dependencies`: an object whose values are *either* a subschema or a plain
    /// array of property-name strings (the latter carries no subschema).
    Dependencies,
}

/// The known Draft-07 keyword vocabulary (plus the annotation/`$`-core keywords
/// `ajv` accepts), mapped to how each descends. A key absent from this table in a
/// schema position is an *unknown keyword* → rejected, matching ajv `strict:true`.
fn keyword_descent(keyword: &str) -> Option<Descent> {
    Some(match keyword {
        // Core / meta / annotation (data-valued — no subschema to descend).
        "$schema" | "$id" | "$ref" | "$comment" | "$anchor" | "$recursiveRef"
        | "$recursiveAnchor" | "$dynamicRef" | "$dynamicAnchor" | "$vocabulary"
        | "title" | "description" | "default" | "examples" | "deprecated"
        | "readOnly" | "writeOnly" => Descent::None,
        // Validation assertions (all data-valued).
        "type" | "enum" | "const" | "multipleOf" | "maximum" | "exclusiveMaximum"
        | "minimum" | "exclusiveMinimum" | "maxLength" | "minLength" | "pattern"
        | "maxItems" | "minItems" | "uniqueItems" | "maxContains" | "minContains"
        | "maxProperties" | "minProperties" | "required" | "dependentRequired"
        | "format" | "contentMediaType" | "contentEncoding" => Descent::None,
        // Applicators whose value is a single subschema.
        "additionalProperties" | "additionalItems" | "propertyNames" | "contains"
        | "if" | "then" | "else" | "not" | "contentSchema" => Descent::Schema,
        // Applicators whose value is an array of subschemas.
        "allOf" | "anyOf" | "oneOf" => Descent::SchemaArray,
        // Applicators whose value is an object of subschemas (arbitrary keys).
        "properties" | "patternProperties" | "definitions" | "$defs"
        | "dependentSchemas" => Descent::SchemaMap,
        "items" => Descent::Items,
        "dependencies" => Descent::Dependencies,
        _ => return None,
    })
}

/// Walk every `(keyword, value)` pair in schema position across the whole
/// document — the root schema and every genuine subschema reached through
/// [`keyword_descent`]'s known applicators — invoking `visit` for each pair
/// before descending. Shared skeleton for [`reject_unknown_keywords`] (ajv
/// `strict: true` parity) and the contract document-requirement checks
/// (self-containment / openness / null-bearing-keyword rejection — see
/// [`crate::contract`]): both need the identical "never misread a data
/// position as a keyword" descent rules the plan calls for
/// (`plans/contracts-core.md` "Openness detection depth"), just with a
/// different per-keyword predicate.
///
/// A subschema may be a boolean (`true`/`false`) — nothing to visit there. An
/// *unknown* keyword (one [`keyword_descent`] doesn't recognize) is still
/// visited — `visit` decides whether that's an error — but the walk can't
/// descend into its value (unknown shape), so it simply doesn't recurse past
/// it.
pub(crate) fn walk_schema(
    schema: &Json,
    visit: &mut impl FnMut(&str, &Json) -> Result<()>,
) -> Result<()> {
    let Json::Object(map) = schema else {
        return Ok(());
    };
    for (key, value) in map {
        visit(key, value)?;
        let Some(descent) = keyword_descent(key) else {
            continue;
        };
        match descent {
            Descent::None => {}
            Descent::Schema => walk_schema(value, visit)?,
            Descent::SchemaArray => {
                if let Json::Array(items) = value {
                    for item in items {
                        walk_schema(item, visit)?;
                    }
                }
            }
            Descent::SchemaMap => {
                if let Json::Object(subs) = value {
                    for sub in subs.values() {
                        walk_schema(sub, visit)?;
                    }
                }
            }
            Descent::Items => match value {
                Json::Array(items) => {
                    for item in items {
                        walk_schema(item, visit)?;
                    }
                }
                other => walk_schema(other, visit)?,
            },
            Descent::Dependencies => {
                if let Json::Object(deps) = value {
                    for dep in deps.values() {
                        // A string-array dependency carries no subschema; only an
                        // object/bool dependency is a subschema to descend.
                        if !dep.is_array() {
                            walk_schema(dep, visit)?;
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// Walk a compiled schema and reject any keyword outside [`keyword_descent`]'s
/// known Draft-07 vocabulary with [`Error::ConfigInvalid`] — the config-time
/// bucket the host surfaces as `ConfigError(config_invalid)`, restoring ajv
/// `strict: true`'s unknown-keyword guard. Recurses only through genuine
/// subschema positions, so `properties` names, `enum`/`const` values, `required`
/// entries, and `default`s are never misread as keywords.
pub(crate) fn reject_unknown_keywords(schema: &Json) -> Result<()> {
    walk_schema(schema, &mut |key, _value| {
        if keyword_descent(key).is_none() {
            Err(Error::ConfigInvalid {
                message: format!(
                    "[gitsheet.schema] unknown JSON Schema keyword '{key}' \
                     (strict mode rejects unrecognized keywords)"
                ),
            })
        } else {
            Ok(())
        }
    })
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

    // --- Strict-mode unknown-keyword rejection (ajv `strict: true` parity) ---

    #[test]
    fn unknown_top_level_keyword_is_config_invalid() {
        // The restored strict-mode gate: `frobnicate` is not a JSON Schema
        // keyword — ajv `strict:true` rejects it at compile, and so must we.
        let s = parse("type = 'object'\nfrobnicate = true\n").expect("parses");
        let err = match CompiledSchema::compile(&s) {
            Ok(_) => panic!("unknown keyword should be rejected"),
            Err(e) => e,
        };
        assert_eq!(err.code(), "config_invalid");
        assert!(err.to_string().contains("frobnicate"));
    }

    #[test]
    fn unknown_keyword_inside_a_property_is_config_invalid() {
        // A typo'd keyword nested in a property subschema is still caught.
        let s = parse(
            "type = 'object'\n[properties.slug]\ntype = 'string'\nmaxLenght = 5\n",
        )
        .expect("parses");
        let err = match CompiledSchema::compile(&s) {
            Ok(_) => panic!("nested unknown keyword should be rejected"),
            Err(e) => e,
        };
        assert_eq!(err.code(), "config_invalid");
        assert!(err.to_string().contains("maxLenght"));
    }

    #[test]
    fn known_vocabulary_including_combinators_compiles() {
        // Exercises applicators (allOf/oneOf/not/if/then/else/items/$defs) and
        // data-valued keywords (enum/const/default) so none is misread as an
        // unknown keyword and no data position (enum values, property names,
        // required entries) trips the walker.
        let s = parse(
            r#"
type = 'object'
required = ['status']
default = { status = 'draft' }
[properties.status]
enum = ['draft', 'active', 'archived']
[properties.tags]
type = 'array'
items = { type = 'string' }
[properties.score]
const = 42
[[allOf]]
type = 'object'
[[oneOf]]
required = ['status']
[properties.nested]
[properties.nested.not]
type = 'null'
[definitions.reusable]
type = 'string'
[if]
required = ['status']
[then]
type = 'object'
"#,
        )
        .expect("parses");
        CompiledSchema::compile(&s).expect("known vocabulary compiles");
    }

    #[test]
    fn keyword_named_as_a_property_is_not_a_keyword() {
        // `frobnicate` here is a *property name*, not a keyword — it must NOT be
        // rejected (matches ajv: property names are data positions).
        let s = parse(
            "type = 'object'\n[properties.frobnicate]\ntype = 'boolean'\n",
        )
        .expect("parses");
        CompiledSchema::compile(&s).expect("property named like a keyword compiles");
    }
}
