---
status: in-progress
depends: []
specs:
  - specs/behaviors/transactions.md
  - specs/behaviors/push-sync.md
  - specs/behaviors/merge.md
  - specs/behaviors/rollups.md
  - specs/api/transaction.md
  - specs/api/repository.md
  - specs/api/errors.md
  - specs/api/cli.md
  - specs/api/axi.md
  - specs/api/python-binding.md
issues: []
---

# Plan: commit-shape options (trailers from the CLI, additional parents, replace-tip, empty commits, push --to)

## Scope

A single-writer consumer logging to a headless data branch through
`gitsheets-axi` needs these on a write's commit, plus a way to read the
result back and to publish part of the branch. Built in the core, both
bindings, the library, and both CLIs:

1. **Trailers from the CLI.** `--trailer 'Key: value'` (or `Key=value`) on
   every committing `gitsheets-axi` command; the human CLI's existing
   `--trailer Key=Value` also accepts the `:` form. A malformed trailer gets
   its own code, `trailer_invalid` (was `commit_failed`).
2. **Additional parents.** `alsoParents` / `--also-parent`: the commit is
   written with those extra parents, validated (exist, are commits, not the
   first parent, no duplicates). gitsheets attaches no behaviour to them.
   `sync` and `merge` are untouched: their specs say they give parents git's
   meaning and are not for such a branch.
3. **Replace the tip.** `replace: '<expected tip>'` / `--replace <commit>`:
   compare-and-swap amend. `tip_mismatch` when the tip is anything else,
   `tip_published` when a remote-tracking ref already contains it,
   `replace_daemon_running` when this repository's push daemon runs. The
   rollup pass covers the union of the replaced commit's and the
   replacement's partitions.
4. **Empty commits.** `allowEmpty` (library) and a `commit` command in both
   CLIs.
5. **Read-back.** `repo.readCommit(rev?)`, `commit_read` (Python),
   `git sheet head`, `gitsheets-axi head [<commit>] [--json-out]`; parents are
   an ordered list of hashes.
6. **Partial push.** `repo.push({ remote, branch, to })`, `git sheet push
   [--to]`, `gitsheets-axi push --to`: publish up to a first-parent ancestor
   of the tip, never forced, updating the remote-tracking ref.

Out of scope: any change to `sync` or `merge`, parent roles or markers, a
`log` command, `--allow-empty` on record commands, a CLI spelling for
dropping a replaced tip's extra parents, repeated trailer keys from the JS
library (its `trailers` is a record), any override of `tip_published`.

## Implements

- `specs/behaviors/transactions.md` — trailer code, trailers from the
  command line, Additional parents, Replacing the tip, Empty commits,
  Reading a commit back, the rollup-pass and optimistic-concurrency notes,
  Principles.
- `specs/behaviors/push-sync.md` — Additional parents (one rule: not for
  sync); Replaced commits and the remote; Pushing part of a branch; The push
  daemon and an open tip.
- `specs/behaviors/merge.md` — Additional parents (one rule: not for merge).
- `specs/behaviors/rollups.md` — first-parent rule and the replace-mode
  union in "Maintenance at commit".
- `specs/api/transaction.md` — Commit shape section, no-op detection notes,
  errors.
- `specs/api/repository.md` — `transact` options,
  `TransactionResult.replacedCommitHash`, `readCommit`, `push`, errors.
- `specs/api/errors.md` — `trailer_invalid`, `parent_not_found`,
  `tip_mismatch`, `tip_published`, `replace_daemon_running`;
  `TransactionError.expected` / `actual`; the migration note.
- `specs/api/cli.md` — Commit-shape flags, `git sheet commit`,
  `git sheet head`, `git sheet push`, exit codes.
- `specs/api/axi.md` — Commit-shape flags, `commit`, `head`, `push --to`,
  error codes.
- `specs/api/python-binding.md` — `transact` kwargs, `commit_read`.

## Approach

1. **Core** (`rust/gitsheets-core/src/transaction.rs`, `error.rs`, new
   `history.rs`). `TransactionOptions` gains `also_parents`, `replace`,
   `allow_empty`; `TransactionResult` gains `replaced_commit_hash`. New
   `Error` variants `TrailerInvalid`, `ParentNotFound`, `TipMismatch
   { expected, actual }`, `TipPublished`, `ReplaceDaemonRunning` (raised by
   the host, which owns the daemon). `begin` validates the extra parents and
   the replace combination, checks the tip and the remote-tracking refs, and
   in replace mode starts from the tip's tree and takes the tip's parents.
   `finalize` skips the short-circuits for `allow_empty` / replace, repeats
   the replace checks, CASes the ref from the old tip, and runs the rollup
   pass over the union. `history.rs` holds the message parser,
   `commit_info` (read-back), and the first-parent ancestry check for `push`.
