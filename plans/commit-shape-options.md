---
status: planned
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

# Plan: commit-shape options (trailers from the CLI, lineage parents, replace-tip, empty commits)

## Scope

A single-writer consumer logging to a headless data branch through
`gitsheets-axi` needs four things on a write's commit, plus a way to read
the result back. This plan builds them in the core, both bindings, the
library, and both CLIs:

1. **Trailers from the CLI.** `--trailer 'Key: value'` (or `Key=value`) on
   every committing `gitsheets-axi` command; the human CLI's existing
   `--trailer Key=Value` also accepts the `:` form. A malformed trailer gets
   its own code, `trailer_invalid` (was `commit_failed`).
2. **Lineage parents.** `alsoParents` / `--also-parent`: extra parents
   marked with `Gitsheets-Lineage` trailers. `sync` and `merge` walk
   history without following edges to lineage parents; a replayed commit
   keeps its lineage parents.
3. **Replace the tip.** `replace: '<expected tip>'` / `--replace <commit>`:
   compare-and-swap amend. `tip_mismatch` when the tip is anything else,
   `tip_published` when a remote-tracking ref already contains it. The
   rollup pass covers the union of the replaced commit's and the
   replacement's partitions.
4. **Empty commits.** `allowEmpty` (library) and a `commit` command in both
   CLIs (`--allow-empty`, `--replace`, `--also-parent`, `--trailer`,
   `--message`).
5. **Read-back.** `repo.readCommit(rev?)`, `commit_read` (Python),
   `git sheet head`, `gitsheets-axi head [--json-out]`.

Out of scope: a `log` command, `--allow-empty` on record commands, a way to
drop a replaced tip's extra parents from the CLI (the library's
`alsoParents: []` does it), duplicate trailer keys from the JS library
(its `trailers` is a record), and any override of `tip_published`.

## Implements

- `specs/behaviors/transactions.md` — trailer code + reserved key, trailers
  from the command line, Lineage parents, Replacing the tip, Empty commits,
  Reading a commit back, the rollup-pass and optimistic-concurrency notes,
  Principles.
- `specs/behaviors/push-sync.md` — Lineage parents in sync; Replaced
  commits and the remote; lineage history in the push.
- `specs/behaviors/merge.md` — Lineage parents.
- `specs/behaviors/rollups.md` — first-parent rule and the replace-mode
  union in "Maintenance at commit".
- `specs/api/transaction.md` — Commit shape section, no-op detection
  notes, errors.
- `specs/api/repository.md` — `transact` options, `TransactionResult.replacedCommitHash`,
  `readCommit`, sync/merge notes, errors.
- `specs/api/errors.md` — `trailer_invalid`, `parent_not_found`,
  `tip_mismatch`, `tip_published`; `TransactionError.expected` / `actual`;
  the migration note.
- `specs/api/cli.md` — Commit-shape flags, `git sheet commit`,
  `git sheet head`, exit codes.
- `specs/api/axi.md` — Commit-shape flags, `commit`, `head`, error codes,
  exit codes.
- `specs/api/python-binding.md` — `transact` kwargs, `commit_read`.

## Approach

1. **Core options and errors** (`rust/gitsheets-core/src/transaction.rs`,
   `error.rs`). `TransactionOptions` gains `also_parents: Vec<String>`,
   `replace: Option<String>`, `allow_empty: bool`; `TransactionResult`
   gains `replaced_commit_hash`. New `Error` variants `TrailerInvalid`,
   `ParentNotFound`, `TipMismatch { expected, actual }`, `TipPublished`
   with their codes and classes. `validate_trailers` returns
   `TrailerInvalid` and rejects the reserved key. `begin` resolves and
   validates `also_parents` (commit objects, no duplicates, not the first
   parent, not with `orphan`), validates the replace combination, checks
   the tip (CAS expectation) and the remote-tracking refs (`refs/remotes/**`,
   plain reachability), and in replace mode builds the starting tree from
   the tip and takes the tip's first parent (and, unless overridden, its
   extra parents with their roles).
2. **Core finalize.** `allow_empty` skips both short-circuits; replace mode
   skips `any_mutation`, compares against the new first parent's tree,
   repeats the `tip_published` check, and CASes the ref from the old tip
   (`TipMismatch` on failure, never `ParentMoved`). The rollup pass gets the
   pairs `[(new_parent_tree, result), (new_parent_tree, tip_tree)]` in
   replace mode. `format_commit_message` appends one `Gitsheets-Lineage`
   trailer per lineage parent after the caller's trailers;
   `commit_tree` gets all parents.
