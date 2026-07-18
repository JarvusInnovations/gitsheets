//! Schema contracts — declaration, the vendored store, and composed
//! enforcement.
//!
//! A behavior-preserving Rust implementation of
//! [`specs/behaviors/contracts.md`](../../../specs/behaviors/contracts.md):
//! name validation + the derived vendored path, loading a vendored contract
//! document from the committed tree with its document requirements enforced,
//! `allOf` composition into a sheet's effective write-time JSON Schema, and
//! the `canonical_contract_hash` identity primitive. Consumer verification
//! (`openSheet(name, { contract })` / `contracts test`) and every CLI command
//! are later plans — this module is the core mechanics they build on.
//!
//! ## Why contract loading lives here, not in `sheet.rs`
//!
//! Loading + validating a vendored document only needs a `gix::Repository` /
//! `holo_tree::MutableTree` (to read the committed blob) and the JSON-Schema
//! machinery in [`crate::validation`] — no `Sheet` state. Keeping it here
//! keeps `sheet.rs` focused on orchestration:
//! [`compile_effective_schema`] is the one entry point `Sheet::open` calls.

use holo_tree::MutableTree;
use indexmap::IndexMap;
use serde_json::Value as Json;
use sha2::{Digest, Sha256};

use crate::canonical;
use crate::error::{Error, Result, ValidationIssue};
use crate::path_template::is_windows_invalid;
use crate::record;
use crate::sheet::{join_path, Sheet};
use crate::validation::{self, CompiledSchema};
use crate::value::{self, Value};

// ── contract names + the derived path ─────────────────────────────────────────

/// Validate a contract name per `specs/behaviors/contracts.md` "Contract names
/// and the derived path": host-qualified (at least one `/`), lowercase host
/// characters, and path segments following the same character rules as
/// rendered path-template segments (no Windows-invalid/control characters, no
/// `.`/`..` segments, no trailing slash). A violation is
/// [`Error::ConfigInvalid`] — this is a config defect (a malformed
/// `implements` entry), not a contract defect.
pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return name_err(name, "must not be empty");
    }
    if name.ends_with('/') {
        return name_err(name, "must not have a trailing slash");
    }
    let segments: Vec<&str> = name.split('/').collect();
    if segments.len() < 2 {
        return name_err(name, "must be host-qualified (contain at least one '/')");
    }
    validate_host_segment(name, segments[0])?;
    for seg in &segments[1..] {
        validate_path_segment(name, seg)?;
    }
    Ok(())
}

fn name_err(name: &str, rule: &str) -> Result<()> {
    Err(Error::ConfigInvalid {
        message: format!("contract name {name:?} is invalid: {rule}"),
    })
}

/// The host segment (before the first `/`): lowercase letters, digits, `-`,
/// and `.` only (domain names commonly nest subdomains via `.`).
fn validate_host_segment(name: &str, host: &str) -> Result<()> {
    if host.is_empty() {
        return name_err(name, "host segment must not be empty");
    }
    for c in host.chars() {
        let ok = c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.';
        if !ok {
            return name_err(
                name,
                &format!(
                    "host segment {host:?} contains disallowed character {c:?} \
                     (lowercase letters, digits, '-', '.' only)"
                ),
            );
        }
    }
    Ok(())
}

/// One `/`-separated path segment after the host: the same character rules a
/// rendered path-template segment must satisfy (no Windows-invalid/control
/// characters), plus the `.`/`..` segment rejection.
fn validate_path_segment(name: &str, seg: &str) -> Result<()> {
    if seg.is_empty() {
        return name_err(name, "must not contain empty path segments ('//')");
    }
    if seg == "." || seg == ".." {
        return name_err(
            name,
            &format!("path segment {seg:?} is not allowed ('.'/'..' segments are rejected)"),
        );
    }
    for c in seg.chars() {
        if is_windows_invalid(c) {
            return name_err(
                name,
                &format!("path segment {seg:?} contains disallowed character {c:?}"),
            );
        }
    }
    Ok(())
}

/// The derived vendored path for a contract name — mechanical, no manifest:
/// `.gitsheets/contracts/<name>.toml`.
pub fn contract_path(name: &str) -> String {
    format!(".gitsheets/contracts/{name}.toml")
}

// ── loading + document requirements ───────────────────────────────────────────

/// Load, parse, and validate the vendored contract document `name` from the
/// committed tree at `open_root`, returning its compiled JSON form ready for
/// `allOf` composition. Failure modes (`specs/behaviors/contracts.md` "Failure
/// modes"):
///
/// - no vendored document at the derived path → [`Error::ContractMissing`]
///   (`contract_missing`)
/// - anything else (parse failure, non-canonical bytes, a violated document
///   requirement) → [`Error::ContractInvalid`] (`contract_invalid`), naming
///   the violated rule
pub fn load_contract(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    open_root: &str,
    name: &str,
) -> Result<Json> {
    let full_path = format!("{}.toml", join_path(&[open_root, ".gitsheets/contracts", name]));
    let bytes = tree
        .read_blob(repo, &full_path)
        .map_err(record::map_ht)?
        .ok_or_else(|| Error::ContractMissing {
            message: format!(
                "implements names contract {name:?} but no vendored document exists at {full_path}"
            ),
            contract: name.to_string(),
        })?;
    let text = String::from_utf8(bytes).map_err(|e| Error::ContractInvalid {
        message: format!("contract {name:?} at {full_path} is not valid UTF-8: {e}"),
        contract: name.to_string(),
    })?;
    let parsed = canonical::parse(&text).map_err(|e| Error::ContractInvalid {
        message: format!("contract {name:?}: TOML parse failed: {}", e.message()),
        contract: name.to_string(),
    })?;

    // The lock is the artifact: re-encoding through the canonical encoder must
    // reproduce the vendored bytes exactly (specs/behaviors/contracts.md
    // "Canonical form").
    let reencoded = canonical::serialize(&parsed).map_err(|e| Error::ContractInvalid {
        message: format!("contract {name:?}: {}", e.message()),
        contract: name.to_string(),
    })?;
    if reencoded != text {
        return Err(Error::ContractInvalid {
            message: format!(
                "contract {name:?} at {full_path} is not canonical TOML — re-encoding through \
                 the canonical encoder does not reproduce the vendored bytes exactly"
            ),
            contract: name.to_string(),
        });
    }

    let json = validation::value_to_json(&parsed);
    check_document_requirements(name, &json)?;
    // Draft-07, strictly compiled: unknown keywords fail compilation, the same
    // as `[gitsheet.schema]`. Checked per-contract here (not on the composed
    // `allOf` tree) so a violation names THIS contract, not a generic
    // `ConfigError`.
    validation::reject_unknown_keywords(&json).map_err(|e| Error::ContractInvalid {
        message: format!("contract {name:?}: {}", e.message()),
        contract: name.to_string(),
    })?;
    Ok(json)
}