2. **napi** (`rust/gitsheets-napi/src/lib.rs`, `index.d.ts`): the options,
   `replacedCommitHash`, `readCommit`, `isFirstParentAncestor`,
   `expected` / `actual` on thrown errors.
3. **pyo3** (`rust/gitsheets-py`): `transact(..., also_parents, replace,
   allow_empty)`, `replaced_commit_hash`, `commit_read`, `expected` /
   `actual`; a detached `HEAD` is advanced from the replaced tip.
4. **JS library** (`packages/gitsheets/src/`): options pass through; TS-side
   `trailer_invalid`; `replace_daemon_running`; detached-`HEAD` CAS from the
   replaced tip; `repo.readCommit`; `repo.push`.
5. **Human CLI** (`packages/gitsheets/src/cli/`): both trailer forms;
   `--also-parent`, `--replace` with no env tier; combination checks;
   `commit`, `head`, `push`.
6. **gitsheets-axi** (`packages/gitsheets-axi/src/`): `util/commit-flags.ts`
   (parse, and a wrapper that hands each committing command a repository
   whose `transact` carries the shape); `commands/commit.ts`,
   `commands/head.ts`; `push` on `repo.push` with `--to`; error codes; the
   test harness drives the production command table.
7. **Docs and skill**: `docs/api.md`, `docs/cli.md`, `docs/axi.md`,
   `skills/gitsheets/`.
8. **Release** (after merge, not on this branch): a semver minor —
   `core-napi-v0.12.0` first, manifest sync, then `v2.15.0` (`gitsheets` +
   `gitsheets-axi`); Python `py-v0.9.0` independently.

## Validation

Core (`cargo test -p gitsheets-core`, `src/commit_shape_tests.rs`):

- [ ] A trailer with a bad key or a newline in a value fails `begin` with
      `trailer_invalid`, no tree work.
- [ ] `also_parents` writes parents `[first, ...also]` in order; the tree is
      the first parent's plus the change.
- [ ] An `also_parents` entry that does not resolve, or names a tree, is
      `parent_not_found`; a duplicate, the first parent itself, or use with
      `orphan` is `commit_failed`; nothing moves.
- [ ] A transaction with `also_parents` that changes nothing commits nothing.
- [ ] `allow_empty` commits the tip's tree with message, trailers, parents.
- [ ] Replace with the right tip: tip's first parent, tip's tree plus the
      change, tip's extra parents kept by default; `also_parents` replaces
      them, `[]` drops them; a tip's merge parent is kept.
- [ ] **Replace refused when the tip moved**: at open `tip_mismatch`
      (`expected`, `actual`) before the handler runs; moved between open and
      commit, `tip_mismatch` at commit and the other writer's tip stays.
- [ ] Replace on an unborn branch is `tip_mismatch` with no actual.
- [ ] **Replace refused when the replaced commit is on a remote**: a
      remote-tracking ref at the tip or a descendant is `tip_published` at
      open; one that arrives after open, at commit; the unpublished tip above
      a published commit can be replaced.
- [ ] Replace with a commit-hash `parent`, an orphan, or a different
      `branch` is `commit_failed`.
- [ ] Replace no-op rules: a message-only replacement of a tip that changed
      records commits; an empty tip replaced without `allow_empty` commits
      nothing and stays; with it, commits.
- [ ] Replacing a root commit produces a root commit.
- [ ] **The main loop**: an empty commit with an extra parent, replaced five
      times with new trailers and no `also_parents`, keeps the extra parent
      and the first parent each time; the last trailers read back.
- [ ] Rollup pass in replace mode: a reverted partition leaves no stale
      rollup; a partition only the replacement touches is regenerated
      (`rollup_tests.rs`).
- [ ] `commit_info` round-trips subject, body, trailers (order, repeated
      keys), parents, ISO dates; `ref_not_found` for an unknown rev.
- [ ] The existing sync and merge test suites pass unchanged.

Bindings:

- [ ] napi `node --test`: the existing suite passes with the new options and
      exports.
- [ ] pytest (`tests/test_commit_shape.py`): `also_parents`, `replace`,
      `allow_empty`, `commit_read` (default branch, explicit rev, unborn ⇒
      `None`), `tip_mismatch` with `expected` / `actual`, `tip_published`,
      `trailer_invalid`, `parent_not_found`.
- [ ] Cross-binding parity (`test_cross_binding.py`): an extra-parent empty
      commit and its replacement are byte-identical from Node and Python.

JS library (vitest, `src/commit-shape.test.ts`, `src/submodule-mode.test.ts`):