3. **Lineage-aware history** (new `rust/gitsheets-core/src/history.rs`).
   A trailer reader (the read-back rule) and a parent classifier; a walk
   that skips lineage edges; `commits_between` and `merge_base` over that
   graph. Fast path: when no commit visited carries a `Gitsheets-Lineage`
   trailer the result must equal gix's (asserted in tests), so a history
   with no lineage parents behaves exactly as today. `sync.rs` uses it for
   the base, counts, and replay set, and `replay` keeps lineage parents.
   `merge.rs` uses it for its `is_ancestor` checks and merge base.
   `repo.isAncestor` stays on gix.
4. **Core read-back.** `commit_info(repo, rev) -> CommitInfo` (hash, tree,
   parents with roles, signatures with ISO dates, subject, body, trailers).
5. **napi** (`rust/gitsheets-napi/src/lib.rs`, `index.d.ts`): the three
   options on `JsTransactionOptions`, `replacedCommitHash` on the result,
   `readCommit`, the new codes through `raise_core_error` with
   `expected` / `actual` on the thrown error.
6. **pyo3** (`rust/gitsheets-py/src/lib.rs`, `python/gitsheets/__init__.py`):
   `transact(..., also_parents, replace, allow_empty)`, `replaced_commit_hash`,
   `commit_read`, `TransactionError.expected` / `actual`. `_advance_pointer`
   CASes a detached `HEAD` from `replaced_commit_hash` in replace mode.
7. **JS library** (`packages/gitsheets/src/transaction.ts`, `repository.ts`,
   `errors.ts`, `core.ts`, `index.ts`): options pass through; the TS-side
   `validateTrailers` throws `trailer_invalid` and rejects the reserved key;
   `#advancePointer` CASes from the replaced tip in replace mode;
   `repo.readCommit`; `CommitInfo` exported; `TransactionError` carries
   `expected` / `actual`.
8. **Human CLI** (`packages/gitsheets/src/cli/index.ts`, `cli/shared.ts`):
   `--trailer` accepts both separators; `--also-parent`, `--replace` on
   mutating commands, kept out of yargs' `GITSHEETS` env folding (the same
   middleware trick `--stage-pointer` uses); the flag-combination checks
   (exit 2); `git sheet commit`, `git sheet head`; error-code exit mapping.
9. **gitsheets-axi** (`packages/gitsheets-axi/src/`): a shared
   `util/commit-flags.ts` (parse, validate, map to `repo.transact` options)
   wired into every committing command (`upsert`, `patch`, `delete`,
   `rename`, `normalize`, `rollup`, `init`, `infer`, `migrate-config`,
   `attachment`); `--replace` bypasses each command's no-op preflight and
   adds `replaced:` to the output; new `commands/commit.ts` and
   `commands/head.ts` (TOON + `--json-out` through `util/export-file.ts`);
   `cli.ts` registration and help; `errors.ts` codes and the exit-2
   mapping for `TRAILER_INVALID`.
10. **Docs and skill**: `docs/api.md`, `docs/cli.md`, `docs/axi.md`,
    `skills/gitsheets/SKILL.md` and its `references/` (the options, the two
    commands, the lineage rule, the replace guard).
11. **Release** (after merge, not on this branch): additive surface plus one error-code refinement on an error path: a semver
    **minor** for `gitsheets` and `gitsheets-axi` (lockstep on `v*`). The core
    changes, so per CLAUDE.md's ordering rule: merge → tag `core-napi-v0.12.0`
    (minor; new napi options and exports) → sync manifests → run the
    release-flow skill for `v2.15.0`. Python: bump
    `rust/gitsheets-py/Cargo.toml` to `0.9.0` (pre-1.0 minor) and tag
    `py-v0.9.0` from a `rust-core.yml`-green commit, independently.

## Validation

Core (`cargo test -p gitsheets-core`):

- [ ] A trailer with a bad key, a newline in a value, or the key
      `Gitsheets-Lineage` fails `begin` with `trailer_invalid`, no tree work.
- [ ] `also_parents` writes parents `[first, ...also]` in order with one
      `Gitsheets-Lineage: <full hash>` trailer each, after the caller's.
