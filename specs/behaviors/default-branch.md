# Behavior: Default Branch and Submodule Mode (headless data)

## Rule

Every `Repository` is bound to one **default branch**: the branch its live
sheets read from, its transactions commit to, its read snapshots follow, and
its `sync` / `fetch` / push daemon / `merge` operate on when the caller names
no ref. By default that is the branch `HEAD` points at (today's behavior).
Two bindings let a project keep its records **off the branch it checks out**,
so no working tree of records exists to fall out of step with the ref, there
is nothing for `git status` to report after a write, and no checkout or index
cost grows with the number of records:

- **Branch mode** — `openRepo({ branch })` binds the repository to any other
  branch of the same git dir (an orphan data branch, or a bare data clone's
  branch).
- **Submodule mode** — `openRepo({ submodule })` binds the repository to a
  git submodule of the project. Writes advance the submodule's `HEAD`, so the
  superproject's gitlink — its **managed pointer** to a data snapshot — shows
  as modified and the user commits it alongside code. Every superproject
  commit then pins exactly the data it was built against.

Both modes are activated from the CLI by global flags or environment
variables. gitsheets never reads or writes record files in any working tree;
the only working-tree touches are the file-oriented commands — `check` (a
file the user names), `init` without `--commit` (a scaffold), and
`merge --install-driver` (`.gitattributes`).

## Applies To

- [api/repository.md](../api/repository.md) — `openRepo`, `repo.branch`,
  `repo.submodule`, `openSheet` / `openSheets`, `transact`, `refresh`,
  `sync`, `fetch`, `startPushDaemon`, `merge`
- [api/store.md](../api/store.md) — `openStore`, `store.refresh`
- [api/cli.md](../api/cli.md) — `--branch`, `--submodule`, the `--ref`
  default, `init --commit`, `submodule init`
- [behaviors/freshness.md](freshness.md) — what a rebind resolves
- [behaviors/transactions.md](transactions.md) — the default parent and
  branch of a transaction
- [behaviors/push-sync.md](push-sync.md) — the branch `sync` and the daemon
  default to

## Details

### Resolution

Binding is resolved once, at `openRepo`, from the first source that applies:

| Source | Branch mode | Submodule mode |
| --- | --- | --- |
| `openRepo` option | `branch: 'data'` | `submodule: 'data'` |
| environment (CLI and library alike) | `GITSHEETS_BRANCH` | `GITSHEETS_SUBMODULE` |
| git config of the opened project | `gitsheets.branch` | `gitsheets.submodule` |
| neither | the branch `HEAD` points at | — |

- `branch` is a branch name (`data`, `refs/heads/data`), never a tag, commit,
  or tree: writes must have somewhere to land. Anything else is `ConfigError`
  (`config_invalid`).
- `submodule` is the submodule's path relative to the superproject root, as
  in `.gitmodules`. The two may combine: `{ submodule: 'data', branch: 'x' }`
  binds to branch `x` *of the submodule* (see "Submodule mode" for what that
  does to the pointer).
- Git config is the lowest tier because it is per clone and unversioned: an
  operator binds a deployed clone without changing code, the way
  `remote.pushDefault` works. Code that knows its layout passes the option.
- If `HEAD` is detached and nothing applies, the repository is bound to
  `HEAD` itself exactly as today: reads resolve the detached commit, a
  transaction with no `branch` produces a detached commit, and the
  branch-defaulting operations (`sync`, `fetch`, `startPushDaemon`, `merge`)
  throw `RefError` (`ref_not_found`) as they do now.

`repo.branch` reports the resolved short name (`'data'`), or `null` when the
repository is bound to a detached `HEAD`. `repo.submodule` reports the
submodule path, or `null` in branch mode.

The default branch **may not exist yet**. Binding to an unborn branch behaves
like a fresh-but-initialized repository ([#19](https://github.com/JarvusInnovations/gitsheets/issues/19)):
`openSheets` discovers nothing, `openSheet` throws `ConfigError`
(`config_missing`), and the first committing transaction creates the branch
with a root commit. That is the bootstrap path for a data branch — see
[Bootstrapping](#bootstrapping).

### What the default branch governs

Every place a spec says "`HEAD`" as a *default* means the default branch. The
table is the complete list; an operation that takes an explicit ref is
unaffected (`readBlob('HEAD', …)` still means git's `HEAD` of the bound git
dir).

| Operation | Default today | Default under a binding |
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

### Submodule mode

`openRepo({ submodule: 'data' })` opens the **submodule's** repository — the
`Repository` it returns reads and writes the submodule's git dir; the
superproject is consulted only to find it and to pin snapshots.

**Locating the git dir.** `<superproject>/data/.git` (a gitdir pointer file,
or a directory) when present; otherwise `<superproject git dir>/modules/data`
(an initialized-then-deinitialized submodule). Neither → `ConfigError`
(`config_missing`) naming the remedy (`git sheet submodule init data`). The
superproject is the repository `openRepo` would otherwise have opened
(`gitDir` / discovery).

**The pointer.** The submodule's `HEAD` is the managed pointer: whatever it
names is what the superproject's `git status` compares against the gitlink
in its index. In submodule mode the default branch is therefore:

- `HEAD`'s branch when `HEAD` is a symref — a commit advances that branch and
  so advances `HEAD`.
- **`HEAD` itself when it is detached** (the state `git submodule update`
  leaves a submodule in): a commit advances `HEAD` directly, the way
  `git commit` does on a detached `HEAD`. This is the one place a gitsheets
  commit updates `HEAD` rather than a branch, so the pointer never silently
  stops moving. `sync` / `fetch` / the push daemon need a branch and throw
  `RefError` (`ref_not_found`) until one is checked out (`.gitmodules`
  `branch = data` plus `git -C data switch data`, or `submodule init`
  below, puts the submodule on a branch).
- An explicit `branch` that `HEAD` is not on writes to that branch and
  **does not move the pointer**; the superproject sees nothing. That is
  "write to a side branch of the data", and it is deliberate.

**After a commit.** By default gitsheets stages nothing in the superproject:
`git status` there reports `modified: data (new commits)`, and the user
commits the pointer with their code (or `git add data` on its own). Each
superproject commit thereby records exactly which data snapshot it was built
against. `openRepo({ …, stagePointer: true })` additionally updates the
superproject's index entry for the gitlink (`160000 <new commit>`) after
every commit — for consumers that want `git commit -a` to carry the pointer
without a separate `git add`. It never commits in the superproject.

**No record files on disk.** gitsheets does not materialize the submodule's
working tree. An initialized submodule whose working tree is empty (or
stale) would otherwise make the superproject report `modified content`; the
`submodule init` porcelain sets `submodule.<name>.ignore = dirty` so only
pointer movement is reported. A user who wants the files runs
`git -C data checkout HEAD -- .` (or `reset --hard`), and is then in the
first layout's world for that checkout: gitsheets moves the ref, the files
stay put until the next reset.

**Reading a pinned snapshot.** `openRepo({ submodule: 'data', at: 'v1.2.0' })`
binds read-only (every sheet ref-pinned) to the commit the superproject's
`v1.2.0` gitlinks for `data` — the data a given code revision shipped with.
`at` accepts any superproject commit-ish; `RefError` (`ref_not_found`) when
it has no gitlink at that path. Live sheets and transactions are refused on
an `at`-bound repository exactly as on ref-pinned sheets
(`TransactionError` `transaction_required`).

**Pushing.** The push daemon pushes the submodule's branch as usual. The
superproject's pointer commit must not reach a remote before the data commit
it points at; the recipe sets `push.recurseSubmodules = check` (refuse) or
`on-demand` (push the data first) in the superproject. Nothing in the
library enforces this: it is the user's `git push`.

### CLI

Two global flags select the binding, each with an environment variable:

| Flag | Env | Meaning |
| --- | --- | --- |
| `--branch <name>` | `GITSHEETS_BRANCH` | branch mode |
| `--submodule <path>` | `GITSHEETS_SUBMODULE` | submodule mode (combines with `--branch`) |

They resolve exactly as `openRepo` does (flag → env → git config → `HEAD`).
The existing `--ref` / `GITSHEETS_REF` stays a per-invocation override of
what to read or transact against; its **default is the resolved default
branch**, so a project that exports `GITSHEETS_SUBMODULE=data` (or sets
`gitsheets.submodule` once per clone) gets `git sheet query users` and
`gitsheets-axi` reading and writing the data submodule with no flags.
`--commit-to` derives from the resolved `--ref` as today.

### Bootstrapping

**A data branch.** `git sheet init <sheet>` gains `--commit`: instead of
scaffolding `.gitsheets/<sheet>.toml` in the working tree, it commits the
config to the default branch through a transaction (`tx.writeFile`), creating
the branch with a root commit when it does not exist. `--commit` is implied —
the working-tree scaffold is impossible or pointless — when the target ref is
not the checked-out branch, or the repository is bare. Editing a committed
config on a branch that is never checked out goes through the same door:
`git sheet migrate-config` and `gitsheets-axi` config commands already commit.

**A data submodule.** `git sheet submodule init <path> [--url <url>] [--branch <b>]`
sets up a submodule with **no record checkout**:

- New (`--url` given): adds the `.gitmodules` entry (`path`, `url`, and
  `branch`, default the remote's `HEAD` branch), clones into
  `<git dir>/modules/<path>` without a checkout, writes the `<path>/.git`
  gitdir pointer, puts the submodule's `HEAD` on the branch, sets
  `submodule.<name>.ignore = dirty`, and stages `.gitmodules` plus the
  gitlink in the superproject. The user commits.
- Existing entry (a fresh clone of the superproject): does what
  `git submodule update --init` does minus the checkout — fetches, puts
  `HEAD` on the `.gitmodules` branch at the gitlinked commit, sets `ignore`.
  Idempotent.

Plain `git submodule update --init` also works (gitsheets reads the git dir
either way); it just leaves a checkout of the records behind.

The documented recipe (`docs/recipes/headless-data.md`, a plan deliverable,
not a spec) covers the layouts and their trade-offs; the spec-level
commitments behind it are:

| Layout | What gitsheets needs | Working tree of records | History |
| --- | --- | --- | --- |
| Records on the code branch | nothing new | yes — the known `git status` "deleted" gotcha after every write | mixed with code |
| Orphan data branch, same repo | `--branch` / `branch:`; `init --commit` to start it | none; `git worktree add ../app-data data` for an occasional look | separate branch, rides along with every clone |
| Separate data repository, bare clone | `gitDir` pointing at it (`branch` optional) | none | separate repo |
| **Data submodule** | `--submodule` / `submodule:`; `submodule init` to set up | none (`ignore = dirty`); checkout on demand | separate repo; **each code commit pins a data snapshot** |

### Working-tree mode is a different feature

`--working` ([#165](https://github.com/JarvusInnovations/gitsheets/issues/165),
[deferred.md](../deferred.md#cli---working-global-flag--165)) reads and
writes on-disk files *instead of* a ref. It is not a sync between the ref and
the checkout and this behavior does not cover it. The headless layouts are
the recommended answer for a project that today suffers the ref/working-tree
split; `--working` remains the answer for a human editing files before
committing them.

## Principles

**Local:**

- **The ref is the store; a checkout is a view.** gitsheets reads and writes
  git refs. A working tree is an optional, consumer-managed materialization
  of one of them, and gitsheets never updates it behind the user. When a
  design choice is between making the working tree follow the ref and making
  the ref not need a working tree, pick the latter: add the knob that removes
  the checkout (a bound branch, a bare clone, an unmaterialized submodule)
  rather than the one that keeps a checkout in sync (an auto-`checkout` after
  commit, a watcher). The split people hit is a symptom of keeping live
  records on the branch they also check out, and the fix is the layout, not
  a reconciler. The submodule pointer is not an exception: advancing `HEAD`
  *is* the ref write, and the superproject's index is left for the user.

## Coordinates with

- [api/repository.md](../api/repository.md)
- [api/store.md](../api/store.md)
- [api/cli.md](../api/cli.md)
- [behaviors/freshness.md](freshness.md)
- [behaviors/transactions.md](transactions.md)
- [behaviors/push-sync.md](push-sync.md)
- [deferred.md](../deferred.md#cli---working-global-flag--165) — `--working`