/// Enforce `specs/behaviors/contracts.md` "Contract document requirements"
/// 2-5 (self-contained, open, TOML-data-model-only, `$id` matches `name`).
/// Requirement 1 (Draft-07 strict compile) is checked separately by
/// [`load_contract`] via [`validation::reject_unknown_keywords`], reusing the
/// exact same guard `[gitsheet.schema]` compiles through.
fn check_document_requirements(name: &str, json: &Json) -> Result<()> {
    let obj = json.as_object().ok_or_else(|| Error::ContractInvalid {
        message: format!("contract {name:?}: document must be a table"),
        contract: name.to_string(),
    })?;

    let expected_id = format!("https://{name}");
    match obj.get("$id") {
        Some(Json::String(id)) if id == &expected_id => {}
        Some(Json::String(id)) => {
            return Err(Error::ContractInvalid {
                message: format!(
                    "contract {name:?}: $id {id:?} does not equal the required {expected_id:?} \
                     (name↔path consistency)"
                ),
                contract: name.to_string(),
            })
        }
        _ => {
            return Err(Error::ContractInvalid {
                message: format!(
                    "contract {name:?}: missing required $id (must equal {expected_id:?})"
                ),
                contract: name.to_string(),
            })
        }
    }

    check_self_contained(name, json)?;
    check_open(name, json)?;
    check_no_null_bearing_keywords(name, json)?;
    Ok(())
}

/// Requirement 2 — self-contained: no external `$ref` (a URL or another
/// document). An internal `$ref` into the contract's own `definitions`
/// (`#/definitions/...`) is allowed.
fn check_self_contained(name: &str, json: &Json) -> Result<()> {
    validation::walk_schema(json, &mut |key, value| {
        if key == "$ref" {
            if let Json::String(r) = value {
                if !r.starts_with('#') {
                    return Err(Error::ContractInvalid {
                        message: format!(
                            "contract {name:?}: external $ref {r:?} is not allowed — contracts \
                             must be self-contained (only internal $ref into the contract's own \
                             definitions is permitted)"
                        ),
                        contract: name.to_string(),
                    });
                }
            }
        }
        Ok(())
    })
}

/// Requirement 3 — open for extension: `additionalProperties: false` is
/// rejected at ANY nesting depth (top level, `definitions`, `items`, `allOf`
/// branches, …) — a closed contract would silently break `allOf` composition
/// with sheet-local schemas and sibling contracts (Draft-07 has no
/// `unevaluatedProperties`).
fn check_open(name: &str, json: &Json) -> Result<()> {
    validation::walk_schema(json, &mut |key, value| {
        if key == "additionalProperties" && value == &Json::Bool(false) {
            return Err(Error::ContractInvalid {
                message: format!(
                    "contract {name:?}: additionalProperties: false is not allowed — a contract \
                     must stay open for extension so `allOf` composition with sheet-local \
                     schemas and sibling contracts doesn't silently break"
                ),
                contract: name.to_string(),
            });
        }
        Ok(())
    })
}

/// Requirement 4 — TOML data model only: no null-bearing keyword anywhere in
/// the document (`type: 'null'`, including inside a `type` array; `const:
/// null`; `enum` containing `null`; `default: null`). TOML has no null, so a
/// null branch could never match a gitsheets record.
fn check_no_null_bearing_keywords(name: &str, json: &Json) -> Result<()> {
    validation::walk_schema(json, &mut |key, value| {
        let violates = match key {
            "type" => {
                matches!(value, Json::String(s) if s == "null")
                    || matches!(value, Json::Array(items) if items.iter().any(|v| v == "null"))
            }
            "const" => value.is_null(),
            "enum" => matches!(value, Json::Array(items) if items.iter().any(|v| v.is_null())),
            "default" => value.is_null(),
            _ => false,
        };
        if violates {
            return Err(Error::ContractInvalid {
                message: format!(
                    "contract {name:?}: {key} is null-bearing ({value}) — TOML has no null, so \
                     a null branch could never match any gitsheets record"
                ),
                contract: name.to_string(),
            });
        }
        Ok(())
    })
}

/// Enforce the [document requirements](../../../specs/behaviors/contracts.md#contract-document-requirements)
/// against a NOT-yet-vendored candidate document — `contracts-cli adopt`'s
/// pre-vendor gate. Exactly the checks [`load_contract`] runs on an
/// already-vendored document (self-contained, open, TOML-data-model-only,
/// `$id`↔name, Draft-07 strict compile), minus the canonical-bytes-reencode
/// check: `adopt` CANONICALIZES the candidate itself before vendoring it, so
/// there is no pre-existing "vendored bytes" to compare against yet — the
/// written file is canonical by construction (see
/// `specs/behaviors/contracts.md` "Canonical form").
pub fn check_contract_document(name: &str, json: &Json) -> Result<()> {
    check_document_requirements(name, json)?;
    // Draft-07, strictly compiled: unknown keywords fail compilation, the same
    // as `[gitsheet.schema]` and `load_contract`.
    validation::reject_unknown_keywords(json).map_err(|e| Error::ContractInvalid {
        message: format!("contract {name:?}: {}", e.message()),
        contract: name.to_string(),
    })?;
    Ok(())
}

