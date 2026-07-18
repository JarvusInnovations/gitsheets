//! The typed error surface.
//!
//! Mirrors the consumer-facing taxonomy in
//! [`specs/api/errors.md`](../../../specs/api/errors.md). The core owns the
//! *variants* (stable, matchable discriminants — **not** stringly-typed); each
//! binding maps a variant to its host's idiomatic exception class. The Node
//! binding maps these onto the `GitsheetsError` subclasses from `errors.md`,
//! carrying the stable `code` and HTTP-style `status` across the FFI boundary.
//!
//! This directly answers the holo-tree finding (`notes/holo-tree-findings.md`
//! §4) that `holo_tree::Error` flattens to an opaque string across FFI: here a
//! variant's identity (and its `code`/`status`/`class`) survives the crossing,
//! so a binding branches on cause without parsing prose.

/// Which validation layer raised a [`ValidationIssue`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IssueSource {
    JsonSchema,
    StandardSchema,
}

impl IssueSource {
    /// The wire string used on the Node surface (`ValidationIssue.source`).
    pub fn as_str(self) -> &'static str {
        match self {
            IssueSource::JsonSchema => "json-schema",
            IssueSource::StandardSchema => "standard-schema",
        }
    }
}

/// A single validation failure, mirroring `ValidationIssue` in `errors.md`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationIssue {
    pub path: Vec<String>,
    pub message: String,
    pub source: IssueSource,
    pub schema_path: Option<String>,
    pub code: Option<String>,
    /// The contract name, when the failing schema branch is a declared
    /// contract composed via `allOf` (see `specs/behaviors/contracts.md`
    /// "Composition and enforcement"). `None` for an issue raised by the
    /// sheet's own `[gitsheet.schema]` branch, and always `None` for a sheet
    /// that declares no contracts.
    pub contract: Option<String>,
    /// The record's sheet-relative path, in a multi-record conformance report
    /// (`ContractError.issues` from `contracts-consumer-verify`'s rung-2
    /// structural validation — see `specs/behaviors/contracts.md` "Consumer
    /// verification"). `None` for a single-record write-time issue.
    pub record: Option<String>,
}

/// The error class a variant maps to on the Node surface. These names match the
/// exported `GitsheetsError` subclasses in `errors.md` exactly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorClass {
    ConfigError,
    ValidationError,
    TransactionError,
    IndexError,
    RefError,
    PathTemplateError,
    NotFoundError,
    ContractError,
}

impl ErrorClass {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorClass::ConfigError => "ConfigError",
            ErrorClass::ValidationError => "ValidationError",
            ErrorClass::TransactionError => "TransactionError",
            ErrorClass::IndexError => "IndexError",
            ErrorClass::RefError => "RefError",
            ErrorClass::PathTemplateError => "PathTemplateError",
            ErrorClass::NotFoundError => "NotFoundError",
            ErrorClass::ContractError => "ContractError",
        }
    }
}

