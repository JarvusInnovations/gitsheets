---
status: done
depends: [default-branch-binding, submodule-mode, aggregate-core, rollup-sheets]
specs:
  - specs/behaviors/default-branch.md
  - specs/behaviors/aggregation.md
  - specs/behaviors/rollups.md
issues: [341, 342]
pr: 363
---

# Plan: docs coherence pass for headless data, aggregation, and rollups

## Scope

The four feature plans each updated the reference pages (`docs/api.md`,
`docs/cli.md`, `docs/axi.md`) and added their recipes, but the entry points
never learned the new capabilities existed: `README.md` had no mention of
submodules, aggregation, or rollups; the docs index did not list the two new
recipes; `docs/concepts.md` described the Repository as reading git through
hologit and knew nothing of the default branch; the migration guide stopped at
v2.9; the quick start left the first-run working-tree surprise unexplained;
`CLAUDE.md`'s spec index and CLI list were stale. This plan fills those, with
no restructuring: the Home → Quick start → Concepts → Guides → Recipes →
Migration shape still fits, and the new material is guide/recipe-level.

Out of scope: any behavior; the reference pages and recipes (already done).

## Implements

- `specs/behaviors/default-branch.md`, `specs/behaviors/aggregation.md`,
  `specs/behaviors/rollups.md` — their consumer-facing surfacing in the
  README, docs index, concepts page, migration guide, and quick start.

## Approach

1. `README.md`: a pitch paragraph on headless layouts and rollups after the
   merge/sync paragraph; `aggregate`, `--branch`, and `rollup --check` in the
   CLI examples.
2. `docs/README.md`: Concepts line names the default branch and rollup sheets;
   two new reference lines (Headless data, Aggregation and rollups); both new
   recipes in the Recipes list.
3. `docs/concepts.md`: fix the stale hologit sentence; add the default-branch
   and submodule bindings with the two `openRepo` forms; link both recipes
   from See also.
4. `docs/migration-guide.md`: a `v2.9 → v2.12` section (all additive) and the
   two recipes under Going forward.
5. `docs/quick-start.md`: explain why `git status` shows the new record as
   missing and point at the headless recipe.
6. `CLAUDE.md`: behaviors list and CLI usage list.

## Validation

- [x] `mkdocs build --strict` passes.
- [x] Every new capability of the batch is reachable from `README.md` and
  `docs/README.md` within one click.
- [x] No restructuring needed: nav unchanged.

## Risks / unknowns

- The migration guide names 2.12.0 and Python 0.7.0 ahead of the release-flow
  decision; if the bump differs, amend the heading in the release PR.

## Notes

- Authored at `status: done` in its closeout per the plans protocol's
  small-verified-change allowance; docs-only.

## Follow-ups

None.