// ── composition ────────────────────────────────────────────────────────────────

/// Build a sheet's effective compiled JSON Schema, per
/// `specs/behaviors/contracts.md` "Composition and enforcement":
///
/// - no declared contracts → the bare `[gitsheet.schema]` alone (or `None`
///   when absent) — **byte/behavior-identical** to a sheet that predates
///   contracts entirely;
/// - one or more declared contracts → `allOf: [<contract 1>, …, <contract N>,
///   <[gitsheet.schema] or an always-pass {} when absent>]`, compiled once.
///
/// A declared contract that fails to load or violates a document requirement
/// surfaces here as `ContractError` (`contract_missing` / `contract_invalid`)
/// — sheet-open time, per the failure-modes table.
pub(crate) fn compile_effective_schema(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    open_root: &str,
    implements: &[String],
    local_schema: &Option<Value>,
) -> Result<Option<CompiledSchema>> {
    if implements.is_empty() {
        return match local_schema {
            Some(s) => Ok(Some(CompiledSchema::compile(s)?)),
            None => Ok(None),
        };
    }

    let mut all_of = Vec::with_capacity(implements.len() + 1);
    for name in implements {
        all_of.push(load_contract(repo, tree, open_root, name)?);
    }
    let local_json = match local_schema {
        Some(s) => {
            let json = validation::value_to_json(s);
            validation::reject_unknown_keywords(&json)?;
            json
        }
        // No local schema declared: an always-pass schema so `allOf` reduces
        // to exactly the declared contracts' constraints.
        None => Json::Object(serde_json::Map::new()),
    };
    all_of.push(local_json);

    let mut composed = serde_json::Map::new();
    composed.insert("allOf".to_string(), Json::Array(all_of));
    let compiled = CompiledSchema::compile_composed(Json::Object(composed), implements.to_vec())?;
    Ok(Some(compiled))
}

// ── the identity primitive: canonical_contract_hash ───────────────────────────

/// The input form accepted by [`canonical_contract_hash`] — a contract
/// document supplied as already-parsed data, JSON interchange text, or TOML
/// text (`specs/behaviors/contracts.md` "Canonical form": "Adoption accepts
/// interchange JSON or TOML input").
pub enum ContractHashInput {
    /// Already-parsed data (e.g. marshalled from a binding's native object).
    Data(Value),
    /// JSON interchange text.
    Json(String),
    /// TOML text.
    Toml(String),
}

/// The contract identity primitive: canonicalize `input` (parse if text) →
/// encode through the canonical TOML encoder → SHA-256 hex of the resulting
/// bytes. `contracts-cli` (vendoring) and `contracts-consumer-verify` (rung-1
/// byte-identity) both build on this — a document supplied as JSON text, TOML
/// text, or already-parsed data yields the identical hash for the identical
/// logical document, since all three forms funnel through the same canonical
/// encoder (`specs/behaviors/contracts.md` "Canonical form": "Byte-equality ≡
/// data-equality").
pub fn canonical_contract_hash(input: ContractHashInput) -> Result<String> {
    let value = resolve_contract_document(input)?;
    let bytes = canonical::serialize(&value)?;
    Ok(sha256_hex(bytes.as_bytes()))
}

/// Resolve a [`ContractHashInput`] (parsed data, JSON text, or TOML text) into
/// the core [`Value`] it denotes — the shared first step of
/// [`canonical_contract_hash`] and consumer-side verification
/// ([`verify_sheet_contract`]), both of which need the parsed document before
/// they diverge (one hashes it, the other also compiles it as a schema and
/// reads its `$id`).
pub fn resolve_contract_document(input: ContractHashInput) -> Result<Value> {
    match input {
        ContractHashInput::Data(v) => Ok(v),
        ContractHashInput::Toml(s) => canonical::parse(&s),
        ContractHashInput::Json(s) => {
            let json: Json = serde_json::from_str(&s).map_err(|e| Error::ConfigInvalid {
                message: format!("JSON parse failed: {e}"),
            })?;
            json_to_value(&json)
        }
    }
}

// ── consumer verification: the two-rung ladder ────────────────────────────────
//
// `specs/behaviors/contracts.md` "Consumer verification": a consumer holding a
// contract document verifies a target sheet it has opened (already compiled —
// `implements` resolved, effective schema composed) via rung 1 (declared
// identity: name membership + vendored-byte identity) falling through, on a
// miss, to rung 2 (structural: every record validates against the consumer's
// document ALONE, ignoring the sheet's own declarations/local schema).

/// Which rungs [`verify_sheet_contract`] attempts. `specs/api/repository.md`
/// `opts.contract.mode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerifyMode {
    /// Rung 1, falling back to rung 2 on a miss. The default.
    Verify,
    /// Rung 1 only — strict, never reads records. A miss is
    /// `contract_unsatisfied` immediately.
    Declared,
    /// Rung 2 only — duck typing; ignores `implements` entirely.
    Structural,
}

/// Which rung a verification actually passed at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rung {
    /// Rung 1: the sheet declares the contract's name AND the vendored bytes
    /// are byte-identical to the consumer's document. Verified present *and*
    /// future — write-time enforcement guarantees it forever.
    Declared,
    /// Rung 2: every current record validates against the consumer's document
    /// alone. Verified only for the tree hash checked — pure duck typing.
    Structural,
}

impl Rung {
    /// The wire string used on binding surfaces (`sheet.contractVerification.rung`).
    pub fn as_str(self) -> &'static str {
        match self {
            Rung::Declared => "declared",
            Rung::Structural => "structural",
        }
    }
}

