---
status: planned
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

- [ ] vitest: the cases in step 5; the existing freshness, sync, merge,
  push-daemon, and CLI suites pass unchanged.
- [ ] `git -C <clone> config gitsheets.branch data` with no code change
  makes both `openRepo()` and `git sheet query` read `data`.
- [ ] `git sheet init users --commit --branch data` on a repo with no
  `data` branch creates it with a root commit holding only the config, and
  `git status` on the checked-out branch is clean.
- [ ] `npm run type-check` clean; docs/api.md and docs/cli.md updated for
  the new option, flag, and env.
- [ ] Every command block in `docs/recipes/headless-data.md` runs as written
  against a scratch repo (recorded in the PR); `mkdocs build --strict` passes.

## Risks / unknowns

- **Config reads on every `openRepo`** add two `git` subprocesses. Acceptable
  (open is not hot); if it shows up, read `.git/config` via the core's gix
  handle instead.
- **Consumers relying on "HEAD" literally** (e.g. passing `'HEAD'` as
  `parent`) are unaffected — explicit refs keep meaning git's HEAD. Call this
  out in the changelog.

## Notes

## Follow-ups
