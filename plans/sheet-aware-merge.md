---
status: in-progress
depends: [repo-sync]
specs:
  - specs/behaviors/merge.md
  - specs/api/repository.md
  - specs/api/cli.md
issues: [307]
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

- [ ] `cargo test`: the cases above.
- [ ] napi + pytest: a disjoint-field merge round-trips.
- [ ] vitest: `repo.merge` outcomes; `git sheet merge --dry-run` / conflict
      exit 1 / `--prefer theirs`; a real `git merge` with the driver
      installed yields canonical records.
- [ ] clippy / type-check clean.

## Risks / unknowns

- gix leaves conflict-marker blobs in the editor tree for unresolved
  text conflicts; the record pass overwrites record paths and a
  `conflict` outcome never commits, so markers cannot reach a branch.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