/// The typed core error. Each variant corresponds to exactly one row of the
/// `errors.md` code table, so the discriminant carries a stable `code`,
/// `status`, and target `class`. Variants hold the human-readable `message`
/// and any class-specific payload (validation `issues`, conflicting paths).
#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    // ── ConfigError ──────────────────────────────────────────────────────
    /// `config_missing` — `.gitsheets/<name>.toml` not found.
    ConfigMissing { message: String },
    /// `config_invalid` — sheet config TOML malformed or schema unparseable.
    ConfigInvalid { message: String },

    // ── ValidationError ──────────────────────────────────────────────────
    /// `validation_failed` — record failed JSON Schema / Standard Schema.
    ValidationFailed {
        message: String,
        issues: Vec<ValidationIssue>,
    },

    // ── TransactionError ─────────────────────────────────────────────────
    /// `transaction_in_progress` — concurrent `repo.transact` attempt.
    TransactionInProgress { message: String },
    /// `transaction_required` — mutation outside a transaction in strict mode.
    TransactionRequired { message: String },
    /// `parent_moved` — optimistic-concurrency conflict at commit.
    ParentMoved { message: String },
    /// `commit_failed` — `git commit-tree` / `update-ref` non-zero.
    CommitFailed { message: String },
    /// `push_daemon_running` — `startPushDaemon` while one is already active.
    PushDaemonRunning { message: String },
    /// `transaction_closed` — `tx.sheet(...)` after finalize/discard.
    TransactionClosed { message: String },

    // ── IndexError ───────────────────────────────────────────────────────
    /// `index_unique_conflict` — a unique index would be violated.
    IndexUniqueConflict {
        message: String,
        conflicting_paths: Vec<String>,
    },
    /// `index_not_defined` — `findByIndex` for an undeclared index.
    IndexNotDefined { message: String },

    // ── RefError ─────────────────────────────────────────────────────────
    /// `ref_not_found` — resolution of a ref / commit-hash failed.
    RefNotFound { message: String },
    /// `not_an_ancestor` — merge-like op where src is not an ancestor of dst.
    NotAnAncestor { message: String },

    // ── PathTemplateError ────────────────────────────────────────────────
    /// `path_render_failed` — template can't render against the record.
    PathRenderFailed { message: String },
    /// `path_invalid_chars` — rendered path has filesystem-illegal characters.
    PathInvalidChars { message: String },

    // ── NotFoundError ────────────────────────────────────────────────────
    /// `record_not_found` — operation against a path that doesn't exist.
    RecordNotFound { message: String },

    // ── ContractError ────────────────────────────────────────────────────
    /// `contract_missing` — `implements` names a contract with no vendored
    /// document at its derived path.
    ContractMissing { message: String, contract: String },
    /// `contract_invalid` — the contract document violates a document
    /// requirement (compile failure, `$id`/path mismatch, non-canonical
    /// bytes, external `$ref`, null-bearing keyword, closed for extension).
    ContractInvalid { message: String, contract: String },
    /// `contract_unsatisfied` — consumer verification failed both rungs,
    /// carrying the conformance report. The code is reserved here by the
    /// error-marshalling architecture; the consumer verification ladder
    /// itself (`openSheet(name, { contract })` / `contracts test`) is a
    /// separate, later plan — nothing in this crate constructs this variant
    /// yet.
    ContractUnsatisfied {
        message: String,
        contract: String,
        issues: Vec<ValidationIssue>,
    },
}

