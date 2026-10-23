---
status: done
pr: 346
depends: []
specs:
  - specs/behaviors/default-branch.md
  - specs/principles.md
  - specs/api/repository.md
  - specs/api/store.md
  - specs/api/transaction.md
  - specs/api/cli.md
  - specs/behaviors/freshness.md
  - specs/behaviors/transactions.md
  - specs/concepts.md
issues: [341]
---

# Plan: default-branch binding (branch mode)

## Scope

Replace the hard-wired `HEAD` default throughout the Node binding and the
CLIs with a resolved **default branch**: `openRepo({ branch })` →
`GITSHEETS_BRANCH` → `gitsheets.branch` git config → `HEAD`'s branch. Live
sheets, permissive writes, `transact` defaults, freshness rebinds,
`refresh`, `sync` / `fetch`, the push daemon, and `merge` all follow it.
`repo.branch` reports it. An unborn default branch is a fresh-repo start.
CLI: `--branch` / `GITSHEETS_BRANCH` on `git sheet` and `gitsheets-axi`;
`--ref` defaults to the resolved branch; `git sheet init --commit`.

Docs: `docs/recipes/headless-data.md` covering the branch-mode layouts (records
on the code branch, orphan data branch, bare data clone) with the `git
worktree` / `checkout HEAD -- .` escape hatches and their stale-checkout
gotcha, plus the `gitsheets.*` config / env / flag layering; docs/api.md and
docs/cli.md.

Out of scope: submodule mode (its own feature branch, `submodule-mode`,
which extends the recipe with the submodule layout and rewrites the skill's
working-tree-gotcha guidance). The Python binding's batch surface already takes
an explicit `tree_ref` on every call, so nothing changes there beyond
documenting that `gitsheets.branch` is a Node/CLI concern.

## Implements

- `specs/behaviors/default-branch.md` — Resolution (branch-mode rows), What
  the default branch governs, CLI (`--branch` row, `--ref` default),
  Bootstrapping (`init --commit`).
- `specs/principles.md` — Behave like a first-party git extension.
- `specs/api/repository.md` — `openRepo` `branch`, `repo.branch`, every
  "default: the default branch" on `transact` / `refresh` / `sync` / `fetch`
  / `startPushDaemon` / `merge`.
- `specs/api/store.md`, `specs/api/transaction.md`,
  `specs/behaviors/transactions.md`, `specs/behaviors/freshness.md` — the
  rerouted defaults.
- `specs/api/cli.md` — global flags, `init --commit`.

## Approach

1. **Resolution** in `Repository` construction (`repository.ts`): a private
   `#binding = { branch: string | null }` computed once from `opts.branch`,
   `process.env.GITSHEETS_BRANCH`, `git config --get gitsheets.branch`
   (shell out; no core change needed), else `git symbolic-ref HEAD`. Validate
   a branch name (`git check-ref-format --branch`); reject tags/commits with
   `ConfigError(config_invalid)`.
2. **Route every `HEAD` site** through it: the read-tree resolver
   (`<branch>^{tree}`, empty tree when unborn), `transact` default parent and
   branch, the post-commit auto-refresh condition (`result.ref === binding
   branch`), `refresh`, `#syncBranch` (the helper `sync`/`fetch` share),
   `startPushDaemon`, `merge` `ours`. `tag` keeps literal `HEAD`.