- [ ] Extra parents and trailers round-trip through `readCommit`; malformed
      trailers are `trailer_invalid`; an unknown parent is `parent_not_found`.
- [ ] Replace: `tip_mismatch` with `expected` / `actual`; on success
      `replacedCommitHash`, the parent, and rebound live sheets.
- [ ] Submodule mode on a detached `HEAD`: replace moves `HEAD` from the
      replaced tip, and a mismatched tip moves nothing.
- [ ] `replace` while this repository's push daemon runs is
      `replace_daemon_running`, nothing changed.
- [ ] `readCommit()` on an unborn default branch is `null`; an unknown rev is
      `ref_not_found`.
- [ ] `push({ to })` publishes exactly that commit and sets the tracking ref;
      again is `up-to-date`; `to` off the first-parent line is
      `not_an_ancestor`, unknown is `ref_not_found`; a remote ahead gives
      `non-fast-forward`, nothing forced.
- [ ] **The main loop, library level**: an empty commit with an extra parent
      replaced five times with new trailers; the next open tip on top;
      `push({ to })` of the closed one; the open tip still replaceable; the
      published one `tip_published`.

Human CLI (vitest, `src/cli/cli-commit-shape.test.ts`):

- [ ] Both trailer forms land; a bad key exits 69; no separator exits 2.
- [ ] Unknown `--also-parent` exits 65; wrong `--replace` exits 69 with
      nothing moved; `--replace` with a hash `--ref` or a different
      `--commit-to` exits 2.
- [ ] `GITSHEETS_REPLACE` in the environment is ignored.
- [ ] `commit` without `--message`, or without `--allow-empty` /
      `--replace`, exits 2; `head` prints `CommitInfo` JSON or `null`;
      `push --to` prints `pushed <hash>`, an unknown `--to` exits 65.

gitsheets-axi (vitest, `test/commit-shape.test.ts`, `test/submodule.test.ts`):

- [ ] **Flag validation**: committing commands take `--trailer` (both forms),
      `--also-parent`, `--replace`; a read command refuses them and
      `--allow-empty` outside `commit` (`VALIDATION_ERROR`, exit 2); a
      trailer with no separator, a bad key, or a repeated key is
      `TRAILER_INVALID` and commits nothing; unknown `--also-parent` is
      `PARENT_NOT_FOUND`.
- [ ] `upsert --replace <tip>` replaces it (`replaced:` in the output); a
      wrong tip is `TIP_MISMATCH` and nothing moves; `upsert --also-parent`
      of an unchanged record is a no-op.
- [ ] `commit` needs `--message` and `--allow-empty` / `--replace`.
- [ ] **An empty commit with trailers and an extra parent**; `head` shows it;
      **`--json-out` shape**: keys `author`, `body`, `branch`, `committer`,
      `hash`, `parents` (hashes), `subject`, `trailers` (`{key,value}`),
      `tree`, file mode `0600`; an unborn branch prints `commit: null` and
      writes `null`; `commit --allow-empty` bootstraps it.
- [ ] `head <commit>` reads that commit; unknown is `REF_ERROR`.
- [ ] **Headless branch**: `--branch log`, `GITSHEETS_BRANCH`, and
      `gitsheets.branch` bind `commit` / `head`; `main` and the working tree
      stay untouched, no materialize hint.
- [ ] **The main loop through the CLI** on `--branch log` against a remote:
      `commit --allow-empty --also-parent main --trailer …`, then
      `commit --allow-empty --replace <tip> --trailer …` three times without
      `--also-parent` (the extra parent kept each time); `head` shows the
      last trailer; `commit` the next open tip; `push --to <closed>`; the open
      tip replaceable; the published one `TIP_PUBLISHED`.
- [ ] `push --to` off the first-parent line is `REF_ERROR`; plain `push`
      keeps its outputs (`test/push.test.ts`).
- [ ] Under `--at`, `commit` is refused and `head` shows the pinned commit.

Housekeeping:

- [ ] `cargo clippy` (core, napi, py) with `-D warnings`, `npm run
      type-check`, `npm test`, `cargo test -p gitsheets-core`, pytest,
      markdownlint clean; CI green.
- [ ] Docs and skill updated.

## Risks / unknowns

- **Detached `HEAD` in submodule mode** is advanced by the hosts with a CAS
  from `parentCommitHash`; replace mode switches both bindings to the
  replaced tip.
- **Remote-tracking freshness.** `tip_published` is as fresh as the
  tracking refs; gitsheets' own pushes update them.
- **The `trailer_invalid` code change** alters what a caller switching on
  `commit_failed` sees for a malformed trailer (reviewed and accepted).

## Notes

Populated at closeout.

## Follow-ups

Populated at closeout.