impl Error {
    /// The stable `code` string from the `errors.md` code table. These strings
    /// never change meaning.
    pub fn code(&self) -> &'static str {
        match self {
            Error::ConfigMissing { .. } => "config_missing",
            Error::ConfigInvalid { .. } => "config_invalid",
            Error::ValidationFailed { .. } => "validation_failed",
            Error::TransactionInProgress { .. } => "transaction_in_progress",
            Error::TransactionRequired { .. } => "transaction_required",
            Error::ParentMoved { .. } => "parent_moved",
            Error::CommitFailed { .. } => "commit_failed",
            Error::PushDaemonRunning { .. } => "push_daemon_running",
            Error::TransactionClosed { .. } => "transaction_closed",
            Error::IndexUniqueConflict { .. } => "index_unique_conflict",
            Error::IndexNotDefined { .. } => "index_not_defined",
            Error::RefNotFound { .. } => "ref_not_found",
            Error::NotAnAncestor { .. } => "not_an_ancestor",
            Error::PathRenderFailed { .. } => "path_render_failed",
            Error::PathInvalidChars { .. } => "path_invalid_chars",
            Error::RecordNotFound { .. } => "record_not_found",
            Error::ContractMissing { .. } => "contract_missing",
            Error::ContractInvalid { .. } => "contract_invalid",
            Error::ContractUnsatisfied { .. } => "contract_unsatisfied",
        }
    }

    /// The error class this variant maps to on a binding's surface.
    pub fn class(&self) -> ErrorClass {
        match self {
            Error::ConfigMissing { .. } | Error::ConfigInvalid { .. } => ErrorClass::ConfigError,
            Error::ValidationFailed { .. } => ErrorClass::ValidationError,
            Error::TransactionInProgress { .. }
            | Error::TransactionRequired { .. }
            | Error::ParentMoved { .. }
            | Error::CommitFailed { .. }
            | Error::PushDaemonRunning { .. }
            | Error::TransactionClosed { .. } => ErrorClass::TransactionError,
            Error::IndexUniqueConflict { .. } | Error::IndexNotDefined { .. } => {
                ErrorClass::IndexError
            }
            Error::RefNotFound { .. } | Error::NotAnAncestor { .. } => ErrorClass::RefError,
            Error::PathRenderFailed { .. } | Error::PathInvalidChars { .. } => {
                ErrorClass::PathTemplateError
            }
            Error::RecordNotFound { .. } => ErrorClass::NotFoundError,
            Error::ContractMissing { .. }
            | Error::ContractInvalid { .. }
            | Error::ContractUnsatisfied { .. } => ErrorClass::ContractError,
        }
    }

    /// The HTTP-style status hint from the code table.
    pub fn status(&self) -> u16 {
        match self {
            Error::ConfigMissing { .. }
            | Error::ConfigInvalid { .. }
            | Error::CommitFailed { .. }
            | Error::IndexNotDefined { .. }
            | Error::ContractMissing { .. }
            | Error::ContractInvalid { .. } => 500,
            Error::ValidationFailed { .. }
            | Error::PathRenderFailed { .. }
            | Error::PathInvalidChars { .. }
            | Error::ContractUnsatisfied { .. } => 422,
            Error::TransactionInProgress { .. }
            | Error::TransactionRequired { .. }
            | Error::ParentMoved { .. }
            | Error::PushDaemonRunning { .. }
            | Error::TransactionClosed { .. }
            | Error::IndexUniqueConflict { .. }
            | Error::NotAnAncestor { .. } => 409,
            Error::RefNotFound { .. } | Error::RecordNotFound { .. } => 404,
        }
    }

    /// The human-readable message.
    pub fn message(&self) -> &str {
        match self {
            Error::ConfigMissing { message }
            | Error::ConfigInvalid { message }
            | Error::ValidationFailed { message, .. }
            | Error::TransactionInProgress { message }
            | Error::TransactionRequired { message }
            | Error::ParentMoved { message }
            | Error::CommitFailed { message }
            | Error::PushDaemonRunning { message }
            | Error::TransactionClosed { message }
            | Error::IndexUniqueConflict { message, .. }
            | Error::IndexNotDefined { message }
            | Error::RefNotFound { message }
            | Error::NotAnAncestor { message }
            | Error::PathRenderFailed { message }
            | Error::PathInvalidChars { message }
            | Error::RecordNotFound { message }
            | Error::ContractMissing { message, .. }
            | Error::ContractInvalid { message, .. }
            | Error::ContractUnsatisfied { message, .. } => message,
        }
    }

    /// Validation issues, present for [`Error::ValidationFailed`] and (the
    /// conformance report) [`Error::ContractUnsatisfied`].
    pub fn issues(&self) -> &[ValidationIssue] {
        match self {
            Error::ValidationFailed { issues, .. } => issues,
            Error::ContractUnsatisfied { issues, .. } => issues,
            _ => &[],
        }
    }

    /// The contract name in scope, present only for the `ContractError`
    /// variants (`contract_missing` / `contract_invalid` /
    /// `contract_unsatisfied`).
    pub fn contract(&self) -> Option<&str> {
        match self {
            Error::ContractMissing { contract, .. }
            | Error::ContractInvalid { contract, .. }
            | Error::ContractUnsatisfied { contract, .. } => Some(contract),
            _ => None,
        }
    }

    /// Conflicting paths, present only for [`Error::IndexUniqueConflict`].
    pub fn conflicting_paths(&self) -> &[String] {
        match self {
            Error::IndexUniqueConflict {
                conflicting_paths, ..
            } => conflicting_paths,
            _ => &[],
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code(), self.message())
    }
}

