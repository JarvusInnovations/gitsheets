//! `gitsheets-core` — the pure-Rust core for gitsheets.
//!
//! **Status: foundation + bytes-authority.** This crate owns:
//!
//! - [`Value`] — the TOML-faithful core value type every binding marshals to
//!   and from (see [`value`]).
//! - [`Error`] — the typed, matchable error surface a binding maps onto its
//!   host's idiomatic exception classes (see [`error`]).
//! - **The bytes-authority** — TOML [`parse`]/[`serialize`] and canonical
//!   [`normalize`] (deep key sort → byte-stable canonical form), plus their
//!   batch variants (see [`canonical`]). This is what makes the on-disk form a
//!   contract every binding agrees on byte-for-byte.
//! - Batch-first API shape — every entry point takes and returns a `Vec`, so
//!   bulk paths never bake in per-record FFI crossings.
//!
//! The rest of the engine — path-template rendering, validation, query, and the
//! `Sheet`/`Transaction`/`Store` state machine — lands in downstream plans on
//! top of this substrate. See [`specs/rust-core.md`](../../../specs/rust-core.md).

pub mod canonical;
pub mod codec;
pub mod collator;
pub mod config;
pub mod contract;
pub mod diff;
pub mod engine;
pub mod error;
pub mod index;
pub mod path_template;
pub mod query;
pub mod record;
pub mod sheet;
pub mod store;
pub mod transaction;
pub mod validation;
pub mod value;

pub use canonical::{normalize, parse, parse_batch, serialize, serialize_batch};
pub use codec::{extract_first_h1, normalize_body, rewrite_leading_h1};
pub use config::{FieldConfig, FormatConfig, FormatKind, SheetConfig, SortDir, SortRule};
pub use contract::{
    canonical_contract_hash, contract_path, validate_name as validate_contract_name,
    verify_sheet_contract, ConformanceReport, ContractHashInput, Rung, VerifyMode,
};
pub use diff::{apply_merge_patch, create_patch, MergePatch, PatchOp, PatchOpKind, PatchValue};
pub use error::{Error, ErrorClass, IssueSource, Result, ValidationIssue};
pub use index::{MultiIndex, UniqueIndex};
pub use query::{matches as query_matches, query_candidate_paths, query_records, Filter, FilterPred};
pub use record::{
    write_blob, write_blob_at_dir, DeleteOutcome, RecordChange, RecordDiff, RecordStatus,
    WriteOutcome, EMPTY_TREE_HASH, TOML_EXTENSION,
};
pub use sheet::{Sheet, StageOutcome, UpsertCandidate, WillChange};
pub use transaction::{Author, Transaction, TransactionOptions, TransactionResult};
pub use value::{null_array_element_msg, null_value_msg, Datetime, DatetimeKind, Value};

/// Identity over a batch of records — the minimal exercise of the value type
/// across a bulk boundary. Bindings call this to prove a whole array of records
/// crosses the FFI in a single call with full type fidelity preserved. Later
/// plans replace this skeleton with real engine entry points (`upsertMany`,
/// `queryAll`, …) that keep the same batch-first signature.
pub fn echo_batch(records: Vec<Value>) -> Vec<Value> {
    records
}

/// Construct a representative [`Error`] for a given stable `code`. Bindings use
/// this to exercise error-variant → typed-class mapping across the boundary
/// without standing up real engine code paths. Returns `None` for an unknown
/// code.
pub fn example_error(code: &str) -> Option<Error> {
    let msg = format!("example {code} error");
    Some(match code {
        "config_missing" => Error::ConfigMissing { message: msg },
        "config_invalid" => Error::ConfigInvalid { message: msg },
        "validation_failed" => Error::ValidationFailed {
            message: msg,
            issues: vec![ValidationIssue {
                path: vec!["email".into()],
                message: "must match pattern".into(),
                source: IssueSource::JsonSchema,
                schema_path: Some("#/properties/email/pattern".into()),
                code: Some("pattern".into()),
                contract: None,
                record: None,
            }],
        },
        "transaction_in_progress" => Error::TransactionInProgress { message: msg },
        "transaction_required" => Error::TransactionRequired { message: msg },
        "parent_moved" => Error::ParentMoved { message: msg },
        "commit_failed" => Error::CommitFailed { message: msg },
        "push_daemon_running" => Error::PushDaemonRunning { message: msg },
        "transaction_closed" => Error::TransactionClosed { message: msg },
        "index_unique_conflict" => Error::IndexUniqueConflict {
            message: msg,
            conflicting_paths: vec!["people/by-email/a@b.com".into()],
        },
        "index_not_defined" => Error::IndexNotDefined { message: msg },
        "ref_not_found" => Error::RefNotFound { message: msg },
        "not_an_ancestor" => Error::NotAnAncestor { message: msg },
        "path_render_failed" => Error::PathRenderFailed { message: msg },
        "path_invalid_chars" => Error::PathInvalidChars { message: msg },
        "record_not_found" => Error::RecordNotFound { message: msg },
        "contract_missing" => Error::ContractMissing {
            message: msg,
            contract: "example.com/contracts/v1".into(),
        },
        "contract_invalid" => Error::ContractInvalid {
            message: msg,
            contract: "example.com/contracts/v1".into(),
        },
        "contract_unsatisfied" => Error::ContractUnsatisfied {
            message: msg,
            contract: "example.com/contracts/v1".into(),
            issues: vec![ValidationIssue {
                path: vec!["email".into()],
                message: "must match pattern".into(),
                source: IssueSource::JsonSchema,
                schema_path: Some("#/properties/email/pattern".into()),
                code: Some("pattern".into()),
                contract: Some("example.com/contracts/v1".into()),
                record: Some("people/jane".into()),
            }],
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;

    #[test]
    fn echo_batch_preserves_a_batch_of_records() {
        let mut record = IndexMap::new();
        record.insert("id".to_string(), Value::Integer(7));
        record.insert("ratio".to_string(), Value::Float(1.5));
        let batch = vec![Value::Table(record), Value::String("two".into())];
        assert_eq!(echo_batch(batch.clone()), batch);
    }

    #[test]
    fn example_error_covers_every_code_and_is_none_for_unknown() {
        for code in [
            "config_missing",
            "config_invalid",
            "validation_failed",
            "transaction_in_progress",
            "transaction_required",
            "parent_moved",
            "commit_failed",
            "push_daemon_running",
            "transaction_closed",
            "index_unique_conflict",
            "index_not_defined",
            "ref_not_found",
            "not_an_ancestor",
            "path_render_failed",
            "path_invalid_chars",
            "record_not_found",
            "contract_missing",
            "contract_invalid",
            "contract_unsatisfied",
        ] {
            let err = example_error(code).expect("known code");
            assert_eq!(err.code(), code);
        }
        assert!(example_error("nope").is_none());
    }
}
