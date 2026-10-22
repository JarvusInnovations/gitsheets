---
status: planned
depends: [default-branch-binding]
specs:
  - specs/behaviors/default-branch.md
  - specs/api/repository.md
  - specs/api/cli.md
  - specs/concepts.md
issues: []
---

# Plan: submodule mode (managed data pointer)

## Scope

`openRepo({ submodule, at?, stagePointer? })`, `GITSHEETS_SUBMODULE`,
`gitsheets.submodule`: open a submodule's repository with its `HEAD` as the
default branch so each commit advances the superproject's gitlink pointer —
a branch when `HEAD` is a symref, `HEAD` itself when detached. `at` pins
read-only to the snapshot a superproject commit-ish gitlinks. `stagePointer`
also updates the superproject index entry. `repo.submodule`. CLI
`--submodule` / env on `git sheet` and `gitsheets-axi`, and the
`git sheet submodule init <path> [--url] [--branch]` porcelain that sets a
submodule up with no record checkout and `submodule.<name>.ignore = dirty`.

Out of scope: pushing the superproject (user's `git push`; the recipe
recommends `push.recurseSubmodules`), materializing the submodule working
tree (never), the recipe itself (`headless-data-recipe`).

## Implements

- `specs/behaviors/default-branch.md` — Resolution (submodule rows),
  Submodule mode (all of it), CLI (`--submodule` row), Bootstrapping (a data
  submodule).
- `specs/api/repository.md` — `openRepo` `submodule` / `at` /
  `stagePointer`, `repo.submodule`, the `ref_not_found` row for `at`.
- `specs/api/cli.md` — `--submodule` global flag, `git sheet submodule init`.

## Approach

1. **Locate the git dir** in `openRepo`: with `submodule: p`, discover the
   superproject as today, then resolve `<super worktree>/p/.git` (file →
   its `gitdir:` target, or directory) else `<super gitdir>/modules/p`; else
   `ConfigError(config_missing)` naming `git sheet submodule init p`. The
   returned `Repository` is opened on that git dir; it keeps a handle to the
   superproject (`#superproject = { gitDir, workTree, path }`).
2. **Pointer semantics**: binding resolution runs against the submodule;
   when its `HEAD` is detached, `#binding.branch = null` *and*
   `#binding.advanceHead = true`: `transact` sets no `branch` but after a
   successful commit updates `HEAD` to the new commit (`git update-ref
   --no-deref HEAD <new> <old>`, or the core's CAS ref update on the
   symbolic `HEAD`). Sync/fetch/daemon keep their `ref_not_found` on a
   detached pointer. An explicit `branch` ≠ `HEAD`'s branch moves nothing in
   the superproject's eyes (document in tests).
3. **`stagePointer`**: after each commit in submodule mode,
   `git -C <super> update-index --cacheinfo 160000,<new>,<p>`. Never commits.
4. **`at`**: resolve `git -C <super> rev-parse <at>:<p>` → commit id;
   open every sheet ref-pinned at it (reuse `openSheets({ ref })`); mark the
   repository read-only (`transact` → `transaction_required`). `ref_not_found`
   when the path has no gitlink at that commit.
5. **`submodule init` porcelain** (`cli/`): with `--url`: `git submodule
   add --no-checkout`-equivalent — write `.gitmodules` (`path`, `url`,
   `branch`), `git clone --no-checkout <url> <p>` then `git submodule
   absorbgitdirs`, `git -C p symbolic-ref HEAD refs/heads/<b>`, set
   `submodule.<p>.ignore dirty`, `git add .gitmodules p`. Without `--url`:
   `git submodule init p`, fetch into `modules/p`, write the gitdir pointer,
   put `HEAD` on the `.gitmodules` branch at the gitlinked commit. Idempotent
   re-runs are no-ops.
6. **CLI/axi**: `--submodule` + `GITSHEETS_SUBMODULE` wired like `--branch`.
7. **Tests** (fixtures build a superproject + submodule): commit advances
   `HEAD` on a branch and when detached; superproject `git status` shows
   `new commits` and nothing else with `ignore = dirty`; `stagePointer`
   updates the index; `at` reads the gitlinked snapshot and refuses writes;
   `submodule init` both forms; missing submodule error names the remedy.

## Validation

- [ ] vitest: the cases in step 7; existing suites unchanged.
- [ ] End to end: `git sheet submodule init data --url <bare fixture>`,
  `GITSHEETS_SUBMODULE=data git sheet upsert users …`, then `git status` in
  the superproject reports only `modified: data (new commits)`, and
  `git add data && git commit` pins a commit that `openRepo({ submodule:
  'data', at: 'HEAD' })` reads back.
- [ ] A fresh clone of that superproject + `git sheet submodule init data`
  reads the same records with no files under `data/`.
- [ ] `npm run type-check` clean; docs/api.md and docs/cli.md updated.

## Risks / unknowns

- **Detached-`HEAD` updates** are the one place gitsheets moves `HEAD`
  itself; make the CAS (old → new) strict so a concurrent `git submodule
  update` cannot be clobbered.
- **`ignore = dirty` hides hand edits** in the submodule working tree. The
  spec accepts this; the recipe must say it plainly.
- **Windows gitdir pointer files** use forward slashes and relative paths;
  test the resolver on a relative `gitdir:` entry.

## Notes

## Follow-ups