/// The result of a successful [`verify_sheet_contract`] — mirrors
/// `sheet.contractVerification` in `specs/api/repository.md` (minus `tree`,
/// which the binding attaches from the read snapshot it already resolved to
/// open the sheet).
#[derive(Clone, Debug)]
pub struct ConformanceReport {
    pub name: String,
    pub rung: Rung,
    /// Always `true` on `Ok` — [`verify_sheet_contract`] returns
    /// `Err(Error::ContractUnsatisfied)` (carrying its own `issues`) on
    /// failure rather than an `Ok` report with `conforming: false`. Kept as an
    /// explicit field (rather than implied by `Ok`/`Err`) because the same
    /// shape is reused host-side to describe a *regressed* drift re-check,
    /// where `conforming` is `false`.
    pub conforming: bool,
    pub issues: Vec<ValidationIssue>,
}

/// Extract the contract name from a document's `$id` (`specs/behaviors/
/// contracts.md` "Contract name": the `$id` with the `https://` scheme
/// stripped). The consumer's own document is expected to already be a valid
/// contract (mirrored — perhaps freshly authored — from one that was
/// vendored and validated elsewhere), so this only checks the one thing
/// `verify_sheet_contract` actually needs: a well-formed `$id` to derive
/// identity from. A malformed/missing `$id` is the caller's input error.
fn contract_name_from_document(json: &Json) -> Result<String> {
    let id = json
        .as_object()
        .and_then(|o| o.get("$id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::ConfigInvalid {
            message: "contract document is missing a required string \"$id\" (a consumer-held \
                      document must carry the same $id its contract name derives from)"
                .to_string(),
        })?;
    id.strip_prefix("https://")
        .map(str::to_string)
        .ok_or_else(|| Error::ConfigInvalid {
            message: format!(
                "contract document $id {id:?} does not have the required \"https://\" scheme"
            ),
        })
}

/// Read the vendored contract text at its derived path, if present. Unlike
/// [`load_contract`] this does NOT re-check document requirements or
/// canonical-bytes — by the time a caller has a successfully-`Sheet::open`ed
/// sheet in hand, every contract it `implements` already passed those checks
/// once at open time. A miss here (absent, not UTF-8) degrades to a rung-1
/// miss rather than an error — "mismatch is evidence to check, not grounds to
/// refuse" (`specs/behaviors/contracts.md` principles) applies just as much to
/// a vendored-read hiccup as to a hash mismatch.
fn read_vendored_text(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    open_root: &str,
    name: &str,
) -> Option<String> {
    let full_path = format!("{}.toml", join_path(&[open_root, ".gitsheets/contracts", name]));
    let bytes = tree.read_blob(repo, &full_path).ok().flatten()?;
    String::from_utf8(bytes).ok()
}

/// Verify `sheet` (already opened against `tree`) against the consumer's
/// `document`, per `specs/behaviors/contracts.md` "Consumer verification":
///
/// - **Rung 1** (skipped in [`VerifyMode::Structural`]): `sheet`'s `implements`
///   names the document's contract AND the vendored bytes at the derived path
///   (under `open_root`) are canonical-hash-identical to `document`. Pass →
///   `Ok` with [`Rung::Declared`], **zero records read**.
/// - **Rung 2** (skipped in [`VerifyMode::Declared`]): every record of `sheet`
///   validates against `document` alone (not composed with the sheet's own
///   schema/contracts — pure duck typing). Pass → `Ok` with
///   [`Rung::Structural`].
/// - Both rungs miss (or the attempted rung misses, in `Declared`/`Structural`
///   mode) → [`Error::ContractUnsatisfied`] carrying the conformance report:
///   an empty `issues` list for a `Declared`-mode miss (it never reads
///   records to produce field-level issues), or one [`ValidationIssue`] per
///   failing field per record (tagged `record`/`contract`) for a rung-2 miss.
pub fn verify_sheet_contract(
    repo: &gix::Repository,
    tree: &mut MutableTree,
    open_root: &str,
    sheet: &Sheet,
    document: ContractHashInput,
    mode: VerifyMode,
) -> Result<ConformanceReport> {
    let value = resolve_contract_document(document)?;
    let json = validation::value_to_json(&value);
    let name = contract_name_from_document(&json)?;

    if !matches!(mode, VerifyMode::Structural) {
        let declared = sheet.config().implements.iter().any(|n| n == &name);
        if declared {
            if let Some(vendored_text) = read_vendored_text(repo, tree, open_root, &name) {
                let vendored_hash =
                    canonical_contract_hash(ContractHashInput::Toml(vendored_text))?;
                let consumer_hash = canonical_contract_hash(ContractHashInput::Data(value.clone()))?;
                if vendored_hash == consumer_hash {
                    return Ok(ConformanceReport {
                        name,
                        rung: Rung::Declared,
                        conforming: true,
                        issues: Vec::new(),
                    });
                }
            }
        }
        if matches!(mode, VerifyMode::Declared) {
            return Err(Error::ContractUnsatisfied {
                message: format!(
                    "sheet {:?} does not declare contract {name:?} with a byte-identical vendored \
                     document — declared mode never falls back to structural validation",
                    sheet.name()
                ),
                contract: name,
                issues: Vec::new(),
            });
        }
        // Rung-1 miss: evidence to check, not grounds to refuse — fall through
        // to rung 2 (e.g. the producer implements a newer, data-compatible
        // version).
    }

    // Rung 2 — structural: compile the CONSUMER's document alone (never
    // composed with the sheet's own schema/contracts) and validate every
    // current record against it.
    let compiled = CompiledSchema::compile(&value)?;
    let records = sheet.list(repo, tree, true)?;
    let mut issues = Vec::new();
    for (path, record) in &records {
        for mut issue in compiled.validate(record) {
            issue.contract = Some(name.clone());
            issue.record = Some(path.clone());
            issues.push(issue);
        }
    }
    if issues.is_empty() {
        Ok(ConformanceReport {
            name,
            rung: Rung::Structural,
            conforming: true,
            issues: Vec::new(),
        })
    } else {
        Err(Error::ContractUnsatisfied {
            message: format!(
                "sheet {:?} does not structurally conform to contract {name:?}: {} issue(s) \
                 across its records",
                sheet.name(),
                issues.len()
            ),
            contract: name,
            issues,
        })
    }
}

