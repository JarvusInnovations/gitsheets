---
status: planned
depends: [rollup-sheets]
specs:
  - specs/behaviors/rollups.md
  - specs/behaviors/merge.md
  - specs/behaviors/push-sync.md
issues: []
---

# Plan: rollup pass in merge and sync replay

## Scope

Run the rollup pass inside the two other commit producers so every
gitsheets-produced commit carries rollups matching its records:
`repo.merge` / `git sheet merge` (rollup paths dropped from the record pass,
regenerated for partitions changed on either side since the base, into the
merge tree, before commit or dry-run return) and `repo.sync` replay (each
replayed commit re-passed against its new parent). Document the merge
driver's limitation (stale stamps; `git sheet rollup` repairs).

Out of scope: a merge driver that regenerates rollups (it cannot — one file
at a time).

## Implements

- `specs/behaviors/rollups.md` — Merge and sync.
- `specs/behaviors/merge.md` — the rollup paragraph.
- `specs/behaviors/push-sync.md` — replay carries fresh rollups.

## Approach

1. Factor the pass from `transaction.rs` into `rollup::pass(ctx, parent_trees,
   new_tree)` taking one or two parents.
2. `merge.rs`: after the record pass, call it with `(base, merged)` so any
   partition changed on either side is recomputed; exclude rollup roots from
   conflict classification.
3. `sync.rs`: in the replay loop, after the 3-way tree merge of each commit,
   run the pass with the new parent before writing the commit.
4. Tests: two branches each adding March transactions → merged March rollup
   covers both; dry-run tree carries it too; sync replay over a remote that
   added to the same month; merge driver fixture shows a stale stamp healed
   by `git sheet rollup --check` / `rollup`.

## Validation

- [ ] vitest + cargo tests for the four cases.
- [ ] `rust-core.yml` parity: Python `merge_sheets` / `sync_branch` produce
  the same rollup bytes as Node.

## Risks / unknowns

- **Replay performance**: a long divergence replays N commits, each with a
  pass; the pass is bounded by touched partitions per commit, so this scales
  like the writes did originally.

## Notes

## Follow-ups