impl std::error::Error for Error {}

/// Convenience alias used throughout the core.
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_classes_and_statuses_match_the_spec_table() {
        let cases: &[(Error, &str, ErrorClass, u16)] = &[
            (
                Error::ConfigMissing { message: "x".into() },
                "config_missing",
                ErrorClass::ConfigError,
                500,
            ),
            (
                Error::ValidationFailed {
                    message: "x".into(),
                    issues: vec![],
                },
                "validation_failed",
                ErrorClass::ValidationError,
                422,
            ),
            (
                Error::ParentMoved { message: "x".into() },
                "parent_moved",
                ErrorClass::TransactionError,
                409,
            ),
            (
                Error::IndexUniqueConflict {
                    message: "x".into(),
                    conflicting_paths: vec!["a".into()],
                },
                "index_unique_conflict",
                ErrorClass::IndexError,
                409,
            ),
            (
                Error::RefNotFound { message: "x".into() },
                "ref_not_found",
                ErrorClass::RefError,
                404,
            ),
            (
                Error::PathRenderFailed { message: "x".into() },
                "path_render_failed",
                ErrorClass::PathTemplateError,
                422,
            ),
            (
                Error::RecordNotFound { message: "x".into() },
                "record_not_found",
                ErrorClass::NotFoundError,
                404,
            ),
            (
                Error::ContractMissing {
                    message: "x".into(),
                    contract: "example.com/c/v1".into(),
                },
                "contract_missing",
                ErrorClass::ContractError,
                500,
            ),
            (
                Error::ContractInvalid {
                    message: "x".into(),
                    contract: "example.com/c/v1".into(),
                },
                "contract_invalid",
                ErrorClass::ContractError,
                500,
            ),
            (
                Error::ContractUnsatisfied {
                    message: "x".into(),
                    contract: "example.com/c/v1".into(),
                    issues: vec![],
                },
                "contract_unsatisfied",
                ErrorClass::ContractError,
                422,
            ),
        ];
        for (err, code, class, status) in cases {
            assert_eq!(err.code(), *code);
            assert_eq!(err.class(), *class);
            assert_eq!(err.status(), *status);
        }
    }

    #[test]
    fn validation_issues_are_carried() {
        let err = Error::ValidationFailed {
            message: "bad".into(),
            issues: vec![ValidationIssue {
                path: vec!["email".into()],
                message: "must match pattern".into(),
                source: IssueSource::JsonSchema,
                schema_path: Some("#/properties/email/pattern".into()),
                code: Some("pattern".into()),
                contract: None,
                record: None,
            }],
        };
        assert_eq!(err.issues().len(), 1);
        assert_eq!(err.issues()[0].source.as_str(), "json-schema");
    }

    #[test]
    fn contract_error_carries_the_contract_name() {
        let err = Error::ContractMissing {
            message: "x".into(),
            contract: "example.com/c/v1".into(),
        };
        assert_eq!(err.contract(), Some("example.com/c/v1"));
        assert_eq!(Error::RecordNotFound { message: "x".into() }.contract(), None);
    }

    #[test]
    fn contract_unsatisfied_carries_its_conformance_report() {
        let err = Error::ContractUnsatisfied {
            message: "bad".into(),
            contract: "example.com/c/v1".into(),
            issues: vec![ValidationIssue {
                path: vec!["email".into()],
                message: "must match pattern".into(),
                source: IssueSource::JsonSchema,
                schema_path: Some("#/properties/email/pattern".into()),
                code: Some("pattern".into()),
                contract: Some("example.com/c/v1".into()),
                record: Some("people/jane".into()),
            }],
        };
        assert_eq!(err.issues().len(), 1);
        assert_eq!(err.issues()[0].contract.as_deref(), Some("example.com/c/v1"));
    }
}
