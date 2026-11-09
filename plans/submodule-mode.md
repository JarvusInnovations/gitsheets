---
status: done
pr: 347
depends: [default-branch-binding]
specs:
  - specs/behaviors/default-branch.md
  - specs/api/repository.md
  - specs/api/cli.md
  - specs/concepts.md
issues: [341]
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

Docs: extend `docs/recipes/headless-data.md` with the submodule layout and
the superproject push ordering (`push.recurseSubmodules = check|on-demand`);
rewrite the bundled skill (`skills/gitsheets/SKILL.md`, `references/`) and
`docs/axi.md` so the working-tree-gotcha guidance leads with the headless
layouts and mentions `git checkout HEAD -- .` second; a `gitsheets-axi`
first-run hint when records sit on the checked-out branch with no binding.

Out of scope: pushing the superproject (user's `git push`), materializing
the submodule working tree (never).

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
7. **Docs**: recipe section, skill/axi rewrites, axi hint (after a mutating
   command when neither flag, env, nor config binds and the sheet root exists
   in the working tree).
8. **Tests** (fixtures build a superproject + submodule): commit advances
   `HEAD` on a branch and when detached; superproject `git status` shows
   `new commits` and nothing else with `ignore = dirty`; `stagePointer`
   updates the index; `at` reads the gitlinked snapshot and refuses writes;
   `submodule init` both forms; missing submodule error names the remedy.

## Validation

- [x] vitest: the cases in step 7; existing suites unchanged.
- [x] End to end: `git sheet submodule init data --url <bare fixture>`,
  `GITSHEETS_SUBMODULE=data git sheet upsert users …`, then `git status` in
  the superproject reports only `modified: data (new commits)`, and
  `git add data && git commit` pins a commit that `openRepo({ submodule:
  'data', at: 'HEAD' })` reads back.
- [x] A fresh clone of that superproject + `git sheet submodule init data`
  reads the same records with no files under `data/`.
- [x] `npm run type-check` clean; docs/api.md and docs/cli.md updated.
- [x] Recipe blocks run as written; skill and docs no longer present
  `git checkout HEAD -- .` as the primary answer to the gotcha;
  `mkdocs build --strict` passes.

## Risks / unknowns

- **Detached-`HEAD` updates** are the one place gitsheets moves `HEAD`
  itself; make the CAS (old → new) strict so a concurrent `git submodule
  update` cannot be clobbered.
- **`ignore = dirty` hides hand edits** in the submodule working tree. The
  spec accepts this; the recipe must say it plainly.
- **Windows gitdir pointer files** use forward slashes and relative paths;
  test the resolver on a relative `gitdir:` entry.

## Notes

- **Spec amendments first** (`docs(specs): pin down submodule-mode edge
  cases`, before the implementation): branch tiers resolve inside the
  submodule (`gitsheets.branch` from the submodule's own config;
  `gitsheets.submodule` from the superproject's); `stagePointer` stages only
  commits that move the pointer, and a failed index update after a landed
  commit is `commit_failed`; an `at`-bound repo refuses every ref-moving
  operation (`transact`, `sync`, `merge`, `tag`, `startPushDaemon`), and a
  gitlinked commit missing from the submodule is `ref_not_found`;
  `submodule init` branch choice (new: `--branch` → remote `HEAD`; existing:
  `.gitmodules` → `--branch` → remote `HEAD`), empty remotes need `--branch`
  and start unborn, an existing local branch is never reset on re-run, and a
  conflicting `--url` is `config_invalid`.
- **Detached-`HEAD` advance** lives in the TS shell, not the core: the core
  already produces a detached commit with no ref update, so
  `Repository.#afterSubmoduleCommit` runs `git update-ref --no-deref HEAD
  <new> <old>` (old = the transaction's parent) and maps a failed CAS to
  `parent_moved`. Only default-started transactions (no `parent` / `branch`
  / orphan) advance `HEAD`; the result's `ref` reports `'HEAD'`. No `rust/`
  change was needed.
- **`submodule init` writes git's own layout by hand** (`git clone
  --no-checkout --separate-git-dir`, then a relative `gitdir:` file and
  relative `core.worktree`) instead of `git submodule add`, which always
  checks out. `submodule.<name>.url` / `.active` / `.ignore` go in the
  superproject's local config; `ignore` is not written to `.gitmodules`, so
  each clone opts in through `submodule init`.
- **`ignore = dirty` trade-off**: it is what keeps an empty submodule working
  tree from reporting `modified content`, and it also hides hand edits under
  `data/`. The recipe says so in a warning box.
- **CLI `--branch` doubles as `submodule init --branch`** (yargs folds
  `GITSHEETS_BRANCH` into it too): the data branch of the submodule is the
  same knob in both places.
- **axi hint (#353)**: shown only when not in submodule mode, the default
  branch is the branch `HEAD` points at, and the cwd is inside a working
  tree. The plan's "sheet root exists in the working tree" was relaxed to
  "a working tree exists": a first write to a sheet whose root directory is
  not on disk yet still leaves `git status` reporting the new records, so the
  hint is still due there.
- Verified locally on **git 2.51.2** (Linux): the recipe's shell blocks ran
  as written against local bare repos via `url.<path>.insteadOf
  git@example.com:acme/`, including `push.recurseSubmodules = check`
  refusing an unpushed pointer; the TS blocks ran against the built dist.
  `mkdocs build --strict` passes. Windows gitdir pointer files were not
  exercised locally (relative `gitdir:` resolution is covered on Linux).
- The axi `bulk-patch` "large batch" test timed out once under the full
  parallel suite on this loaded machine (as on `develop`) and passed alone;
  the final full run passed outright.
- **Review round 1** (adversarial review, second spec amendment
  `docs(specs): submodule-mode review round …` ordered before the fixes):
  - **Orphaning fix.** `submodule init` on an existing module whose `HEAD`
    is detached (`git submodule update`) and holds gitsheets writes now
    fast-forwards the branch to `HEAD` before re-pointing; a diverged branch
    is `config_invalid` naming both commits and changes nothing. Before,
    re-pointing left those writes on no ref.
  - **CAS race window.** `git update-ref --no-deref HEAD <new> <old>`
    compares against the dereferenced value, so a `HEAD` that became a
    symref at the same commit passed and was re-detached. The advance now
    checks `symbolic-ref -q HEAD` first and throws `commit_failed` (the
    core's code for a failed branch update) naming the written commit. A
    window remains between the check and the swap — `update-ref` cannot
    say "only if still detached" — documented in the spec and at
    `advanceDetachedHead`. Detached-mode commits are reachable only from
    `HEAD` until pinned, and the binding is resolved at open; the recipe
    warns about both.
  - **`pointer_stage_failed`** (new `TransactionError` code, carries
    `commitHash`) replaces `commit_failed` for a landed commit whose pointer
    could not be staged; staging now runs after rebind and post-commit hooks,
    and also after a `merge` / `sync` that moves the pointer.
  - **GIT_DIR hardening.** All git subprocesses for a repository go through
    `git-exec.ts` (`gitExec` / `gitEnv`): explicit `GIT_DIR`, with
    `GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_COMMON_DIR` / `GIT_NAMESPACE`
    cleared — Repository, push daemon, author lookup, blob streaming, sheet
    tree listing, and `submodule init`. An explicit `gitDir` is discovered
    without an inherited `GIT_DIR`; with none, `GIT_DIR` still names the
    superproject, as for git. `GIT_DIR=<super>/.git git sheet --submodule
    data query users` is tested.
  - A submodule path needs a `.gitmodules` entry (`config_invalid`
    otherwise); the common-dir `modules/` fallback is gone, so a linked
    worktree gets `config_missing` until `submodule init` writes its own
    `worktrees/<id>/modules/<name>`.
  - `submodule init --url` clones before writing `.gitmodules` / local
    config (a failed clone leaves nothing; retry works) and refreshes a
    stale `submodule.<name>.url` on a matching `--url`.
  - Found while testing: an invalid `gitsheets.submodule` value was
    swallowed (the normalize threw inside the config-read `try`) and the
    repository opened without a binding; it now errors, and every
    submodule-mode `ConfigError` names its actual source (CLI and axi map
    them with the submodule hint). `at` also refuses `fetch`.
- Nothing under `rust/` changed in either round.

## Follow-ups

- Issue #361 — explicit opt-out of an inherited submodule binding
  (`openRepo({ submodule: null })` / a CLI spelling), so an exported
  `GITSHEETS_SUBMODULE` or global `gitsheets.submodule` cannot silently
  redirect code that wants the superproject.
