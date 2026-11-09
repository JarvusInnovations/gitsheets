# Headless data

gitsheets reads and writes git **refs**. It never touches a working tree. A
checkout is a view of one ref that you manage. When the live records sit on
the same branch you check out, every gitsheets write moves the ref out from
under that checkout, and `git status` starts reporting your records as
deleted or modified. Nothing is lost. The checkout is just behind the ref.

The fix is the layout, not a sync step: keep the records on a branch you never
check out, or in a data submodule you never materialize. Then there is no working tree of records to fall behind, nothing
for `git status` to report, and no checkout cost that grows with the record
count.

Every repository is bound to one **default branch**. That is the branch live
sheets read, transactions commit to, and `sync`, the push daemon, and `merge`
target when you name no ref. By default it is the branch `HEAD` points at. You
can bind it to any other branch.

## Pick a layout

| Layout | What you set | Working tree of records | History |
| --- | --- | --- | --- |
| [Records on the code branch](#records-on-the-code-branch) | nothing | yes, and it goes stale after every write | mixed with code |
| [Orphan data branch, same repo](#orphan-data-branch) | `gitsheets.branch` (or `--branch` / `branch:`) | none | separate branch that travels with every clone |
| [Separate data repository, bare clone](#bare-data-clone) | `--git-dir` / `gitDir` | none | separate repo |
| [Data submodule](#data-submodule) | `gitsheets.submodule` (or `--submodule` / `submodule:`); `git sheet submodule init` to set up | none | separate repo; **each code commit pins a data snapshot** |

## Binding the default branch

The binding layers the way git's own settings do. The command-line flag wins
over the environment variable, which wins over git config. With none of
them set, the default branch is the branch `HEAD` points at. The library and
both CLIs read the same sources, so one `git config` per clone binds
`git sheet`, `gitsheets-axi`, and your application together.

| Source | Example | Scope |
| --- | --- | --- |
| `openRepo` option | `openRepo({ branch: 'data' })` | code that knows its layout |
| CLI flag | `git sheet --branch data query users`, `gitsheets-axi query users --branch data` | one invocation |
| environment | `GITSHEETS_BRANCH=data` | a shell, a container, a CI job |
| git config | `git config gitsheets.branch data` | one clone, unversioned, like `remote.pushDefault` |
| none of these | the branch `HEAD` points at | today's behavior |

The value must name a branch (`data` or `refs/heads/data`). A tag, a commit
hash, or a malformed name is rejected with `ConfigError` (`config_invalid`).
`repo.branch` reports what was resolved.

Explicit refs keep meaning what they name. `repo.readBlob('HEAD', path)`,
`openSheet(name, { ref: 'HEAD' })`, and `transact({ parent: 'main' })` still
read from or commit to exactly that ref.

## Records on the code branch

This is the default and needs no setup. It suits a repo where people edit
records by hand and commit them alongside code.

The catch is the working tree. After a gitsheets write, the ref holds the new
records and your checkout still holds the old ones. With a `users` sheet set
up:

```bash
git sheet upsert users '{"slug":"jane","email":"jane@x.org"}'
git status --short    # shows "D  users/jane.toml": the index and files are behind the ref
```

To bring the checkout up to date with the ref:

```bash
git checkout HEAD -- .
```

!!! warning "A stale checkout can undo writes"
    Until you refresh it, the working tree is an old copy. If you edit
    a stale record file and commit it with plain `git commit -a`, you commit
    the old content back over what gitsheets wrote. Refresh first, or move the
    records off the code branch.

## Orphan data branch

The records live on a branch with no shared history with your code, such as
`data`, in the same repository. The branch travels with every clone and push.
You never check it out.

Start the branch. `init` commits the sheet config to `data` as a root commit
and leaves your checked-out branch alone:

```bash
git sheet init users --commit --branch data --path '${{ slug }}'
git status --short    # clean
```

Bind the clone once, then use `git sheet` with no flags:

```bash
git config gitsheets.branch data
git sheet upsert users '{"slug":"jane","email":"jane@x.org"}'
git sheet query users
git status --short    # still clean
```

Your application picks up the same binding from git config. You can also pass
it in code:

```typescript
import { openRepo } from 'gitsheets';

const repo = await openRepo();                    // reads gitsheets.branch
// const repo = await openRepo({ branch: 'data' }); // or say so in code
console.log(repo.branch);                         // 'data'
const users = await repo.openSheet('users');
await users.upsert({ slug: 'ada', email: 'ada@x.org' });

const daemon = await repo.startPushDaemon({ remote: 'origin' }); // pushes data
await repo.sync();                                               // syncs data
```

Push and fetch the branch by name, like any other branch:

```bash
git push origin data
```

!!! note "Fresh clones need a local `data` branch"
    `git clone` creates a local branch only for the remote's default
    branch. On a new clone, `data` exists only as `origin/data`, and
    gitsheets refuses to bind to it (`ConfigError` `config_invalid`, naming
    the fix) rather than treat it as unborn and start a root commit
    unrelated to the remote's history. It never creates the local branch
    for you. Create it before you bind:

    ```bash
    git branch data origin/data
    git config gitsheets.branch data
    ```

To look at the records now and then, add a **detached** worktree:

```bash
git worktree add --detach ../app-data data
ls ../app-data/users
```

A detached view is a snapshot of one commit, so it never reports phantom
changes when gitsheets moves `data`. To refresh it:

```bash
git -C ../app-data checkout --detach data
```

!!! warning "Do not check `data` out as a branch"
    `git worktree add ../app-data data` (without `--detach`) checks out
    the branch itself. That worktree then has the same stale-checkout problem
    as [records on the code branch](#records-on-the-code-branch): every
    gitsheets write leaves it behind, and committing stale files from it
    reverts the writes. Use `--detach`, and remove the view when you're
    done (`git worktree remove ../app-data`).

## Bare data clone

The records live in their own repository. Each host that reads or writes them
keeps a bare clone, which has no working tree at all. Nothing needs binding:
the clone's `HEAD` already points at its data branch.

```bash
git clone --bare git@example.com:acme/app-data.git /srv/app-data.git
git sheet --git-dir /srv/app-data.git query users
GIT_DIR=/srv/app-data.git git sheet upsert users '{"slug":"jane","email":"jane@x.org"}'
```

```typescript
const repo = await openRepo({ gitDir: '/srv/app-data.git' });
```

If the data repository keeps its records on a branch other than its default
branch, add `branch` (or `git -C /srv/app-data.git config gitsheets.branch data`).
`repo.sync()` and `repo.fetch()` use explicit refspecs, so they work in a bare
clone without a configured fetch refspec.

## Data submodule

The records live in their own repository, attached to the code repository as
a git submodule whose files are never checked out. The submodule's `HEAD` is
the code repository's **pointer** to a data snapshot. Each gitsheets write
advances it, so `git status` in the code repository reports
`modified: data (new commits)`, and you commit the pointer along with your
code. Every code commit then records exactly which data it was built against.

### Set it up

`git sheet submodule init` adds the submodule without a checkout of the
records:

```bash
git sheet submodule init data --url git@example.com:acme/app-data.git --branch main
git commit -m "Add data submodule"
git config gitsheets.submodule data
```

It writes the `.gitmodules` entry (`path`, `url`, `branch`), clones into
`.git/modules/data` with no checkout, leaves only the `data/.git` pointer
file on disk, puts the submodule's `HEAD` on `main`, sets
`submodule.data.ignore = dirty`, and stages `.gitmodules` plus the pointer.
It never commits. Without `--branch` it uses the remote's default branch; an
empty data repository needs `--branch`, and the branch is created by the
first write.

### Write, then commit the pointer

With `gitsheets.submodule` set, `git sheet` and `gitsheets-axi` read and
write the submodule with no flags (or pass `--submodule data`, or export
`GITSHEETS_SUBMODULE=data`):

```bash
git sheet upsert users '{"slug":"jane","email":"jane@x.org"}'
git status --short        # " M data": the pointer moved, nothing else
git add data
git commit -m "Add jane"  # or commit the pointer together with your code change
```

gitsheets stages nothing in the code repository unless you ask it to. In
code, `stagePointer: true` updates the index entry for the pointer after each
write (and after a `merge` or `sync` that moves it), so `git commit -a`
carries it. If the index is locked when it tries, the write has still landed:
the error is `TransactionError` `pointer_stage_failed` with the commit on
`err.commitHash`, and the fix is `git add data`, not another write:

```typescript
import { openRepo } from 'gitsheets';

const repo = await openRepo({ submodule: 'data' }); // or gitsheets.submodule / GITSHEETS_SUBMODULE
console.log(repo.submodule, repo.branch);           // 'data' 'main'
const users = await repo.openSheet('users');
await users.upsert({ slug: 'ada', email: 'ada@x.org' });

const staging = await openRepo({ submodule: 'data', stagePointer: true });
```

`{ submodule: 'data', branch: 'drafts' }` writes to another branch of the data
repository. That does not move the pointer, so the code repository sees
nothing.

### Read the data a release shipped with

`at` takes any commit-ish of the code repository and pins every sheet,
read-only, to the data commit it points at:

```typescript
const shipped = await openRepo({ submodule: 'data', at: 'v1.2.0' });
const users = await shipped.openSheet('users'); // the users as of v1.2.0
```

Writes through `shipped` throw `TransactionError` (`transaction_required`).
A commit-ish with no `data` pointer throws `RefError` (`ref_not_found`).

### Fresh clones

A fresh clone of the code repository has an empty `data/` directory. Run
`submodule init` with no `--url`. It fetches the data repository and puts
`HEAD` on the `.gitmodules` branch at the commit your checkout pins, still
without checking out any records:

```bash
git clone git@example.com:acme/app.git && cd app
git sheet submodule init data
git config gitsheets.submodule data
git sheet query users
```

Re-running it is safe: a data branch that already exists is left where it is.
Plain `git submodule update --init` works too, but it checks the records out
and leaves `HEAD` detached. On a detached `HEAD`, gitsheets advances `HEAD`
itself, so the pointer still moves, but `sync`, `fetch`, and the push daemon
need a branch and refuse until `HEAD` is on one. `git sheet submodule init
data` puts it back on the `.gitmodules` branch, fast-forwarding the branch
over any writes made on the detached `HEAD` first. If the branch has moved on
separately, it refuses and names both commits rather than drop either.

!!! warning "Writes on a detached `HEAD` hang off `HEAD` alone"
    Until you commit the pointer in the code repository (`git add data`), a
    write made on a detached `HEAD` is referenced only by that `HEAD`. A
    `git submodule update`, `git checkout`, or `git switch` in `data/`
    moves `HEAD` and leaves the write reachable only from the reflog. Put
    the submodule on a branch (`git sheet submodule init data`) before
    writing, or pin each write promptly.

    gitsheets also resolves the binding once, when the repository is
    opened. A long-running process does not notice a later
    `git submodule update` detaching `HEAD`, or a checkout attaching it,
    and keeps writing the way it started. Reopen the repository after
    changing what `data/` has checked out.

### Push the data before the pointer

The push daemon (or `git -C data push origin main`) pushes the data
repository. A code commit must not reach the remote before the data commit it
points at, or other clones cannot fetch what it pins. Have git enforce the
order in the code repository:

```bash
git config push.recurseSubmodules check      # refuse to push a pointer whose data isn't pushed
# or
git config push.recurseSubmodules on-demand  # push the data repository first, then the code
```

gitsheets does not push the code repository for you. That stays your
`git push`.

!!! warning "`ignore = dirty` hides edits under `data/`"
    The submodule's working tree is empty on purpose, which plain git
    would report as `modified content` on every `git status`.
    `submodule.data.ignore = dirty` silences that, so only pointer
    movement shows. It also hides any files you edit by hand under
    `data/`. If you want the files, `git -C data checkout HEAD -- .`
    writes them out, but they are then a stale view like
    [records on the code branch](#records-on-the-code-branch): gitsheets
    moves the ref and the files stay put until the next checkout. Edit
    records through gitsheets, not in `data/`.

## Editing configs on a branch you never check out

Every config-writing command commits through a transaction, so it works the
same on a data branch: `git sheet init`, `infer`, `migrate-config`, and the
`gitsheets-axi` `init` / `infer` / `migrate-config` commands all read the
existing config from the default branch and commit the new one there.

## Python

The Python binding's batch functions take an explicit `tree_ref` on every
call (`record_query(git_dir, tree_ref, …)`). `gitsheets.branch` and
`GITSHEETS_BRANCH` do not apply there, and neither do `gitsheets.submodule` and
`GITSHEETS_SUBMODULE`. Pass `'refs/heads/data'` (or the tree it resolves to)
yourself, with the submodule's git dir (`.git/modules/data`) as `git_dir` in
submodule mode.