- [ ] An `also_parents` entry that does not resolve, or names a tree or a
      blob, is `parent_not_found`; a duplicate, the first parent itself, or
      use with `orphan` is `commit_failed`; nothing moves in each case.
- [ ] A transaction with `also_parents` that changes nothing commits nothing.
- [ ] `allow_empty` on top of the tip commits with the tip's tree, the
      message, the trailers, and any lineage parents.
- [ ] Replace with the right tip: the new commit has the tip's first parent,
      starts from the tip's tree, keeps the tip's extra parents and their
      roles by default, and the ref moves from the old tip to the new commit.
      `also_parents` given replaces them; `also_parents: []` drops them.
- [ ] **Replace refused when the tip moved**: an expected tip that is not
      the tip fails at open with `tip_mismatch` (`expected`, `actual`) and
      the handler never runs; a tip moved by another writer between open and
      commit fails at commit with `tip_mismatch` and the ref stays where the
      other writer put it. `parent_moved` is never raised in replace mode.
- [ ] Replace on an unborn branch, or with a value that does not resolve, is
      `tip_mismatch` with `actual: null` / the found tip.
- [ ] **Replace refused when the replaced commit is already on the remote**:
      with `refs/remotes/origin/<branch>` at the tip (or at a descendant of
      it), replace fails with `tip_published` at open and nothing changes;
      a tracking ref that moves onto the tip after open fails it at commit.
- [ ] Replace with a commit-hash `parent`, `parent: null`, or a different
      `branch` is `commit_failed` at open.
- [ ] Replace that only rewrites the message of a tip that changed records
      commits; replace whose result equals the new first parent's tree
      without `allow_empty` commits nothing and leaves the tip; with
      `allow_empty` it commits.
- [ ] Replace of a root commit produces a root commit.
- [ ] Rollup pass in replace mode: a tip that changed partition P, replaced
      by a transaction that reverts P's records, leaves P's rollup equal to
      the new first parent's (no stale rollup); a partition only the
      replacement touches is regenerated.
- [ ] **A lineage parent that `sync` does not act on**: local branch `L`
      whose tip names, as a lineage parent, the tip of an unrelated branch
      with many commits; diverged from the remote. `sync_branch` replays only
      the local first-parent commits (`ahead` counts them only), the replayed
      tip keeps the lineage parent as its second parent and its marker
      trailer, and no commit from the unrelated branch is replayed.
- [ ] A lineage parent that is itself a remote commit not on the local
      first-parent chain does not move the merge base: `sync` still replays
      the local commits after the real base.
- [ ] **A lineage parent that `merge` does not act on**: `ours` names a
      commit of `theirs` as a lineage parent; `merge_sheets` is not
      `up-to-date`, its base is the true fork point, and `theirs`' changes
      before the lineage parent are merged.
- [ ] A history with no lineage markers gives the same base, counts, and
      replay set as gix's `merge_base` / `rev_walk` (property-style test over
      linear, diverged, and real-merge histories), and an unmarked
      multi-parent commit keeps its merge semantics.
- [ ] `commit_info` round-trips subject, body, trailers (in order, repeated
      keys kept), parent roles `first` / `lineage` / `merge`, and ISO dates
      with the commit's offset; a message whose last paragraph is not all
      `Key: value` lines has no trailers.

Bindings:

- [ ] napi: `alsoParents`, `replace`, `allowEmpty` reach the core;
      `replacedCommitHash` in the result; each new code surfaces as the right
      class with `code`, and `tip_mismatch` carries `expected` / `actual`;
      `readCommit` shape.
- [ ] pytest: the same three kwargs, `replaced_commit_hash`, `commit_read`,
      the new codes; the cross-binding parity suite gets a lineage commit, a
      replacing commit, and an empty commit, byte-identical from Node and
      Python.

JS library (vitest):

- [ ] `repo.transact` with each option end to end; a replacement rebinds live
      sheets; a malformed trailer is `trailer_invalid` from the TS check.
- [ ] Submodule mode on a detached `HEAD`: replace moves `HEAD` from the
      replaced tip (CAS), and refuses a mismatched tip with nothing moved.
- [ ] Push daemon: replace of an unpushed tip, then the daemon pushes the
      replacement fast-forward; replace of a pushed tip is `tip_published`;
      a push of a tip replaced behind gitsheets' back (tracking ref not
      updated) is a terminal `non-fast-forward` error, never forced.
- [ ] `repo.readCommit()` on an unborn default branch is `null`; an
      unresolvable `rev` is `ref_not_found`.

