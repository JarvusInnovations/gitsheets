---
status: done
depends: [docs-headless-rollups-coherence]
specs:
  - specs/README.md
  - specs/architecture.md
  - specs/api/axi.md
  - specs/api/conventions.md
  - specs/api/errors.md
  - specs/api/python-binding.md
  - specs/api/repository.md
  - specs/api/sheet.md
  - specs/api/transaction.md
  - specs/behaviors/aggregation.md
  - specs/behaviors/distribution.md
  - specs/behaviors/freshness.md
  - specs/behaviors/merge.md
  - specs/behaviors/push-sync.md
  - specs/behaviors/rollups.md
pr: 369
---

# Plan: close the v2.12 spec drift audit

## Scope

A spec drift audit after v2.12.0 found spec text that no longer matched the
code, public surfaces with no spec, and a published package (`gitsheets-axi`)
with no spec. This plan fixes all three in the specs. Docs/specs only.

Out of scope: any code change; `specs/api/cli.md`, `specs/principles.md`,
`specs/behaviors/default-branch.md`, `docs/`, and `skills/`, which a parallel
pass owns.

## Implements

- **Staleness:** `refresh` / `sync` follow the default branch, not `HEAD`
  (`freshness.md`, `push-sync.md`, `repository.md`, `sheet.md`). Repository
  discovery and `sheet.clear` no longer mention hologit. `architecture.md`
  packaging, layout, and git shell-out list are current. `distribution.md`
  has the `gitsheets-axi`, docs-site, and macOS cross-compile lines.
  `errors.md` row order and `pointer_stage_failed` rationale are fixed.
- **New surfaces:** `repo.writeBlob`; `openRepo({ at })` without `submodule`;
  `TransactionResult.ref === 'HEAD'`; `Sheet` public properties;
  `sheet.rollupStatus()`; `materialize()` inside `transact`; transaction
  rollup pass and missing error codes; Python ref/blob/merge primitives and
  test-only exports; conventions' module surface and public-helper table;
  one rule each in `rollups.md`, `aggregation.md`, `merge.md`.
- **`specs/api/axi.md`:** new API spec for `gitsheets-axi`.

## Approach

Each finding was checked against `packages/gitsheets/src`,
`packages/gitsheets-axi/src`, `rust/gitsheets-core/src`, and
`rust/gitsheets-py` before any text was written. Where the source
contradicted the audit's wording, the spec follows the source. For example,
only the *default* `ours` is passed to the core fully qualified, and an
invalid aggregate spec raises `TypeError` at the call site through the napi
layer. The axi spec takes command behavior from the help texts and handlers.
It does not copy `docs/axi.md` where that page has drifted.

## Validation

- [x] Every spec claim added is traceable to a source line (repository.ts,
  sheet.ts, transaction.ts, index.ts, format/index.ts, core config.rs /
  aggregate.rs, gitsheets-py lib.rs, gitsheets-axi commands and errors.ts).
- [x] No file outside `specs/` and `plans/` changed.
- [x] `specs/README.md` layout lists `api/axi.md`.

## Risks / unknowns

- `writeBlob` and `rollupStatus` are now specced public while the source
  still tags them `@internal`. The tags are drift on the code side.

## Notes

- Authored at `status: done` in its closeout per the plans protocol's
  small-verified-change allowance; docs-only.
- `docs/axi.md` claims a `--format=json` opt-out and lists
  `VALIDATION_FAILED` as the usage-error code. Neither matches the code: there
  is no `--format` flag, and usage errors are `VALIDATION_ERROR`. The axi spec
  follows the code.

## Follow-ups

- Code: drop `@internal` from `Repository.writeBlob` and
  `Sheet.rollupStatus`.
- Code: `gitsheets-axi check --help` advertises exit codes 22 / 64, but the
  command exits 1. Either fix the help text or add a `formatError` mapping.
- Code: a malformed global `--branch` / `--submodule` exits 1 with a bare
  `error:` line instead of `VALIDATION_ERROR` / exit 2.
- Docs: `docs/axi.md` drops `--format=json`, separates `VALIDATION_ERROR`
  from `VALIDATION_FAILED`, and adds `CONFIG_MISSING`, `SHEET_DERIVED`,
  `ROLLUP_STALE`, the `CONTRACT_*` codes, and `HOOK_INSTALL_FAILED`.
