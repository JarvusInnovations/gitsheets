---
status: planned
depends: [default-branch-binding, submodule-mode]
specs:
  - specs/behaviors/default-branch.md
issues: [341]
---

# Plan: headless data recipe and skill updates

## Scope

The user-facing documentation for keeping records off the checked-out
branch: `docs/recipes/headless-data.md` with the four-layout decision table
(records on the code branch / orphan data branch / bare data clone / data
submodule), the setup commands for each, the superproject push ordering
(`push.recurseSubmodules = check|on-demand`), the `git worktree` and
`checkout HEAD -- .` escape hatches and their stale-checkout gotcha, and the
`gitsheets.*` config / env / flag layering. Update the bundled skill
(`skills/gitsheets/SKILL.md` and `references/`) and `docs/axi.md` so the
"working-tree gotcha" guidance now points at the headless layouts first and
`git checkout HEAD -- .` second. Add a `gitsheets-axi` first-run hint when a
repo has records on the checked-out branch and no binding.

Out of scope: any library or CLI behavior (previous two plans).

## Implements

- `specs/behaviors/default-branch.md` — the "documented recipe" the spec
  defers to, and the layout table's trade-offs.

## Approach

1. Write the recipe from the spec's layout table; one runnable block per
   layout, verified against the fixtures from the two implementation plans.
2. Rewrite the working-tree-gotcha paragraphs in `skills/gitsheets/SKILL.md`,
   `references/cli.md`, `references/axi.md`, `references/api.md`, and
   `docs/axi.md` / `docs/cli.md` / `docs/api.md` to lead with the binding.
3. `gitsheets-axi` hint: when neither `--branch`/`--submodule` nor their env
   or config is set and the sheet root exists in the working tree, print a
   one-line `help` pointing at the recipe after a mutating command.
4. mkdocs nav entry; README "Getting started" cross-link.

## Validation

- [ ] Every command block in the recipe runs as written against a scratch
  repo (recorded in the PR description).
- [ ] Skill and docs no longer present `git checkout HEAD -- .` as the
  primary answer to the gotcha.
- [ ] `mkdocs build --strict` passes.

## Risks / unknowns

- **Submodule setup is fiddly across git versions** (`absorbgitdirs`,
  `--no-checkout`); state the minimum git version the recipe was verified on.

## Notes

## Follow-ups
