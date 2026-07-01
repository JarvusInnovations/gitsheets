"""gitsheets — a git-backed document store, Python binding.

This is the thin Python surface over the compiled ``gitsheets._gitsheets``
extension, which is itself a thin pyo3 binding over the shared Rust
``gitsheets-core`` engine. Everything that determines on-disk bytes (canonical
TOML, path rendering, validation, the embedded JS engine, the
Sheet/Transaction/Store state machine) lives in the core — so a record written
from Python and the same record written from the Node binding produce
byte-identical trees, blobs, and commits.

The binding marshals Python natives ↔ the core value type with full TOML type
fidelity: ``int`` ↔ TOML integer (arbitrary precision in, ``i64`` in the core),
``float`` ↔ TOML float (kept distinct from int), ``datetime.datetime`` ↔ TOML
datetime (an aware UTC instant, mirroring the Node ``Date`` projection),
``dict`` ↔ table, ``list`` ↔ array.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Callable, Iterator, Optional

from . import _gitsheets as _core

# ── re-exported native surface ────────────────────────────────────────────────

# Typed exception hierarchy (mirrors the Node binding's GitsheetsError classes).
GitsheetsError = _core.GitsheetsError
ConfigError = _core.ConfigError
ValidationError = _core.ValidationError
TransactionError = _core.TransactionError
IndexError = _core.IndexError  # noqa: A001 — intentional: gitsheets.IndexError
RefError = _core.RefError
PathTemplateError = _core.PathTemplateError
NotFoundError = _core.NotFoundError

# Stateful classes.
CompiledDefinition = _core.CompiledDefinition
CoreTransaction = _core.CoreTransaction

# Batch-first functions (the FFI marshalling boundary).
roundtrip = _core.roundtrip
parse_records = _core.parse_records
serialize_records = _core.serialize_records
render_paths_batch = _core.render_paths_batch
validate_batch = _core.validate_batch
run_comparator = _core.run_comparator
record_read = _core.record_read
record_write = _core.record_write
record_delete = _core.record_delete
record_list = _core.record_list
write_blob = _core.write_blob
substrate_stats = _core.substrate_stats
substrate_reset = _core.substrate_reset
create_patch = _core.create_patch
apply_merge_patch = _core.apply_merge_patch
diff_records = _core.diff_records
record_query = _core.record_query
record_query_candidates = _core.record_query_candidates
template_field_names = _core.template_field_names
record_index_unique = _core.record_index_unique
record_index_multi = _core.record_index_multi
core_discover_sheets = _core.core_discover_sheets
core_check_validators = _core.core_check_validators
simulate_core_error = _core.simulate_core_error

#: The git empty-tree hash — a valid ``base_ref`` for a from-scratch write.
EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

__all__ = [
    "GitsheetsError",
    "ConfigError",
    "ValidationError",
    "TransactionError",
    "IndexError",
    "RefError",
    "PathTemplateError",
    "NotFoundError",
    "CompiledDefinition",
    "CoreTransaction",
    "Transaction",
    "transact",
    "EMPTY_TREE_HASH",
    "roundtrip",
    "parse_records",
    "serialize_records",
    "render_paths_batch",
    "validate_batch",
    "run_comparator",
    "record_read",
    "record_write",
    "record_delete",
    "record_list",
    "write_blob",
    "substrate_stats",
    "substrate_reset",
    "create_patch",
    "apply_merge_patch",
    "diff_records",
    "record_query",
    "record_query_candidates",
    "template_field_names",
    "record_index_unique",
    "record_index_multi",
    "core_discover_sheets",
    "core_check_validators",
    "simulate_core_error",
]

# Type for a consumer-supplied runtime validator: it receives the normalized
# record (a dict) and either returns / mutates nothing on success or raises to
# reject the write before any bytes are staged.
Validator = Callable[[dict], Any]


class Transaction:
    """An idiomatic facade over :class:`CoreTransaction`.

    Drives the two-phase consumer-validator protocol: :meth:`upsert` runs the
    core's phase-1 pipeline (shape-validate → normalize → render → unique-check
    → serialize), hands the normalized record to the optional Python
    ``validate`` callback, and only then stages the write. The callback runs
    with **no core lock held** — phase 1 and phase 3 are separate FFI calls.

    Use via :func:`transact`, which commits on success and discards on error.
    """

    def __init__(self, inner: CoreTransaction) -> None:
        self._inner = inner

    def open_sheet(
        self,
        name: str,
        config_path: str,
        open_root: str = ".",
        prefix: str = "",
    ) -> "Transaction":
        self._inner.open_sheet(name, config_path, open_root, prefix)
        return self

    def upsert(
        self,
        sheet: str,
        record: dict,
        *,
        validate: Optional[Validator] = None,
        previous_path: Optional[str] = None,
    ) -> dict:
        """Upsert ``record`` into ``sheet`` (prepare → validate → stage)."""
        candidate = self._inner.prepare_upsert(sheet, record, previous_path)
        if validate is not None:
            validate(candidate["record"])
        return self._inner.stage_upsert(sheet)

    def will_change(
        self,
        sheet: str,
        record: dict,
        previous_path: Optional[str] = None,
    ) -> dict:
        return self._inner.will_change(sheet, record, previous_path)

    def delete(self, sheet: str, record_path: str) -> None:
        self._inner.delete(sheet, record_path)

    def clear(self, sheet: str) -> None:
        self._inner.clear(sheet)

    def set_attachment(
        self, sheet: str, record_path: str, name: str, blob_hash: str
    ) -> None:
        """Stage a single attachment (`name → blob_hash`) for ``record_path``."""
        self._inner.set_attachment(sheet, record_path, name, blob_hash)

    def set_attachments(
        self, sheet: str, record_path: str, attachments: dict[str, str]
    ) -> None:
        """Stage attachments (a ``{name: blob_hash}`` dict) for ``record_path``."""
        self._inner.set_attachments(sheet, record_path, attachments)

    def get_attachments(
        self, sheet: str, record_path: str
    ) -> Optional[dict[str, str]]:
        """The ``{name: hash}`` map of a record's attachments, or ``None``."""
        return self._inner.get_attachments(sheet, record_path)

    def get_attachment(
        self, sheet: str, record_path: str, name: str
    ) -> Optional[str]:
        """The blob hash of a single named attachment, or ``None``."""
        return self._inner.get_attachment(sheet, record_path, name)

    def delete_attachment(self, sheet: str, record_path: str, name: str) -> None:
        """Remove a single named attachment (strict — raises if absent)."""
        self._inner.delete_attachment(sheet, record_path, name)

    def delete_attachments(self, sheet: str, record_path: str) -> bool:
        """Remove all attachments for a record (no-op when none). Returns removed?"""
        return self._inner.delete_attachments(sheet, record_path)

    @property
    def parent_commit_hash(self) -> Optional[str]:
        return self._inner.parent_commit_hash()


@contextmanager
def transact(
    git_dir: str,
    message: str,
    time_seconds: int,
    *,
    offset_minutes: int = 0,
    parent: Optional[str] = None,
    branch: Optional[str] = None,
    author: Optional[tuple[str, str]] = None,
    committer: Optional[tuple[str, str]] = None,
    trailers: Optional[list[tuple[str, str]]] = None,
) -> Iterator[Transaction]:
    """Open a transaction, commit on success, discard on error.

    Yields a :class:`Transaction`. On clean exit the transaction is finalized
    (commit-on-success-only, with no-op detection); on exception it is
    discarded, releasing the single-writer slot. The finalized result dict is
    available on the manager's ``.result`` after the block via the returned
    facade's ``_result`` — most callers just need the commit to land, so the
    common path is fire-and-forget.
    """
    inner = CoreTransaction.begin(
        git_dir,
        message,
        time_seconds,
        offset_minutes,
        parent,
        branch,
        author,
        committer,
        trailers,
    )
    facade = Transaction(inner)
    try:
        yield facade
    except BaseException:
        inner.discard()
        raise
    else:
        facade.result = inner.finalize()  # type: ignore[attr-defined]
