# Behavior: Default Branch (headless data)

## Rule

Every `Repository` is bound to one **default branch**: the branch its live
sheets read from, its transactions commit to, its read snapshots follow, and
its `sync` / `fetch` / push daemon / `merge` operate on when the caller names
no ref. By default that is the branch `HEAD` points at (today's behavior).
`openRepo({ branch })` binds the repository to any other branch of the same
git dir (an orphan data branch, or a bare data clone's branch), so a project
can keep its records **off the branch it checks out**: no working tree of
records exists to fall out of step with the ref, there is nothing for
`git status` to report after a write, and no checkout or index cost grows
with the number of records.

The binding is activated from the CLI by a global flag or an environment
variable. gitsheets never reads or writes record files in any working tree;
the only working-tree touches are the file-oriented commands — `check` (a
file the user names) and `merge --install-driver` (`.gitattributes`).

## Applies To

- [api/repository.md](../api/repository.md) — `openRepo`, `repo.branch`,
  `openSheet` / `openSheets`, `transact`, `refresh`,
  `sync`, `fetch`, `startPushDaemon`, `merge`
- [api/store.md](../api/store.md) — `openStore`, `store.refresh`
- [api/cli.md](../api/cli.md) — `--branch`, the `--ref` default,
  `init --commit`
- [behaviors/freshness.md](freshness.md) — what a rebind resolves
- [behaviors/transactions.md](transactions.md) — the default parent and
  branch of a transaction
- [behaviors/push-sync.md](push-sync.md) — the branch `sync` and the daemon
  default to

## Details

### Resolution

Binding is resolved once, at `openRepo`, from the first source that applies:

| Source | Value |
| --- | --- |
| `openRepo` option | `branch: 'data'` |
| environment (CLI and library alike) | `GITSHEETS_BRANCH` |
| git config of the opened project | `gitsheets.branch` |
| neither | the branch `HEAD` points at |

- `branch` is a branch name (`data`, `refs/heads/data`), never a tag, commit,
  or tree: writes must have somewhere to land. Anything else is `ConfigError`
  (`config_invalid`).
- Git config is the lowest tier because it is per clone and unversioned: an
  operator binds a deployed clone without changing code, the way
  `remote.pushDefault` works. Code that knows its layout passes the option.
- If `HEAD` is detached and nothing applies, the repository is bound to
  `HEAD` itself exactly as today: reads resolve the detached commit, a
  transaction with no `branch` produces a detached commit, and the
  branch-defaulting operations (`sync`, `fetch`, `startPushDaemon`, `merge`)
  throw `RefError` (`ref_not_found`) as they do now.

`repo.branch` reports the resolved short name (`'data'`), or `null` when the
repository is bound to a detached `HEAD`.

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

### CLI

The `--branch <name>` global flag (env `GITSHEETS_BRANCH`) selects the
binding. It resolves exactly as `openRepo` does (flag → env → git config → `HEAD`).
The existing `--ref` / `GITSHEETS_REF` stays a per-invocation override of
what to read or transact against; its **default is the resolved default
branch**, so a project that exports `GITSHEETS_BRANCH=data` (or sets
`gitsheets.branch` once per clone) gets `git sheet query users` and
`gitsheets-axi` reading and writing the data branch with no flags.
`--commit-to` derives from the resolved `--ref` as today.

`gitsheets-axi` takes `--branch <name>` as a global flag **before** the
command name (`gitsheets-axi --branch data query users`), because `push`
already has a per-command `--branch` (the branch to push). Its config
commands (`init`, `infer`, `migrate-config`) read the existing config from
the default branch, and `push` without `--branch` pushes the default branch.

### Bootstrapping

`git sheet init <sheet>` commits the config to the target ref (`--ref` /
`--commit-to`, default the default branch) through a transaction
(`tx.writeFile`) — it has always committed rather than scaffolding a file in
the working tree — and, when that branch does not exist yet, creates it with
a root commit holding only the config. `--commit` names that behavior
explicitly; it is accepted so bootstrap scripts read as what they do
(`git sheet init users --commit --branch data`) and changes nothing about
what `init` writes. The checked-out branch and its working tree are never
touched, so `git status` stays clean after bootstrapping a data branch.
Editing a committed config on a branch that is never checked out goes
through the same door: `git sheet migrate-config` / `infer` and the
`gitsheets-axi` config commands already commit.

The documented recipe (`docs/recipes/headless-data.md`, a plan deliverable,
not a spec) covers the layouts and their trade-offs; the spec-level
commitments behind it are:

| Layout | What gitsheets needs | Working tree of records | History |
| --- | --- | --- | --- |
| Records on the code branch | nothing new | yes — the known `git status` "deleted" gotcha after every write | mixed with code |
| Orphan data branch, same repo | `--branch` / `branch:`; `init --commit` to start it | none; `git worktree add ../app-data data` for an occasional look | separate branch, rides along with every clone |
| Separate data repository, bare clone | `gitDir` pointing at it (`branch` optional) | none | separate repo |

### Working-tree mode is a different feature

`--working` ([#165](https://github.com/JarvusInnovations/gitsheets/issues/165),
[deferred.md](../deferred.md#cli---working-global-flag--165)) reads and
writes on-disk files *instead of* a ref. It is not a sync between the ref and
the checkout and this behavior does not cover it. The headless layouts are
the recommended answer for a project that today suffers the ref/working-tree
split; `--working` remains the answer for a human editing files before
committing them.

## Principles

**Inherited** — project principles that especially bite on this spec:

- [Behave like a first-party git extension](../principles.md#behave-like-a-first-party-git-extension) —
  the binding resolves flag → env → `gitsheets.*` git config → `HEAD`, and the
  library reads the same config the CLI does, so one clone has one binding.

**Local:**

- **The ref is the store; a checkout is a view.** gitsheets reads and writes
  git refs. A working tree is an optional, consumer-managed materialization
  of one of them, and gitsheets never updates it behind the user. When a
  design choice is between making the working tree follow the ref and making
  the ref not need a working tree, pick the latter: add the knob that removes
  the checkout (a bound branch, a bare clone)
  rather than the one that keeps a checkout in sync (an auto-`checkout` after
  commit, a watcher). The split people hit is a symptom of keeping live
  records on the branch they also check out, and the fix is the layout, not
  a reconciler.

## Coordinates with

- [api/repository.md](../api/repository.md)
- [api/store.md](../api/store.md)
- [api/cli.md](../api/cli.md)
- [behaviors/freshness.md](freshness.md)
- [behaviors/transactions.md](transactions.md)
- [behaviors/push-sync.md](push-sync.md)
- [deferred.md](../deferred.md#cli---working-global-flag--165) — `--working`
