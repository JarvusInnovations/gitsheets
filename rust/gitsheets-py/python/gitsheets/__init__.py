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

import functools
from contextlib import contextmanager
from typing import Any, Callable, Iterator, Optional

from . import _gitsheets as _core
from . import _binding
from ._binding import Binding, resolve_binding

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
ContractError = _core.ContractError
AggregationError = _core.AggregationError

# Stateful classes.
CompiledDefinition = _core.CompiledDefinition
CoreTransaction = _core.CoreTransaction

# Batch-first functions (the FFI marshalling boundary).
roundtrip = _core.roundtrip
parse_records = _core.parse_records
serialize_records = _core.serialize_records
render_paths_batch = _core.render_paths_batch
validate_batch = _core.validate_batch
canonical_contract_hash = _core.canonical_contract_hash
run_comparator = _core.run_comparator
record_write = _core.record_write
record_delete = _core.record_delete
write_blob = _core.write_blob
substrate_stats = _core.substrate_stats
substrate_reset = _core.substrate_reset
create_patch = _core.create_patch
apply_merge_patch = _core.apply_merge_patch
diff_records = _core.diff_records
blob_read = _core.blob_read
blob_header = _core.blob_header
sync_branch = _core.sync_branch
is_ancestor = _core.is_ancestor
merge_sheets = _core.merge_sheets
template_field_names = _core.template_field_names
core_check_validators = _core.core_check_validators
simulate_core_error = _core.simulate_core_error

#: The git empty-tree hash — a valid ``base_ref`` for a from-scratch write.
EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


# ── defaults that follow the binding ──────────────────────────────────────────
# specs/api/python-binding.md "Default-branch binding": every read that takes a
# ``tree_ref`` accepts ``None`` for the bound default branch's tree. A plain
# ``str`` git_dir is resolved through the binding only then; an explicit ref
# keeps meaning what it meant, in the repository the call was given.


def _tree_ref_defaults(native: Callable) -> Callable:
    @functools.wraps(native)
    def call(*args: Any, **kwargs: Any) -> Any:
        positional = list(args)
        if len(positional) >= 2:
            tree_ref = positional[1]
        else:
            tree_ref = kwargs.get("tree_ref")
        if tree_ref is None:
            git_dir = positional[0] if positional else kwargs["git_dir"]
            binding = _binding.as_binding(git_dir)
            tree = _binding.default_tree(binding)
            if positional:
                positional[0] = binding
            else:
                kwargs["git_dir"] = binding
            if len(positional) >= 2:
                positional[1] = tree
            else:
                kwargs["tree_ref"] = tree
        return native(*positional, **kwargs)

    return call


record_read = _tree_ref_defaults(_core.record_read)
record_list = _tree_ref_defaults(_core.record_list)
record_query = _tree_ref_defaults(_core.record_query)
record_query_candidates = _tree_ref_defaults(_core.record_query_candidates)
record_aggregate = _tree_ref_defaults(_core.record_aggregate)
rollup_status = _tree_ref_defaults(_core.rollup_status)
verify_sheet_contract = _tree_ref_defaults(_core.verify_sheet_contract)
record_index_unique = _tree_ref_defaults(_core.record_index_unique)
record_index_multi = _tree_ref_defaults(_core.record_index_multi)
core_discover_sheets = _tree_ref_defaults(_core.core_discover_sheets)
tree_list = _tree_ref_defaults(_core.tree_list)
tree_read_blob = _tree_ref_defaults(_core.tree_read_blob)
tree_entry_hash = _tree_ref_defaults(_core.tree_entry_hash)
merge_record_texts = _tree_ref_defaults(_core.merge_record_texts)


def tag_set(git_dir: str, name: str, target: Optional[str] = None, force: bool = False) -> str:
    """Point the lightweight tag ``refs/tags/<name>`` at ``target`` — by
    default the bound default branch's tip (``HEAD`` when bound to a detached
    ``HEAD``). Refuses an existing tag unless ``force``; returns the tagged
    object id."""
    if target is None:
        binding = _binding.as_binding(git_dir)
        git_dir, target = binding, binding.ref
    return _core.tag_set(git_dir, name, target, force)