/// Marshal a `serde_json::Value` into the core [`Value`], applying the same
/// null-handling contract every binding applies at its host→core marshal
/// boundary (`specs/behaviors/normalization.md` "Null / undefined handling"):
/// a null-valued table key is dropped (recursively); a null array element or
/// a null value itself is rejected. This is the one place JSON text (which
/// CAN represent `null`, unlike TOML) enters the core directly.
fn json_to_value(json: &Json) -> Result<Value> {
    match json {
        Json::Null => Err(Error::ConfigInvalid {
            message: value::null_value_msg("null"),
        }),
        Json::Bool(b) => Ok(Value::Boolean(*b)),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(Value::Integer(i))
            } else if let Some(f) = n.as_f64() {
                Ok(Value::Float(f))
            } else {
                Err(Error::ConfigInvalid {
                    message: format!("number {n} is out of range for a TOML integer or float"),
                })
            }
        }
        Json::String(s) => Ok(Value::String(s.clone())),
        Json::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                if item.is_null() {
                    return Err(Error::ConfigInvalid {
                        message: value::null_array_element_msg("null", i),
                    });
                }
                out.push(json_to_value(item)?);
            }
            Ok(Value::Array(out))
        }
        Json::Object(map) => {
            let mut out = IndexMap::with_capacity(map.len());
            for (k, v) in map {
                if v.is_null() {
                    continue; // dropped, recursively — rule 1
                }
                out.insert(k.clone(), json_to_value(v)?);
            }
            Ok(Value::Table(out))
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── name rules ────────────────────────────────────────────────────────────

    #[test]
    fn valid_names_pass() {
        for name in [
            "gitsheets.io/meals/v1",
            "example.com/a",
            "a-b.example.com/c/d/v2",
        ] {
            assert!(validate_name(name).is_ok(), "{name:?} should be valid");
        }
    }

    #[test]
    fn name_rule_violations_are_config_invalid() {
        let cases: &[(&str, &str)] = &[
            ("", "empty"),
            ("no-slash", "not host-qualified"),
            ("Gitsheets.io/meals/v1", "uppercase host"),
            ("gitsheets.io/meals/v1/", "trailing slash"),
            ("gitsheets.io//v1", "empty path segment"),
            ("gitsheets.io/./v1", "'.' segment"),
            ("gitsheets.io/../v1", "'..' segment"),
            ("gitsheets.io/meals:v1", "windows-invalid character"),
            ("host_with_underscore.com/v1", "underscore in host"),
        ];
        for (name, why) in cases {
            let err = validate_name(name).unwrap_err();
            assert_eq!(err.code(), "config_invalid", "{why}: {name:?}");
        }
    }

    #[test]
    fn contract_path_is_mechanically_derived() {
        assert_eq!(
            contract_path("gitsheets.io/meals/v1"),
            ".gitsheets/contracts/gitsheets.io/meals/v1.toml"
        );
    }

    // ── document requirements (direct Json construction) ──────────────────────

    fn valid_doc(name: &str) -> Json {
        serde_json::json!({
            "$id": format!("https://{name}"),
            "type": "object",
            "required": ["slug"],
            "properties": { "slug": { "type": "string" } }
        })
    }

    #[test]
    fn a_conforming_document_passes_all_requirements() {
        let name = "example.com/c/v1";
        check_document_requirements(name, &valid_doc(name)).unwrap();
    }

    #[test]
    fn missing_id_is_contract_invalid() {
        let mut doc = valid_doc("example.com/c/v1");
        doc.as_object_mut().unwrap().remove("$id");
        let err = check_document_requirements("example.com/c/v1", &doc).unwrap_err();
        assert_eq!(err.code(), "contract_invalid");
        assert!(err.message().contains("$id"));
    }

    #[test]
    fn mismatched_id_is_contract_invalid() {
        let mut doc = valid_doc("example.com/c/v1");
        doc.as_object_mut()
            .unwrap()
            .insert("$id".into(), Json::String("https://example.com/c/v2".into()));
        let err = check_document_requirements("example.com/c/v1", &doc).unwrap_err();
        assert_eq!(err.code(), "contract_invalid");
        assert!(err.message().contains("$id"));
    }

    #[test]
    fn external_ref_is_contract_invalid() {
        let mut doc = valid_doc("example.com/c/v1");
        doc.as_object_mut().unwrap().insert(
            "properties".into(),
            serde_json::json!({ "slug": { "$ref": "https://example.com/other.schema.json" } }),
        );
        let err = check_document_requirements("example.com/c/v1", &doc).unwrap_err();
        assert_eq!(err.code(), "contract_invalid");
        assert!(err.message().contains("$ref"));
    }

    #[test]
    fn internal_ref_is_allowed() {
        let mut doc = valid_doc("example.com/c/v1");
        doc.as_object_mut().unwrap().insert(
            "properties".into(),
            serde_json::json!({ "slug": { "$ref": "#/definitions/slug" } }),
        );
        doc.as_object_mut()
            .unwrap()
            .insert("definitions".into(), serde_json::json!({ "slug": { "type": "string" } }));
        check_document_requirements("example.com/c/v1", &doc).unwrap();
    }

    #[test]
    fn closed_additional_properties_is_contract_invalid_at_any_depth() {
        // Top-level.
        let mut doc = valid_doc("example.com/c/v1");
        doc.as_object_mut()
            .unwrap()
            .insert("additionalProperties".into(), Json::Bool(false));
        let err = check_document_requirements("example.com/c/v1", &doc).unwrap_err();
        assert_eq!(err.code(), "contract_invalid");
        assert!(err.message().contains("additionalProperties"));

        // Nested inside a property's own subschema.
        let mut doc = valid_doc("example.com/c/v1");
        doc.as_object_mut().unwrap().insert(
            "properties".into(),
            serde_json::json!({ "nested": { "type": "object", "additionalProperties": false } }),
        );
        let err = check_document_requirements("example.com/c/v1", &doc).unwrap_err();
        assert_eq!(err.code(), "contract_invalid");

        // Nested inside an `allOf` branch.
        let mut doc = valid_doc("example.com/c/v1");
        doc.as_object_mut().unwrap().insert(
            "allOf".into(),
            serde_json::json!([{ "type": "object", "additionalProperties": false }]),
        );
        let err = check_document_requirements("example.com/c/v1", &doc).unwrap_err();
        assert_eq!(err.code(), "contract_invalid");
    }

    #[test]
    fn open_additional_properties_true_or_schema_is_allowed() {
        let mut doc = valid_doc("example.com/c/v1");
        doc.as_object_mut()
            .unwrap()
            .insert("additionalProperties".into(), Json::Bool(true));
        check_document_requirements("example.com/c/v1", &doc).unwrap();
    }

    #[test]
    fn null_bearing_type_keyword_is_contract_invalid() {
        let mut doc = valid_doc("example.com/c/v1");
        doc.as_object_mut().unwrap().insert(
            "properties".into(),
            serde_json::json!({ "slug": { "type": "null" } }),
        );
        let err = check_document_requirements("example.com/c/v1", &doc).unwrap_err();
        assert_eq!(err.code(), "contract_invalid");
        assert!(err.message().contains("null-bearing"));
    }

    #[test]
    fn null_bearing_type_array_is_contract_invalid() {
        let mut doc = valid_doc("example.com/c/v1");
        doc.as_object_mut().unwrap().insert(
            "properties".into(),
            serde_json::json!({ "slug": { "type": ["string", "null"] } }),
        );
        let err = check_document_requirements("example.com/c/v1", &doc).unwrap_err();
        assert_eq!(err.code(), "contract_invalid");
    }

    #[test]
    fn null_bearing_const_enum_default_are_contract_invalid() {
        for (key, value) in [
            ("const", Json::Null),
            ("enum", serde_json::json!(["a", null])),
            ("default", Json::Null),
        ] {
            let mut doc = valid_doc("example.com/c/v1");
            let mut slug_schema = serde_json::Map::new();
            slug_schema.insert(key.to_string(), value);
            let mut properties = serde_json::Map::new();
            properties.insert("slug".to_string(), Json::Object(slug_schema));
            doc.as_object_mut()
                .unwrap()
                .insert("properties".into(), Json::Object(properties));
            let err = check_document_requirements("example.com/c/v1", &doc).unwrap_err();
            assert_eq!(err.code(), "contract_invalid", "keyword {key:?}");
        }
    }

    #[test]
    fn unknown_keyword_in_the_document_is_contract_invalid() {
        // Draft-07 strict compile parity — checked via load_contract's call to
        // reject_unknown_keywords, exercised end-to-end in sheet.rs tests; here
        // we prove the shared walker itself flags it.
        let doc = serde_json::json!({
            "$id": "https://example.com/c/v1",
            "type": "object",
            "frobnicate": true
        });
        let err = validation::reject_unknown_keywords(&doc).unwrap_err();
        assert_eq!(err.code(), "config_invalid");
    }

    #[test]
    fn check_contract_document_passes_a_conforming_candidate() {
        let name = "example.com/c/v1";
        check_contract_document(name, &valid_doc(name)).unwrap();
    }

    #[test]
    fn check_contract_document_rejects_unknown_keywords_like_load_contract() {
        let name = "example.com/c/v1";
        let mut doc = valid_doc(name);
        doc.as_object_mut()
            .unwrap()
            .insert("frobnicate".into(), Json::Bool(true));
        let err = check_contract_document(name, &doc).unwrap_err();
        assert_eq!(err.code(), "contract_invalid");
    }

    #[test]
    fn check_contract_document_rejects_a_closed_candidate() {
        let name = "example.com/c/v1";
        let mut doc = valid_doc(name);
        doc.as_object_mut()
            .unwrap()
            .insert("additionalProperties".into(), Json::Bool(false));
        let err = check_contract_document(name, &doc).unwrap_err();
        assert_eq!(err.code(), "contract_invalid");
        assert!(err.message().contains("additionalProperties"));
    }

    // ── loading from a committed tree ──────────────────────────────────────────

    fn temp_repo() -> (tempfile::TempDir, gix::Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = gix::init(dir.path()).unwrap();
        (dir, repo)
    }

    fn write_contract_toml(repo: &gix::Repository, tree: &mut MutableTree, name: &str, toml: &str) {
        let value = canonical::parse(toml).expect("contract toml parses");
        // Vendor at the exact canonical bytes so the canonical-form check passes.
        let canonical_bytes = canonical::serialize(&value).expect("serialize");
        let path = format!(".gitsheets/contracts/{name}.toml");
        tree.write_child(repo, &path, &canonical_bytes).unwrap();
    }

    #[test]
    fn missing_vendored_document_is_contract_missing() {
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        let err = load_contract(&repo, &mut tree, ".", "example.com/c/v1").unwrap_err();
        assert_eq!(err.code(), "contract_missing");
        assert_eq!(err.contract(), Some("example.com/c/v1"));
    }

    #[test]
    fn loads_a_conforming_vendored_contract() {
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        let name = "example.com/c/v1";
        write_contract_toml(
            &repo,
            &mut tree,
            name,
            &format!(
                "'$id' = 'https://{name}'\ntype = 'object'\nrequired = ['slug']\n\
                 [properties.slug]\ntype = 'string'\n"
            ),
        );
        let json = load_contract(&repo, &mut tree, ".", name).unwrap();
        assert_eq!(json["$id"], Json::String(format!("https://{name}")));
    }

    #[test]
    fn non_canonical_bytes_are_contract_invalid() {
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        let name = "example.com/c/v1";
        // Deliberately non-canonical: keys out of sorted order.
        let non_canonical = format!(
            "type = 'object'\n'$id' = 'https://{name}'\nrequired = ['slug']\n"
        );
        let path = format!(".gitsheets/contracts/{name}.toml");
        tree.write_child(&repo, &path, &non_canonical).unwrap();
        let err = load_contract(&repo, &mut tree, ".", name).unwrap_err();
        assert_eq!(err.code(), "contract_invalid");
        assert!(err.message().contains("canonical"));
    }

    #[test]
    fn two_sheets_share_one_vendored_document() {
        // Loading the same name twice from the same tree yields the identical
        // compiled Json both times — one name, one document, per repo.
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        let name = "example.com/c/v1";
        write_contract_toml(
            &repo,
            &mut tree,
            name,
            &format!("'$id' = 'https://{name}'\ntype = 'object'\n"),
        );
        let a = load_contract(&repo, &mut tree, ".", name).unwrap();
        let b = load_contract(&repo, &mut tree, ".", name).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn contracts_are_scoped_by_open_root() {
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        let name = "example.com/c/v1";
        write_contract_toml(
            &repo,
            &mut tree,
            name,
            &format!("'$id' = 'https://{name}'\ntype = 'object'\n"),
        );
        // The document above is vendored at the repo root's
        // `.gitsheets/contracts/...`. It's absent when scoped under `sub`...
        assert!(load_contract(&repo, &mut tree, "sub", name).is_err());
        // ...but visible at the (default) repo root.
        let json = load_contract(&repo, &mut tree, ".", name).unwrap();
        assert_eq!(json["$id"], Json::String(format!("https://{name}")));
    }

    // ── canonical_contract_hash ────────────────────────────────────────────────

    #[test]
    fn hash_is_identical_across_data_json_and_toml_input() {
        let mut m = IndexMap::new();
        m.insert("$id".to_string(), Value::String("https://example.com/c/v1".into()));
        m.insert("type".to_string(), Value::String("object".into()));
        let data = Value::Table(m);

        let json_text = r#"{"$id":"https://example.com/c/v1","type":"object"}"#.to_string();
        let toml_text = "'$id' = 'https://example.com/c/v1'\ntype = 'object'\n".to_string();

        let from_data = canonical_contract_hash(ContractHashInput::Data(data)).unwrap();
        let from_json = canonical_contract_hash(ContractHashInput::Json(json_text)).unwrap();
        let from_toml = canonical_contract_hash(ContractHashInput::Toml(toml_text)).unwrap();

        assert_eq!(from_data, from_json);
        assert_eq!(from_json, from_toml);
        assert_eq!(from_data.len(), 64, "sha256 hex digest is 64 chars");
    }

    #[test]
    fn hash_differs_for_different_documents() {
        let a = canonical_contract_hash(ContractHashInput::Toml("a = 1\n".into())).unwrap();
        let b = canonical_contract_hash(ContractHashInput::Toml("a = 2\n".into())).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn json_text_with_null_value_position_is_rejected() {
        let err = canonical_contract_hash(ContractHashInput::Json("null".into())).unwrap_err();
        assert_eq!(err.code(), "config_invalid");
    }

    #[test]
    fn json_text_drops_null_valued_keys_like_every_binding_boundary() {
        let with_null =
            canonical_contract_hash(ContractHashInput::Json(r#"{"a":1,"b":null}"#.into())).unwrap();
        let without = canonical_contract_hash(ContractHashInput::Json(r#"{"a":1}"#.into())).unwrap();
        assert_eq!(with_null, without);
    }

    #[test]
    fn json_text_rejects_null_array_elements() {
        let err =
            canonical_contract_hash(ContractHashInput::Json(r#"{"a":[1,null]}"#.into())).unwrap_err();
        assert_eq!(err.code(), "config_invalid");
    }
}

#[cfg(test)]
mod verify_tests {
    use super::*;
    use crate::record::{write_records, TOML_EXTENSION};

    fn temp_repo() -> (tempfile::TempDir, gix::Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = gix::init(dir.path()).unwrap();
        (dir, repo)
    }

    /// Vendor `doc` at contract `name`'s derived path, through the same
    /// canonical encoder `load_contract`'s canonical-bytes check compares
    /// against.
    fn vendor_contract(repo: &gix::Repository, tree: &mut MutableTree, name: &str, doc: &Json) {
        let value = json_to_value(doc).unwrap();
        let bytes = canonical::serialize(&value).unwrap();
        let path = contract_path(name);
        tree.write_child(repo, &path, &bytes).unwrap();
    }

    fn sheet_config(implements: &[&str]) -> Value {
        let mut gs = IndexMap::new();
        gs.insert("path".to_string(), Value::String("${{ slug }}".into()));
        gs.insert("root".to_string(), Value::String("people".into()));
        if !implements.is_empty() {
            gs.insert(
                "implements".to_string(),
                Value::Array(
                    implements
                        .iter()
                        .map(|n| Value::String((*n).to_string()))
                        .collect(),
                ),
            );
        }
        let mut top = IndexMap::new();
        top.insert("gitsheet".to_string(), Value::Table(gs));
        Value::Table(top)
    }

    fn write_config(repo: &gix::Repository, tree: &mut MutableTree, config: Value) {
        write_records(repo, tree, ".gitsheets", &[("people".into(), config)], TOML_EXTENSION)
            .unwrap();
    }

    fn write_record(repo: &gix::Repository, tree: &mut MutableTree, slug: &str, fields: &[(&str, &str)]) {
        let mut m = IndexMap::new();
        m.insert("slug".to_string(), Value::String(slug.to_string()));
        for (k, v) in fields {
            m.insert((*k).to_string(), Value::String((*v).to_string()));
        }
        let value = Value::Table(m);
        let bytes = canonical::serialize(&value).unwrap();
        tree.write_child(repo, &format!("people/{slug}.toml"), &bytes).unwrap();
    }

    fn open_people(repo: &gix::Repository, tree: &mut MutableTree) -> Sheet {
        Sheet::open(repo, tree, "people", ".gitsheets/people.toml", ".", "").unwrap()
    }

    const NAME: &str = "example.com/people/v1";
    const NAME_V1_1: &str = "example.com/people/v1.1";

    fn consumer_doc(name: &str, required: &[&str]) -> Json {
        serde_json::json!({
            "$id": format!("https://{name}"),
            "type": "object",
            "required": required,
        })
    }

    #[test]
    fn rung1_passes_with_zero_record_reads() {
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        write_config(&repo, &mut tree, sheet_config(&[NAME]));
        let doc = consumer_doc(NAME, &["email"]);
        vendor_contract(&repo, &mut tree, NAME, &doc);
        // A garbage record that would blow up `Sheet::list` if rung 1 ever
        // fell through to reading records — proves the zero-record-read claim.
        tree.write_child(&repo, "people/garbage.toml", "not [ valid toml").unwrap();
        let sheet = open_people(&repo, &mut tree);

        let report = verify_sheet_contract(
            &repo,
            &mut tree,
            ".",
            &sheet,
            ContractHashInput::Data(json_to_value(&doc).unwrap()),
            VerifyMode::Verify,
        )
        .unwrap();
        assert_eq!(report.name, NAME);
        assert_eq!(report.rung, Rung::Declared);
        assert!(report.conforming);
        assert!(report.issues.is_empty());
    }

    #[test]
    fn rung1_miss_on_a_newer_producer_version_falls_through_to_rung2_pass() {
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        // Producer declares the NEWER, data-compatible version…
        write_config(&repo, &mut tree, sheet_config(&[NAME_V1_1]));
        let doc_v1_1 = consumer_doc(NAME_V1_1, &["email"]);
        vendor_contract(&repo, &mut tree, NAME_V1_1, &doc_v1_1);
        write_record(&repo, &mut tree, "jane", &[("email", "jane@x.org")]);
        let sheet = open_people(&repo, &mut tree);

        // …but the consumer still holds v1 — a rung-1 miss (name not
        // declared) that falls through to a rung-2 pass (the data satisfies
        // v1 too).
        let doc_v1 = consumer_doc(NAME, &["email"]);
        let report = verify_sheet_contract(
            &repo,
            &mut tree,
            ".",
            &sheet,
            ContractHashInput::Data(json_to_value(&doc_v1).unwrap()),
            VerifyMode::Verify,
        )
        .unwrap();
        assert_eq!(report.rung, Rung::Structural);
        assert!(report.conforming);
    }

    #[test]
    fn rung2_failure_reports_record_and_field_level_issues() {
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        write_config(&repo, &mut tree, sheet_config(&[])); // contract-unaware
        write_record(&repo, &mut tree, "jane", &[("email", "jane@x.org")]);
        write_record(&repo, &mut tree, "bob", &[]); // missing email
        let sheet = open_people(&repo, &mut tree);

        let doc = consumer_doc(NAME, &["email"]);
        let err = verify_sheet_contract(
            &repo,
            &mut tree,
            ".",
            &sheet,
            ContractHashInput::Data(json_to_value(&doc).unwrap()),
            VerifyMode::Verify,
        )
        .unwrap_err();
        assert_eq!(err.code(), "contract_unsatisfied");
        assert_eq!(err.contract(), Some(NAME));
        let issues = err.issues();
        assert!(issues.iter().any(|i| i.record.as_deref() == Some("bob")
            && i.contract.as_deref() == Some(NAME)
            && i.code.as_deref() == Some("required")));
        assert!(!issues.iter().any(|i| i.record.as_deref() == Some("jane")));
    }

    #[test]
    fn declared_mode_fails_fast_without_reading_records() {
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        write_config(&repo, &mut tree, sheet_config(&[])); // not declared
        tree.write_child(&repo, "people/garbage.toml", "not [ valid toml").unwrap();
        let sheet = open_people(&repo, &mut tree);

        let doc = consumer_doc(NAME, &["email"]);
        let err = verify_sheet_contract(
            &repo,
            &mut tree,
            ".",
            &sheet,
            ContractHashInput::Data(json_to_value(&doc).unwrap()),
            VerifyMode::Declared,
        )
        .unwrap_err();
        assert_eq!(err.code(), "contract_unsatisfied");
        assert!(
            err.issues().is_empty(),
            "declared mode never scans records — no per-record issues"
        );
    }

    #[test]
    fn structural_mode_ignores_declarations_and_duck_types() {
        let (_d, repo) = temp_repo();
        let mut tree = MutableTree::empty();
        write_config(&repo, &mut tree, sheet_config(&[])); // no implements at all
        write_record(&repo, &mut tree, "jane", &[("email", "jane@x.org")]);
        let sheet = open_people(&repo, &mut tree);

        let doc = consumer_doc(NAME, &["email"]);
        let report = verify_sheet_contract(
            &repo,
            &mut tree,
            ".",
            &sheet,
            ContractHashInput::Data(json_to_value(&doc).unwrap()),
            VerifyMode::Structural,
        )
        .unwrap();
        assert_eq!(report.rung, Rung::Structural);
        assert!(report.conforming);
    }
}
