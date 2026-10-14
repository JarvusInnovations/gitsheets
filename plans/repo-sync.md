---
status: done
depends: []
specs:
  - specs/behaviors/push-sync.md
  - specs/api/repository.md
  - specs/behaviors/freshness.md
issues: [301]
pr: 316
---

# Plan: opt-in repo.sync()

## Scope

`repo.sync(opts)` per the push-sync spec: fetch outside the lock (git
subprocess, explicit refspec), classify + move under the write lock in
the core (fast-forward CAS, per-commit replay via gix 3-way tree merge,
or the preserve-branch escape), hand ahead/replayed tips to a running
push daemon, best-effort push of a conflict branch, rebind live sheets
when HEAD's branch moved. `repo.isAncestor(a, b)`. Both bindings expose
the core halves (`sync_branch`, `is_ancestor`).

Out of scope: a CLI / axi `sync` command (follow-up if asked), replaying
merge commits non-linearly (local history is linearized like
`git rebase`), and any force-push.

## Implements

- `specs/behaviors/push-sync.md` — "Sync (opt-in, explicit)", `isAncestor`.
- `specs/api/repository.md` — `repo.sync`, `repo.isAncestor`, errors.
- `specs/behaviors/freshness.md` — rebind after sync.

## Approach

1. **Core** `sync.rs`: `sync_branch(repo, SyncOptions) -> SyncResult`
   (`gix` `merge_base`, `rev_walk().with_hidden()` for counts and the
   replay list, `merge_trees` + `holo_repo::commit_tree` for the replay,
   `update_ref` CAS), `is_ancestor`. The gix `merge` feature is enabled.
2. **napi / pyo3**: `syncBranch` / `sync_branch`, `isAncestor` /
   `is_ancestor`.
3. **Host** `Repository.sync`: HEAD-branch default, fetch, `withLock` +
   core, daemon hand-off, conflict-branch push, rebind. `isAncestor`.
4. Tests: core (ff / ahead / rebased / conflict / escape / unrelated);
   host integration against a bare remote with a second clone as the
   other writer; napi + pytest smoke.
5. Docs: `docs/api.md`, `docs/concepts.md`, skill `SKILL.md` anti-pattern
   and `references/api.md`.

## Validation

- [x] `cargo test`: the six core outcomes; replay preserves author +
      message and sets the committer; `is_ancestor`.
- [x] vitest: in-sync, fast-forward (+ live sheets see it), ahead (+
      daemon pushes), rebased (+ remote record visible, local commit on
      top), conflict (fail), conflict-escaped (branch preserved + pushed),
      fetch-failed, lock_held inside transact, isAncestor.
- [x] napi + pytest: `syncBranch` / `sync_branch` fast-forward and
      `isAncestor` / `is_ancestor` round-trip.
- [x] clippy / type-check clean.

## Risks / unknowns

- gix `merge_trees` honours `.gitattributes` merge drivers through
  `blob_merge_command_ctx`; records have none, so the built-in text merge
  applies. Conflict markers are never written to the branch — a conflict
  stops the replay before any ref moves.

## Notes

- The outcome vocabulary is the consumer's reconcile module's (`in-sync`,
  `fast-forwarded`, `ahead` (was `pushed-ahead`), `rebased`, `conflict`,
  `conflict-escaped`, `fetch-failed`) so its logs and alerts carry over.
- Replay is pure plumbing in the core (gix `merge_trees` per local commit,
  `commit_tree` with the original author and a set committer); nothing to
  abort, no working tree. Only the fetch and the conflict-branch push spawn
  git.
- `onConflict: 'fail'` is the default (nothing moves, the offending commit is
  named); `'preserve-branch'` is the consumer's boot-time choice.
- `ahead` / `rebased` tips are handed to a running push daemon via
  `notifyCommit`; sync never pushes the branch itself.
- The daemon hand-off test waits 500 ms for the daemon's deferred
  startup-backlog check before creating work, else that check pushes first.

## Follow-ups

- Tracked as: a CLI / `gitsheets-axi sync` command when a consumer asks (the
  library surface is the deliverable here).