__all__ = [
    "GitsheetsError",
    "ConfigError",
    "ValidationError",
    "TransactionError",
    "IndexError",
    "RefError",
    "PathTemplateError",
    "NotFoundError",
    "ContractError",
    "AggregationError",
    "CompiledDefinition",
    "CoreTransaction",
    "Transaction",
    "transact",
    "Binding",
    "resolve_binding",
    "EMPTY_TREE_HASH",
    "roundtrip",
    "parse_records",
    "serialize_records",
    "render_paths_batch",
    "validate_batch",
    "canonical_contract_hash",
    "verify_sheet_contract",
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
    "record_aggregate",
    "rollup_status",
    "tree_read_blob",
    "tree_entry_hash",
    "blob_read",
    "blob_header",
    "sync_branch",
    "is_ancestor",
    "tree_list",
    "tag_set",
    "merge_sheets",
    "merge_record_texts",
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

    def write_file(self, path: str, content: "str | bytes") -> str:
        """Stage a raw file at ``path`` (repo-root-relative) in this
        transaction's tree — a sheet config, a contract, a fixture — so it
        lands in the same commit as the record changes. ``str`` is written as
        UTF-8, ``bytes`` as-is. Nothing is validated or normalized. Returns the
        blob hash. See specs/api/transaction.md "Raw files"."""
        return self._inner.write_file(path, content)

    def delete_file(self, path: str) -> bool:
        """Delete the raw file at ``path`` — ``write_file``'s inverse. Returns
        whether a blob existed there; a miss leaves the transaction unmutated."""
        return self._inner.delete_file(path)

    def delete_attachments(self, sheet: str, record_path: str) -> bool:
        """Remove all attachments for a record (no-op when none). Returns removed?"""
        return self._inner.delete_attachments(sheet, record_path)

    def materialize_rollups(self, sheet: str) -> dict:
        """Materialize the rollup sheet ``sheet`` (opened with
        :meth:`open_sheet` first) into this transaction: recompute every stale
        or missing rollup record and delete orphaned ones. Returns
        ``{"recomputed": [...], "deleted": [...]}`` of partition paths; nothing
        is committed when everything was fresh. ``TypeError`` on a non-rollup
        sheet. See specs/behaviors/rollups.md "Materializing explicitly".

        The commit-time rollup pass needs no call: every commit this binding
        produces regenerates the rollups of the partitions it touched."""
        return self._inner.materialize_rollups(sheet)

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
    orphan: bool = False,
) -> Iterator[Transaction]:
    """Open a transaction, commit on success, discard on error.

    With no ``parent`` (and not ``orphan``) the transaction follows the
    repository's default-branch binding (specs/api/python-binding.md
    "Default-branch binding"): ``git_dir`` — a plain path, resolved through
    :func:`resolve_binding`, or a :class:`Binding` used as-is — names the
    repository, and the commit starts at the default branch's tip and
    advances it. An unborn default branch is bootstrapped with a root commit
    (a block that stages nothing commits nothing). In submodule mode a
    default-started commit on a detached ``HEAD`` advances ``HEAD``, and the
    binding's ``stage_pointer`` stages the moved gitlink in the superproject.
    An explicit ``parent`` resolves in the repository given, as before.

    ``orphan=True`` opens an orphan root commit: the tree starts empty,
    ``parent`` is ignored, the commit has no parents and always lands;
    ``branch`` is created and must not already exist
    (specs/api/transaction.md "Parent ref handling").

    Yields a :class:`Transaction`. On clean exit the transaction is finalized
    (commit-on-success-only, with no-op detection); on exception it is
    discarded, releasing the single-writer slot. The finalized result dict
    (``commit_hash``, ``tree_hash``, ``ref_name``, ``parent_commit_hash``) is
    on the facade's ``.result`` after the block.
    """
    default_started = parent is None and not orphan
    # The pointer rule's "default-started": no parent, branch, or orphan named.
    pointer_default = default_started and branch is None
    binding: Optional[Binding] = None
    start = ("as-given", None)
    if default_started:
        binding = _binding.as_binding(git_dir)
        git_dir = binding
        start = _binding.default_start(binding)
        if start[0] == "tip":
            parent = start[1]
            if branch is None:
                branch = start[1]
        elif start[0] == "unborn":
            # Bootstrap an unborn default branch with a root commit: the core
            # resolves only HEAD's own unborn branch implicitly, so this rides
            # its orphan path (Node's repo.transact does the same).
            if branch is not None and _binding.branch_exists(binding.git_dir, branch):
                raise _binding._error(
                    TransactionError,
                    "commit_failed",
                    f"the default branch {start[1]} is unborn, so there is no tip to parent a commit onto {branch} — pass parent explicitly",
                )
            orphan = True
            if branch is None:
                branch = start[1]
    elif isinstance(git_dir, Binding):
        binding = git_dir

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
        orphan,
    )
    facade = Transaction(inner)
    try:
        yield facade
    except BaseException:
        inner.discard()
        raise
    if start[0] == "unborn" and not inner.is_mutated():
        inner.discard()
        facade.result = {  # type: ignore[attr-defined]
            "commit_hash": None,
            "tree_hash": None,
            "ref_name": None,
            "parent_commit_hash": None,
        }
        return
    result = inner.finalize()
    facade.result = result  # type: ignore[attr-defined]
    if result.get("commit_hash") is not None and binding is not None and binding.submodule is not None:
        _advance_pointer(binding, result, pointer_default, message)


def _advance_pointer(binding: Binding, result: dict, default_started: bool, message: str) -> None:
    """Submodule mode, after a commit: a default-started commit on a detached
    ``HEAD`` advances ``HEAD`` itself (strict compare-and-swap) and reports
    ``ref_name == 'HEAD'``; a commit that advanced ``HEAD``'s branch moved the
    pointer too. When the pointer moved and ``stage_pointer`` is on, stage the
    gitlink (``pointer_stage_failed`` on failure — the commit has landed).
    See specs/behaviors/default-branch.md "The pointer" / "After a commit"."""
    commit = result["commit_hash"]
    if (
        binding.branch is None
        and default_started
        and result.get("ref_name") is None
        and result.get("parent_commit_hash") is not None
    ):
        subject = message.split("\n", 1)[0]
        _binding.advance_detached_head(binding.git_dir, commit, result["parent_commit_hash"], f"gitsheets: {subject}")
        result["ref_name"] = "HEAD"
        moved = True
    else:
        ref = result.get("ref_name")
        moved = ref is not None and ref == _binding.head_branch_ref(binding.git_dir)
    if moved and binding.stage_pointer:
        _binding.stage_gitlink(binding, commit)
