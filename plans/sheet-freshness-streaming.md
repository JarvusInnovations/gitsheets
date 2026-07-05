---
status: done
pr: 239
depends: []
specs:
  - specs/behaviors/freshness.md
  - specs/api/repository.md
  - specs/api/sheet.md
  - specs/api/store.md
  - specs/behaviors/attachments.md
  - specs/behaviors/indexing.md
  - specs/behaviors/transactions.md
issues: [184, 235]
---

# Plan: Read freshness (refresh + auto-refresh) and streaming blob reads

## Scope

Consumer-hardening from the first production 2.x migration
([#184](https://github.com/JarvusInnovations/gitsheets/issues/184),
[#235](https://github.com/JarvusInnovations/gitsheets/issues/235)):

**In:**

- The freshness model ([`specs/behaviors/freshness.md`](../specs/behaviors/freshness.md)):
  non-transaction `Sheet` reads resolve through a rebindable read snapshot.
  `sheet.refresh()`, `store.refresh()`, `repo.refresh()`, and **auto-refresh of
  every live sheet after a successful `repo.transact` commit** (read-your-writes).
- Streaming blob reads by key/path without materializing the record:
  `repo.readBlobStream(ref, path)` (call-time ref resolution) and
  `sheet.getAttachmentStream(recordOrPath, name)` (snapshot-resolved).

**Out:**

- Python-binding freshness parity (`rust/gitsheets-py` has its own host shell) —
  follow-up issue at closeout.
- Pinning a `Sheet` to an old tree (explicitly rejected by the freshness spec's
  read-your-writes principle; historical reads go through `diffFrom(srcRef)` /
  `readBlobStream(ref, path)`).
- #234/#236/#237 — the parallel `consumer-api-ergonomics` plan.

## Implements

- [`specs/behaviors/freshness.md`](../specs/behaviors/freshness.md) — whole spec (new).
- [`specs/api/repository.md`](../specs/api/repository.md) — `refresh`,
  `readBlobStream`, transact auto-refresh note.
- [`specs/api/sheet.md`](../specs/api/sheet.md) — `refresh`,
  `getAttachmentStream`, clone-freshness note.
- [`specs/api/store.md`](../specs/api/store.md) — `store.refresh()`.
- [`specs/behaviors/attachments.md`](../specs/behaviors/attachments.md) —
  "Streaming reads by key/path".
- [`specs/behaviors/indexing.md`](../specs/behaviors/indexing.md) /
  [`specs/behaviors/transactions.md`](../specs/behaviors/transactions.md) —
  invalidation/visibility wording aligned to the rebind model.

## Approach

All host-shell (TypeScript) work — verified the Rust core is stateless for
non-transaction reads (`recordQuery`/`recordQueryCandidates`/`coreDiscoverSheets`
take `gitDir` + `treeRef` per call; the core `Sheet`/`Store` state machine only
lives inside a `CoreTransaction`). No core or napi changes.

- **`Sheet`** — make `#readRef` mutable; `_rebindReadTree(tree)` (internal)
  swaps the snapshot and drops the memoized config promise; index builds
  invalidate automatically via the existing `treeHashAtBuild` comparison.
  Public `refresh()` re-resolves via the repo; throws `TypeError` when
  transaction-bound.
- **`Repository`** — weak registry (`Set<WeakRef<Sheet>>`) populated from the
  `Sheet` constructor for non-tx sheets (covers `openSheet`, `openSheets`,
  `openStore`, `clone`); `refresh()` resolves `HEAD^{tree}` once and rebinds
  live sheets, pruning dead refs; `transact` calls it after a commit-producing
  finalize (before post-commit hooks).
- **`Store`** — `refresh` property delegating to `repo.refresh()`; `Store<V>`
  type gains `readonly refresh: () => Promise<void>`.
- **`repo.readBlobStream(ref, path)`** — `git cat-file -t <ref>:<path>` type
  probe → typed `RefError`/`NotFoundError`, then a spawned
  `git cat-file blob` stdout as the `Readable` (consistent with the existing
  attachment-handle streaming; genuine git porcelain).
- **`sheet.getAttachmentStream`** — `getAttachment` (snapshot-resolved hash)
  → stream by hash; `null` passthrough.
- Docs: `docs/api.md` Repository/Sheet/Store sections.

## Validation

- [x] Standing `Sheet`/`Store` reads reflect a `repo.transact` commit
      immediately after it resolves (no re-open) — vitest.
- [x] External commit (second `Repository` instance) is invisible until
      `sheet.refresh()` / `repo.refresh()` / `store.refresh()`, visible after —
      vitest.
- [x] A commit onto a non-HEAD branch does **not** shift standing sheets — vitest.
- [x] `findByIndex` after a commit reflects the new tree (lazy rebuild), and a
      committed sheet-config change is visible after rebind — vitest.
- [x] `refresh()` on a tx-bound sheet throws `TypeError` — vitest.
- [x] `repo.readBlobStream` streams byte-identical content for a committed
      attachment; missing path / non-blob → `NotFoundError(record_not_found)`;
      bad ref → `RefError(ref_not_found)` — vitest.
- [x] `sheet.getAttachmentStream` streams current bytes through the snapshot
      (fresh after auto-refresh) and returns `null` when absent — vitest.
- [x] Full suites green: package vitest + type-check, `cargo test`, napi
      `node --test` (core untouched — suites prove no regression).

## Risks / unknowns

- **Behavior change for snapshot-reliant consumers** — auto-refresh replaces
  the accidental pinned-at-open behavior. Mitigated: the old behavior was
  never specified as a snapshot guarantee (repository.md said "bound to this
  repository's current state"), and the known consumers all worked around
  staleness rather than relying on it. Spec'd as the read-your-writes
  principle.
- **WeakRef registry growth** — long-lived repos opening many short-lived
  sheets. Mitigated: dead refs pruned on every refresh.
- **In-flight iteration during rebind** — `query()` captures its tree ref at
  call start; spec'd as iteration stability, no code change needed.

## Notes

- **Core statelessness confirmed** — the entire freshness model landed in the
  Node host shell; `recordQuery`/`recordQueryCandidates`/`coreDiscoverSheets`
  take `gitDir` + `treeRef` per call, so no core/napi change was needed and
  the napi suite (101) + `cargo test` pass untouched.
- **Auto-refresh resolves HEAD, not the result tree** — keeps non-HEAD-branch
  commits from shifting HEAD-bound sheets; covered by a dedicated test.
- **Indexes went fresh, not stale-pinned** — the existing `treeHashAtBuild`
  comparison made #184's "indices stay at the snapshot" carve-out unnecessary;
  rebinding invalidates builds and `findByIndex` lazily rebuilds.
- **Branch/PR churn** — the original branch (`feat/sheet-freshness-streaming`,
  PR #238) picked up two unrelated commits from the parallel #232 work via a
  shared working tree; rebased clean onto develop as
  `feat/read-freshness-streaming` (PR #239). #238 closed as superseded.

## Follow-ups

- Issue [#240](https://github.com/JarvusInnovations/gitsheets/issues/240) —
  Python-binding parity: rebindable snapshot + `refresh()` + auto-refresh +
  streaming blob read in `rust/gitsheets-py` (spec is binding-agnostic).
