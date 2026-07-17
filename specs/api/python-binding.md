# API: Python binding (`gitsheets` on PyPI)

## Summary

The Python binding (`rust/gitsheets-py`, pyo3) is a supported consumption surface of the same Rust core the npm package runs on. Its defining guarantee: **a write from Python and a write from Node produce byte-identical commits**, continuously proven by the cross-binding parity suite in CI. Layout is mixed: the compiled extension (`gitsheets._gitsheets`) wrapped by an idiomatic pure-Python surface (`python/gitsheets/`).

## Supported surface (0.x)

The 0.x releases are honestly scoped as a **transactional writer with parity-proven batch reads**. The surface splits in two, and reads are deliberately *not* methods on an opened sheet:

**Writes** — `transact(git_dir, message, time_seconds, ...)` is a context manager yielding a `Transaction` (commits on clean exit, discards on exception):

- `open_sheet`, `upsert`, `delete`, `clear`, `will_change`, `parent_commit_hash`
- Attachments — `set_attachment(s)`, `get_attachment(s)`, `delete_attachment(s)`
- Validation: JSON Schema in-core (identical to Node); the consumer-validator hook is validator-agnostic (any callable; Pydantic works and is exercised in the test suite)

**Reads** — module-level batch functions over a git dir + tree, taking `(git_dir, tree_ref, base, ...)` and returning records directly: `record_read`, `record_list`, `record_query`, `record_query_candidates`, alongside lower-level primitives (`parse_records`, `serialize_records`, `render_paths_batch`, `validate_batch`, `write_blob`, `create_patch`/`apply_merge_patch`/`diff_records`, `core_discover_sheets`, `record_index_unique`/`record_index_multi`). This is a batch-first FFI boundary — intentionally not the object-oriented `openRepo`/`Store`/`Sheet` API the Node/TS docs describe. Consumers coming from the JS surface should expect the writer + batch-read shape, which the bundled README states up front.

## Known gaps (documented, tracked, not blockers for 0.x)

Per [#240](https://github.com/JarvusInnovations/gitsheets/issues/240): no freshness model (`refresh`/auto-refresh after commit) and no streaming blob reads. No push daemon. These reach parity as #240 lands; the 0.x README states them plainly.

## Versioning

Version lives in `rust/gitsheets-py/Cargo.toml` (maturin reads it); releases follow the `py-v*` track per [behaviors/distribution.md](../behaviors/distribution.md). Pre-1.0 semver: breaking surface changes bump the minor.

## Naming

The PyPI package name is `gitsheets` (verified unregistered as of 2026-07-12; the first trusted-publish claims it via a pending publisher).