Human CLI (vitest, `packages/gitsheets/src/cli/`):

- [ ] `--trailer 'Key: value'` and `--trailer Key=value` both land; no
      separator exits 2; a bad key exits 69; a repeated key keeps the last
      value.
- [ ] `--also-parent` with an unresolvable commit exits 65; `--replace` with
      a wrong tip exits 69 and nothing moves; `--replace` with a commit-hash
      `--ref` or a different `--commit-to` exits 2.
- [ ] `GITSHEETS_REPLACE`, `GITSHEETS_ALSO_PARENT`, `GITSHEETS_ALLOW_EMPTY`
      in the environment are ignored.
- [ ] `git sheet commit` without `--message`, or with neither
      `--allow-empty` nor `--replace`, exits 2; with `--allow-empty` prints
      the new hash; `git sheet head` prints `CommitInfo` JSON, `null` on an
      unborn branch.

gitsheets-axi (vitest, `packages/gitsheets-axi`):

- [ ] **Flag validation**: each committing command accepts `--trailer`,
      `--also-parent`, `--replace`; `--allow-empty` outside `commit` is
      `VALIDATION_ERROR`; a trailer with no separator, a bad key, the
      reserved key, or a repeated key is `TRAILER_INVALID` with exit 2 and
      no commit; an unknown flag is still `VALIDATION_ERROR`.
- [ ] **An empty commit with trailers**: `commit --allow-empty --message m
      --trailer 'Cycle-Id: 42' --also-parent <c>` commits; `head` shows the
      trailer, the `Gitsheets-Lineage` marker, and the parent roles.
- [ ] `upsert --replace <tip>` of a record replaces the tip (output has
      `replaced:`), skipping the no-op preflight; `upsert --replace <other>`
      is `TIP_MISMATCH` with exit 1 and the tip unchanged; on a pushed tip it
      is `TIP_PUBLISHED`.
- [ ] `upsert --also-parent <c>` of an unchanged record is `result: no-op`
      with no commit.
- [ ] **`--json-out` shapes**: `head --json-out` writes a `CommitInfo` object
      (keys `branch`, `hash`, `tree`, `parents[{hash,role}]`,
      `author{name,email,date}`, `committer{…}`, `subject`, `body`,
      `trailers[{key,value}]`) to an owner-only temp file, and `=path` writes
      there; stdout stays TOON with `wrote`; on an unborn branch the file
      holds `null`.
- [ ] **Headless branch**: in a repository whose working tree is on `main`,
      `--branch log`, `GITSHEETS_BRANCH=log`, and `git config
      gitsheets.branch log` each make `commit`, `--replace`, and `head`
      act on `refs/heads/log`; `main` and the working tree are untouched
      (no materialize hint), and an unborn `log` is bootstrapped by
      `commit --allow-empty` as other first writes are.
- [ ] Under `--at`, `commit` and `--replace` are refused like every write.

Housekeeping:

- [ ] `cargo clippy`, `npm run type-check`, `npm test`, `cargo test`,
      pytest, and markdownlint clean.
- [ ] Docs and skill updated; `docs/axi.md` and the `gitsheets-axi` help
      text list `commit` and `head`.

## Risks / unknowns

- **gix has no edge-filtered merge base.** The lineage-aware walk in
  `history.rs` is new code on the sync and merge paths. Keeping gix's answer
  when no marker is seen limits the blast radius; criss-cross histories that
  also carry lineage markers may need the "best common ancestor" rule spelled
  out during the build. If that turns hairy, the fallback is to refuse
  (`not_an_ancestor`-style) rather than guess, and record it here.
- **The submodule detached-`HEAD` pointer** is advanced by the hosts, not the
  core, with a CAS from `parentCommitHash`. Replace mode must switch that CAS
  to the replaced tip in both bindings, or a replacement there would fail
  its own pointer move.
- **Remote-tracking freshness.** `tip_published` is only as good as the
  tracking refs. A daemon push in flight while a replacement lands slips
  past it; the push then fails as `non-fast-forward`, which is safe but
  terminal for the daemon until the consumer intervenes.
- **The `trailer_invalid` code change** alters what a caller switching on
  `commit_failed` sees for a malformed trailer. It is the one deliberate
  change to an existing call; the review may prefer keeping `commit_failed`
  in the library and adding the distinct code only in the CLIs.

## Notes

Populated at closeout.

## Follow-ups

Populated at closeout.
