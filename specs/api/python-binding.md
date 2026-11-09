# API: Python binding (`gitsheets` on PyPI)

## Summary

The Python binding (`rust/gitsheets-py`, pyo3) is a supported consumption surface of the same Rust core the npm package runs on. Its defining guarantee: **a write from Python and a write from Node produce byte-identical commits**, continuously proven by the cross-binding parity suite in CI. Layout is mixed: the compiled extension (`gitsheets._gitsheets`) wrapped by an idiomatic pure-Python surface (`python/gitsheets/`).

## Supported surface (0.x)

The 0.x releases are honestly scoped as a **transactional writer with parity-proven batch reads**. The surface splits in two, and reads are deliberately *not* methods on an opened sheet:

**Writes** — `transact(git_dir, message, time_seconds, ...)` is a context manager yielding a `Transaction` (commits on clean exit, discards on exception):

- `open_sheet`, `upsert`, `delete`, `clear`, `will_change`, `parent_commit_hash`
- Attachments — `set_attachment(s)`, `get_attachment(s)`, `delete_attachment(s)`
- Validation: JSON Schema in-core (identical to Node); the consumer-validator hook is validator-agnostic (any callable; Pydantic works and is exercised in the test suite)

**Reads** — module-level batch functions over a git dir + tree, taking `(git_dir, tree_ref, base, ...)` and returning records directly: `record_read`, `record_list`, `record_query`, `record_query_candidates`, `record_aggregate` (ad-hoc aggregation, [behaviors/aggregation.md](../behaviors/aggregation.md): `record_query`'s arguments plus the sheet name and an `aggregates` dict in the same grammar; returns the result dict, raising `TypeError` for a malformed spec and `AggregationError` (`aggregation_failed`) for a data-dependent failure), alongside lower-level primitives (`parse_records`, `serialize_records`, `render_paths_batch`, `validate_batch`, `write_blob`, `create_patch`/`apply_merge_patch`/`diff_records`, `core_discover_sheets`, `record_index_unique`/`record_index_multi`). This is a batch-first FFI boundary — intentionally not the object-oriented `openRepo`/`Store`/`Sheet` API the Node/TS docs describe. Consumers coming from the JS surface should expect the writer + batch-read shape, which the bundled README states up front.

**Contracts** ([behaviors/contracts.md](../behaviors/contracts.md)) — the same three surfaces the Node binding carries, in the batch-first shape:

- Write-time enforcement of `implements` rides the shared core — nothing Python-specific; a contract-violating `upsert` raises the Python `ValidationError` with contract-attributed issues, byte-identically to Node.
- `canonical_contract_hash(document, format=None)` — the identity primitive: parsed data (a `dict`), or JSON/TOML text with an explicit `format` (`'json'` | `'toml'`, no auto-detection — matching the Node surface). A JSON-text input preserves literal `null`s so the null-bearing-keyword requirement stays checkable.
- `verify_sheet_contract(git_dir, tree_ref, sheet, document, format=None, mode='verify', config_path=None, root='.', prefix='')` — consumer-side verification, the module-level equivalent of Node's `openSheet(name, { contract })`: runs the two-rung ladder ([behaviors/contracts.md § Consumer verification](../behaviors/contracts.md#consumer-verification)) against the sheet at the given tree and returns the conformance report (`{name, rung, conforming, issues}` plus the verified tree hash). Failure raises `ContractError` with code `contract_unsatisfied` carrying the per-record issues. Modes `'verify'` | `'declared'` | `'structural'`, same semantics as Node. There is no drift callback — the batch surface has no live-rebind model to hook; consumers re-verify by calling again against a new tree.
- `ContractError` in the exception taxonomy with the stable codes `contract_missing` / `contract_invalid` / `contract_unsatisfied`.

**Rollup sheets** ([behaviors/rollups.md](../behaviors/rollups.md)) — the commit-time rollup pass lives in the core transaction, so every `transact` commit maintains rollups byte-identically to Node with no Python-side call. The explicit surface, in the batch-first shape:

- `record_query(..., *, sheet=None, open_root='.', prefix='', stale=None)` — with `sheet=<name>` the core opens that sheet from the tree (every open-time check, rollup resolution included); a rollup sheet then reads **through its source** (stamped records served, stale partitions recomputed, orphans dropped; `base`/`template` are ignored), with `stale='recompute'` (default) or `'serve'`. `stale=` without `sheet=` is a `TypeError`. Without `sheet=`, `record_query(base=…)` (and `record_aggregate`) over a rollup root are plain reads of the stored bytes: no read-through, so a stale partition is returned as committed. Only `sheet=` reads through.
- `rollup_status(git_dir, tree_ref, sheet, open_root='.', prefix='')` — the non-fresh partitions as `[{"path", "status"}]` (`stale` / `missing` / `orphaned`); writes nothing. `TypeError` on a non-rollup sheet.
- `Transaction.materialize_rollups(sheet)` — materialize into the open transaction (the sheet opened first); returns `{"recomputed": [...], "deleted": [...]}` and leaves the transaction unmutated (no commit) when everything is fresh. `TypeError` on a non-rollup sheet.
- Errors: a write to a rollup sheet raises `TransactionError` (code `sheet_derived`); a failed aggregate raises `AggregationError` with `sheet`, `aggregate`, and `partition` attributes and aborts the commit; a bad rollup config raises `ConfigError` (`config_invalid`) at `open_sheet`.

**Ref, blob and merge primitives** — the rest of the exported batch surface, each a module-level function over a `git_dir`:

- `sync_branch(git_dir, branch, remote_ref, time_seconds, offset_minutes=0, on_conflict='fail', conflict_branch_prefix=None, committer=None)` — the object-database half of `repo.sync()` ([behaviors/push-sync.md](../behaviors/push-sync.md)): classifies `branch` against an already-fetched `remote_ref` and moves it; returns `{outcome, old_commit, new_commit, ahead, behind, conflict_commit, conflict_branch}`. It does not fetch or push.
- `is_ancestor(git_dir, a, b)` — whether commit `a` is reachable from `b` (or equal); Node's `repo.isAncestor`.
- `tree_list(git_dir, tree_ref, path='.')` — the direct entries at `tree_ref:path` as `[{name, type, mode, hash}]`, or `None` when nothing (or a blob) is there; Node's `repo.listTree`.
- `tag_set(git_dir, name, target='HEAD', force=False)` — point the lightweight tag `refs/tags/<name>` at `target`, refusing an existing tag unless `force`; returns the tagged object id. Node's `repo.tag`.
- `merge_sheets(git_dir, ours, theirs, time_seconds, offset_minutes=0, open_root='.', prefer='fail', commit=True, message=None, author=None, committer=None)` — sheet-aware merge ([behaviors/merge.md](../behaviors/merge.md)); returns `{outcome, ours_commit, theirs_commit, base, tree, commit, merged_records, conflicts}`. `ours` is resolved as given (pass `refs/heads/<name>` for a hex-looking branch name).
- `merge_record_texts(git_dir, tree_ref, sheet_name, config_path, open_root, base, ours, theirs, prefer='fail')` — field-merge one record's three texts through the sheet at `tree_ref` (the merge-driver primitive); returns `{text, conflicts}`.
- `tree_read_blob(git_dir, tree_ref, path)` — the blob at `tree_ref:path` as `{hash, content}` (bytes), or `None` when absent or a subtree.
- `tree_entry_hash(git_dir, tree_ref, path)` — the object id of the blob at `tree_ref:path`, or `None`.
- `blob_read(git_dir, hash)` — a blob's bytes by object id, or `None`.
- `blob_header(git_dir, hash)` — `{kind, size}` from the object header without inflating it, or `None`.
- `record_write(git_dir, base_ref, base, paths, records, extension=None)` / `record_delete(git_dir, base_ref, base, paths, extension=None)` — write or delete a batch of records under `base` starting from the tree `base_ref`, returning the new tree (`{tree_hash, blob_hashes}` / `{tree_hash, existed}`); no commit, no validation, no ref movement.
- `template_field_names(template)` — the record fields a path template reads (the set a query filter prunes on).
- `core_check_validators(declared, validator_names)` — the store-open check that every validator names a declared sheet; raises `ConfigError` (`config_missing`) otherwise.
- `run_comparator(rule, a, b)` — run a raw-JS sort comparator body once in the core's engine, so a Python caller gets Node's result for the same snippet.
- `roundtrip(records)` — pass records through the core's value marshalling and back, preserving TOML type fidelity (a parity probe).

**Test-only, not API** — `substrate_stats()`, `substrate_reset()` (holo-tree's process-wide counters and the tree cache) and `simulate_core_error(code)` (raises the typed exception for a stable code, to test the error mapping) are exported for the binding's own tests. They carry no compatibility promise and may change or disappear in any release.

## Known gaps (documented, tracked, not blockers for 0.x)

Per [#240](https://github.com/JarvusInnovations/gitsheets/issues/240): no freshness model (`refresh`/auto-refresh after commit) and no streaming blob reads. No push daemon. These reach parity as #240 lands; the 0.x README states them plainly.

## Versioning

Version lives in `rust/gitsheets-py/Cargo.toml` (maturin reads it); releases follow the `py-v*` track per [behaviors/distribution.md](../behaviors/distribution.md). Pre-1.0 semver: breaking surface changes bump the minor.

## Naming

The PyPI package name is `gitsheets` (verified unregistered as of 2026-07-12; the first trusted-publish claims it via a pending publisher).