3. **Unborn branch**: the existing fresh-repo path (#19) already handles "no
   commits"; generalize its check from "HEAD unresolvable" to "default branch
   unresolvable" so the first commit creates the branch.
4. **CLI** (`cli/shared.ts`): `--branch` global flag + `GITSHEETS_BRANCH`;
   pass to `openRepo`; `--ref` default becomes `repo.branch ?? 'HEAD'`.
   `init --commit`: open a transaction, `tx.writeFile('.gitsheets/<sheet>.toml', …)`,
   commit; implied when the target ref is not the checked-out branch or the
   repo is bare. Mirror the flag/env in `gitsheets-axi` (`context.ts`).
5. **Docs**: write the recipe from the spec's layout table, one runnable
   block per layout, verified against the test fixtures; mkdocs nav entry.
6. **Tests**: bound-branch reads/writes with HEAD elsewhere; env and config
   tiers and their precedence; unborn branch bootstrap via `init --commit`
   and via a first `transact`; auto-refresh fires for the bound branch and
   not for a side-branch commit; `sync` / daemon / `merge` defaults with a
   detached HEAD and a bound branch; config-invalid on a tag.

## Validation

- [x] vitest: the cases in step 5; the existing freshness, sync, merge,
  push-daemon, and CLI suites pass unchanged.
- [x] `git -C <clone> config gitsheets.branch data` with no code change
  makes both `openRepo()` and `git sheet query` read `data`.
- [x] `git sheet init users --commit --branch data` on a repo with no
  `data` branch creates it with a root commit holding only the config, and
  `git status` on the checked-out branch is clean.
- [x] `npm run type-check` clean; docs/api.md and docs/cli.md updated for
  the new option, flag, and env.
- [x] Every command block in `docs/recipes/headless-data.md` runs as written
  against a scratch repo (recorded in the PR); `mkdocs build --strict` passes.

## Risks / unknowns

- **Config reads on every `openRepo`** add two `git` subprocesses. Acceptable
  (open is not hot); if it shows up, read `.git/config` via the core's gix
  handle instead.
- **Consumers relying on "HEAD" literally** (e.g. passing `'HEAD'` as
  `parent`) are unaffected — explicit refs keep meaning git's HEAD. Call this
  out in the changelog.

## Notes

- **Spec amendments (two `docs(specs):` commits ahead of the code).** (1) `init`
  has always committed its config through a transaction (both CLIs; pinned by
  `cli-init.test.ts`), so the spec's "working-tree scaffold unless `--commit`"
  described behavior that never existed. Amended to: `init` commits to the
  target ref, `--commit` is the explicit spelling, an absent branch gets a
  root commit. Implementing the spec literally would have broken the existing
  init suite and changed a default nobody asked to change. (2)
  `gitsheets-axi --branch` is accepted on any command (either position), not
  "before the command": the AXI SDK rejects leading flags, and `push
  --branch` already meant the branch to push, which is what the binding
  selects. Also fixed a corrupted heading and two garbled sentences in the
  spec as merged.
- **Binding is resolved once at open.** With no option/env/config, the
  repository binds to HEAD's branch *as of open*; only a detached-HEAD
  binding (`repo.branch === null`) keeps following HEAD live, which is
  exactly the pre-binding code path.
- **Touches the napi crate (review round 1).** The core's `resolve_parent`
  only knows HEAD's own unborn branch implicitly and fails on an explicit
  unborn `parent`, so an unborn *other* default branch is bootstrapped
  through the core's orphan path (`orphan: true, branch: refs/heads/<b>`).
  Orphans always commit; the first cut wrapped the core transaction in a
  mutation-tracking Proxy, replaced in review by a read-only
  `CoreTransaction.isMutated()` getter over the core's existing
  `any_mutation` flag (`Transaction::is_mutated` in gitsheets-core). A
  handler that wrote nothing is discarded. HEAD's own unborn branch still
  takes the core's fresh-repo path. **Release ordering:** the JS package now
  calls a new addon method, so the CLAUDE.md core-napi-first rule applies to
  this batch (it already did via the sibling aggregate-core PR): tag
  `core-napi-v*` and sync manifests before the `Release: v*` PR.
- **Review round 1 also:** a branch present only as a remote-tracking ref
  is `config_invalid` (at open, and again before a bootstrap write); `repo.tag`
  defaults to the default branch's tip; `merge` passes the default `ours`
  qualified (a `2026` branch moves) with the short name kept in the default
  message; unborn default branch + an existing different `branch` and no
  `parent` is a clear `commit_failed`; `init` bootstraps only plain branch
  names from an unresolved `--ref` and rejects `--no-commit`; the CLI names
  `--branch / GITSHEETS_BRANCH` in a bad-binding error.
- **Spec drift fixed in review:** HEAD-as-default wording in
  `api/conventions.md` and `behaviors/push-sync.md`; the git-config tier reads
  as git's normal local-over-global layering (what `git config --get` does);
  `default-branch.md` gains a Python binding note (batch surface takes explicit
  refs, ignores the binding) and the remote-only rule (moved from a
  recipe-only warning into Resolution).
- A Sheet cannot be opened on an unborn branch (`config_missing` by spec), so
  the "sheet opened before the bootstrap" test holds a sheet opened after the
  config-only root commit across the record commit.
- An existing default branch is passed to the core as both `parent` and
  `branch` (`refs/heads/<b>`), so branch names `is_likely_branch` would
  misread as hashes still advance the branch.
- Auto-refresh after `transact` is now gated on `result.ref` being the default
  branch (spec: "the default branch moved", not "a commit happened").
- A tx-bound sheet with no parent commit (orphan / unborn) read config/records
  from `'HEAD'`; it now reads the empty tree.
- `willChange`'s throwaway core transaction starts at the default branch.
- The merge driver and `merge --install-driver` pin sheet discovery to git's
  `HEAD` explicitly (they serve the checked-out merge).
- `git sheet init --ref <absent-branch>` (no binding) also starts that branch
  with a root commit, per the cli.md wording.
- Recipe verification: every block ran in a scratch repo against the built
  CLI (`git-sheet` symlinked to `packages/gitsheets/bin/gitsheets`); the bare
  clone block's `git@example.com:…` URL was substituted with a local bare
  repo. `uvx … mkdocs build --strict` passed.
- Suites (after review round 1, against the locally built release addon):
  gitsheets vitest 482 (51 files), gitsheets-axi vitest 144 (16 files), napi
  node:test 141; type-check clean; `cargo clippy --workspace --all-targets
  -- -D warnings` clean; `cargo test -p gitsheets-core` 282 + 4 pass.
  `cargo fmt --check` reports repo-wide pre-existing drift (not a CI gate);
  no drift hunk starts in the two added Rust functions.

## Follow-ups

- Issue [#352](https://github.com/JarvusInnovations/gitsheets/issues/352) —
  `git sheet` read commands ignore `--ref` (pre-existing; they read the live
  default-branch sheet).
- Issue [#353](https://github.com/JarvusInnovations/gitsheets/issues/353) —
  `gitsheets-axi` post-write materialize hint is wrong when the default branch
  is not the checked-out branch.
- Issue [#355](https://github.com/JarvusInnovations/gitsheets/issues/355) —
  Python binding: honor the default-branch binding (GITSHEETS_BRANCH /
  gitsheets.branch).
