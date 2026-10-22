# Behavior: Default Branch (headless data)

## Rule

Every `Repository` is bound to one **default branch**: the branch its live
sheets read from, its transactions commit to, its read snapshots follow, and
its `sync` / `fetch` / push daemon / `merge` operate on when the caller names
no ref. By default that is the branch `HEAD` points at (today's behavior).
`openRepo({ branch })` binds the repository to any other branch instead, so a
project can keep its records on a branch that is **never checked out**: no
working tree of records to fall out of step with the ref, nothing for
`git status` to report after a write, and no checkout or index cost that
grows with the number of records.

gitsheets never reads or writes the working tree on any record path. The
only working-tree touches are the deliberately file-oriented commands —
`check` (a file the user names), `init` without `--commit` (a scaffold), and
`merge --install-driver` (`.gitattributes`).

## Applies To

- [api/repository.md](../api/repository.md) — `openRepo`, `repo.branch`,
  `openSheet` / `openSheets`, `transact`, `refresh`, `sync`, `fetch`,
  `startPushDaemon`, `merge`
- [api/store.md](../api/store.md) — `openStore`, `store.refresh`
- [api/cli.md](../api/cli.md) — the `--ref` default, `init --commit`
- [behaviors/freshness.md](freshness.md) — what a rebind resolves
- [behaviors/transactions.md](transactions.md) — the default parent and
  branch of a transaction
- [behaviors/push-sync.md](push-sync.md) — the branch `sync` and the daemon
  default to

## Details

### Resolution

The default branch is resolved once, at `openRepo`:

1. `openRepo({ branch })` — explicit. The value is a branch name (`data`,
   `refs/heads/data`), never a tag, commit, or tree: writes must have
   somewhere to land. Anything else is `ConfigError` (`config_invalid`).
2. Otherwise the git config key **`gitsheets.branch`** of the opened
   repository, when set. Git config is per clone and unversioned, which is
   the point: an operator binds a deployed clone (or a developer binds their
   checkout) without changing code or committing anything, the same way
   `remote.pushDefault` works.
3. Otherwise the branch `HEAD` points at. If `HEAD` is detached and nothing
   above applies, the repository is bound to `HEAD` itself exactly as today:
   reads resolve the detached commit, a transaction with no `branch` produces
   a detached commit, and the branch-defaulting operations (`sync`, `fetch`,
   `startPushDaemon`, `merge`) throw `RefError` (`ref_not_found`) as they do
   now.

`repo.branch` reports the resolved short name (`'data'`), or `null` when the
repository is bound to a detached `HEAD`.

The default branch **may not exist yet**. Binding to an unborn branch behaves
like a fresh-but-initialized repository ([#19](https://github.com/JarvusInnovations/gitsheets/issues/19)):
`openSheets` discovers nothing, `openSheet` throws `ConfigError`
(`config_missing`), and the first committing transaction creates the branch
with a root commit. That is the bootstrap path for a data branch — see
[Bootstrapping](#bootstrapping-a-data-branch).

### What the default branch governs

Every place a spec says "`HEAD`" as a *default* means the default branch. The
table is the complete list; an operation that takes an explicit ref is
unaffected (`readBlob('HEAD', …)` still means git's `HEAD`).

| Operation | Default today | Default under a bound branch |
| --- | --- | --- |
| `openSheet(name)` / `openSheets()` / `openStore(repo)` without `ref` | live sheets on `HEAD`'s tree | live sheets on the default branch's tree |
| `transact` `parent` | `HEAD` | the default branch's tip (an unborn branch → root commit) |
| `transact` `branch` | the parent ref, if a branch | the default branch |
| permissive-mode auto-transaction | commits to `HEAD`'s branch | commits to the default branch |
| read-snapshot rebind ([freshness.md](freshness.md)) | `HEAD^{tree}` | `<default branch>^{tree}` |
| auto-refresh after a commit | when the commit advanced `HEAD`'s branch | when it advanced the default branch |
| `repo.refresh()` / `store.refresh()` | re-resolve `HEAD` | re-resolve the default branch |
| `sync` / `fetch` `branch` | `HEAD`'s branch | the default branch |
| `startPushDaemon` `branch` | `HEAD`'s branch | the default branch |
| `merge` `ours` | `HEAD`'s branch | the default branch |
| CLI `--ref` | `HEAD` | see [CLI](#cli) |

A transaction that names a different `parent` / `branch` still works exactly
as before and, as before, does not rebind the live sheets — the rebind rule
in [freshness.md](freshness.md#rebind-semantics) is "the default branch moved",
not "a commit happened". `openSheet(name, { ref })` still pins a read-only
sheet at any ref, including `HEAD` when the default branch is something else.

### CLI

The `--ref` global flag's default resolves in order: `--ref` → `GITSHEETS_REF`
→ `gitsheets.branch` git config → `HEAD`. `--commit-to` derives from the
resolved `--ref` as today. A project that sets `gitsheets.branch` once per
clone therefore gets `git sheet query users` and `gitsheets-axi` reading and
writing the data branch with no flags.

### Bootstrapping a data branch

`git sheet init <sheet>` gains `--commit`: instead of scaffolding
`.gitsheets/<sheet>.toml` in the working tree, it commits the config to the
target ref through a transaction (`tx.writeFile`), creating the branch with a
root commit when it does not exist. `--commit` is implied — the working-tree
scaffold is impossible or pointless — when the target ref is not the
checked-out branch, or the repository is bare. Editing a committed config on a
branch that is never checked out goes through the same door:
`git sheet migrate-config` and `gitsheets-axi` config commands already commit.

The documented recipe (`docs/recipes/headless-data.md`, a plan deliverable,
not a spec) covers the layouts and their trade-offs; the spec-level
commitments behind it are:

| Layout | What gitsheets needs | Working tree of records |
| --- | --- | --- |
| Records on the code branch | nothing new | yes — the known `git status` "deleted" gotcha after every write |
| Orphan data branch in the same repo | `openRepo({ branch: 'data' })` or `gitsheets.branch`; `init --commit` to start it | none; `git worktree add ../app-data data` for an occasional look |
| Separate data repository, bare clone | `openRepo({ gitDir: '/path/to/data.git' })` (`gitsheets.branch` optional) | none |
| Separate data repository as a submodule | `openRepo({ gitDir: '.git/modules/data' })` after `git submodule update --init`; the gitlink pins the snapshot a code revision was built against | only if the submodule is checked out, and then isolated in its directory |

An occasional checkout of a never-checked-out data branch (`git worktree`) has
the same gotcha as the first row: gitsheets moves the ref, the worktree's
files stay where they were, and `git -C <worktree> reset --hard` resyncs them.
That is documented, not smoothed over, per the principle below.

### Working-tree mode is a different feature

`--working` ([#165](https://github.com/JarvusInnovations/gitsheets/issues/165),
[deferred.md](../deferred.md#cli---working-global-flag--165)) reads and
writes on-disk files *instead of* a ref. It is not a sync between the ref and
the checkout and this behavior does not cover it. The headless layout is the
recommended answer for a project that today suffers the ref/working-tree
split; `--working` remains the answer for a human editing files before
committing them.

## Principles

**Local:**

- **The ref is the store; a checkout is a view.** gitsheets reads and writes
  git refs. A working tree is an optional, consumer-managed materialization
  of one of them, and gitsheets never updates it behind the user. When a
  design choice is between making the working tree follow the ref and making
  the ref not need a working tree, pick the latter: add the knob that removes
  the checkout (a bound branch, a bare clone) rather than the one that keeps
  a checkout in sync (an auto-`checkout` after commit, a watcher). The split
  people hit is a symptom of keeping live records on the branch they also
  check out, and the fix is the layout, not a reconciler.

## Coordinates with

- [api/repository.md](../api/repository.md)
- [api/store.md](../api/store.md)
- [api/cli.md](../api/cli.md)
- [behaviors/freshness.md](freshness.md)
- [behaviors/transactions.md](transactions.md)
- [behaviors/push-sync.md](push-sync.md)
- [deferred.md](../deferred.md#cli---working-global-flag--165) — `--working`
