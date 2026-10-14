---
status: done
depends: [repo-sync]
specs:
  - specs/behaviors/merge.md
  - specs/api/repository.md
  - specs/api/cli.md
issues: [307]
pr: 317
---

# Plan: sheet-aware merge

## Scope

`repo.merge({ theirs, ours?, prefer?, commit? })` per `behaviors/merge.md`:
gix tree merge, then a record pass that field-merges every record path
changed on both sides and writes it canonically; `prefer` resolves field,
delete/modify and blob conflicts or they are reported with nothing
written; merge commit with two parents, CAS on the ours branch;
up-to-date and fast-forward short-circuits. CLI `git sheet merge` and the
`git sheet merge-driver` for plain `git merge`. Both bindings expose the
core (`mergeSheets` / `merge_sheets`, `mergeRecordTexts` /
`merge_record_texts`).

Depends on `repo-sync` for the gix `merge` feature and the shared
commit-resolution helpers.

Out of scope: an axi `merge` command; rename-aware record merging (a
renamed record is a delete + add to the record pass); octopus merges.

## Implements

- `specs/behaviors/merge.md`
- `specs/api/repository.md` — `repo.merge`
- `specs/api/cli.md` — `git sheet merge`, `git sheet merge-driver`

## Approach

1. **Core** `merge.rs`: `merge_values` (field-level 3-way on `Value`),
   `merge_record_texts` (parse → merge → normalize → canonical serialize
   for one record through its `Sheet`), `merge_sheets` (classification,
   gix `merge_trees`, both-side change collection via two tree diffs,
   record pass over discovered sheets, policy, commit).
2. **Bindings**: napi + pyo3 wrappers.
3. **Host**: `Repository.merge` (under `withLock`, rebind when HEAD's
   branch moved), CLI `merge` + `merge-driver` commands.
4. Tests: core (disjoint fields merge canonically — the mixed-canonical
   case; field conflict fail / prefer; delete-modify fail / prefer ours /
   prefer theirs; non-record blob conflict; fast-forward; up-to-date;
   dry-run; merge commit parents and ref CAS); host `repo.merge` and CLI
   `merge`; driver via a real `git merge` with `.gitattributes`.
5. Docs: `docs/api.md`, `docs/cli.md`, skill references.

## Validation

- [x] `cargo test`: the cases above.
- [x] napi + pytest: a disjoint-field merge round-trips.
- [x] vitest: `repo.merge` outcomes; `git sheet merge --dry-run` / conflict
      exit 1 / `--prefer theirs`; a real `git merge` with the driver
      installed yields canonical records.
- [x] clippy / type-check clean.

## Risks / unknowns

- gix leaves conflict-marker blobs in the editor tree for unresolved
  text conflicts; the record pass overwrites record paths and a
  `conflict` outcome never commits, so markers cannot reach a branch.

## Notes

- The both-side record set comes from two gix tree diffs (base→ours,
  base→theirs) with rename tracking off, intersected by path; the tree
  merge's own result for those paths is overwritten by the field merge.
- Leftover unresolved tree-merge conflicts (non-record paths) are reported
  as `blob` / `tree`, or resolved from the conflict's stage entries under
  `prefer`.
- The driver test exercises `git sheet merge-driver` directly on three temp
  files (canonical write, then the `git merge-file` marker fallback) rather
  than through a real `git merge`, which would need the built CLI on PATH.
- A dry run never reports a commit, fast-forward included.

## Follow-ups

- Tracked as: a `gitsheets-axi merge` command, and rename-aware record
  merging (a renamed record is a delete + add to the record pass), when a
  consumer asks.
