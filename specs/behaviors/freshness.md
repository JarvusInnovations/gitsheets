# Behavior: Read Freshness

## Rule

A non-transaction `Sheet` reads through a **read snapshot** — the repository's
`HEAD` tree hash, captured when the sheet was opened. The snapshot is **rebound
to the current `HEAD` tree**:

1. **Automatically**, after every transaction on the owning `Repository`
   instance that produces a commit (explicit `repo.transact` / `store.transact`
   *and* permissive-mode auto-transactions). This gives **read-your-writes**: a
   record committed through any surface of a `Repository` is immediately
   visible to every standing `Sheet` that repository has issued.
2. **Explicitly**, via `sheet.refresh()`, `store.refresh()`, or
   `repo.refresh()` — the consumer's tool after **out-of-band ref movement**
   (another process committed, a `git fetch` + reset, a hot-reload merge).

gitsheets never watches the ref: there is no polling and no automatic detection
of commits made outside the `Repository` instance. That is deliberate — the
single-writer model ([push-sync.md](push-sync.md)) makes the owning process the
source of truth for when the ref can move underneath it.

## Applies To

- [api/sheet.md](../api/sheet.md) — `query`/`queryFirst`/`queryAll`, `count`,
  `loadBody`, `findByIndex`, `getAttachment(s)`, `attachments()`,
  `getAttachmentStream`, `diffFrom` (dst side), `readConfig`
- [api/repository.md](../api/repository.md) — `repo.refresh()`, and the
  auto-refresh performed by `repo.transact`
- [api/store.md](../api/store.md) — `store.refresh()`
- [behaviors/indexing.md](indexing.md) — index invalidation on rebind

## Details

### What a rebind refreshes

Rebinding swaps the sheet's snapshot tree and lazily re-derives everything
downstream of it:

- **Record reads** — `query`/`queryFirst`/`queryAll`/`count`/`loadBody`
  resolve against the new tree on their next call.
- **Attachment reads** — `getAttachment`/`getAttachments`/`attachments()`/
  `getAttachmentStream` resolve against the new tree.
- **`diffFrom`** — the dst side of the diff is the new tree.
- **Sheet config** — the memoized `.gitsheets/<name>.toml` is dropped and
  re-read lazily from the new tree, so a *committed* config change becomes
  visible without re-opening the sheet.
- **Indexes** — every index build is invalidated by the snapshot-hash
  comparison and lazily rebuilt on its next `findByIndex` (the "out-of-band
  ref movement" path in [indexing.md](indexing.md#invalidation)). Note the
  cost: a rebuild is a full body-less scan of the sheet, per index, per
  rebind that actually changed the tree.

### Rebind semantics

- The snapshot always comes from **`HEAD` at rebind time** — not from the
  transaction's result tree. A transaction that commits onto a non-`HEAD`
  branch (`opts.parent: 'feature-x'`) leaves `HEAD`'s tree unchanged, so
  standing sheets do **not** shift onto the other branch's state.
- A rebind to a tree hash identical to the current snapshot is a no-op
  (memoized config and index builds are kept).
- Rebinding applies to every live `Sheet` the `Repository` instance has
  issued — via `openSheet`, `openSheets`, `openStore`, or `Sheet.clone()`.
  Sheets are tracked weakly; holding a `Sheet` does not leak, and dropping one
  requires no lifecycle call.
- `repo.refresh()` re-resolves `HEAD^{tree}` once and rebinds every live
  sheet. `sheet.refresh()` rebinds only that sheet (the "did my row land?"
  primitive). `store.refresh()` delegates to `repo.refresh()` — a Store's
  sheets are Repository-issued sheets, and partial-store freshness is not a
  meaningful state.

### Interaction with transactions

- **Transaction-bound sheets** (`tx.sheet(name)`, `tx.<sheet>` in
  `store.transact`) always read the transaction's private in-progress tree.
  They are never rebound; calling `refresh()` on one throws `TypeError`.
- Reads through standing sheets **while a transaction is open** still see the
  pre-commit snapshot ([transactions.md](transactions.md#single-writer-model)
  — reads don't take the mutex). The rebind happens only after the commit
  succeeds; a discarded transaction rebinds nothing.
- A no-op transaction (no commit produced) does not rebind — the tree didn't
  move.

### Iteration stability

A `query()` async iterator captures the snapshot when iteration starts and
continues against it even if a rebind happens mid-iteration. The rebind
affects subsequent calls, never an in-flight traversal.

### Pinned / historical reads

There is no API to pin a `Sheet` to an old tree. Point-in-time reads go
through explicit refs: `sheet.diffFrom(srcRef)` for record-level change
feeds, `repo.readBlobStream(ref, path)` for raw blob bytes at any ref.

## Principles

**Local:**

- **Read-your-writes beats frozen snapshots.** A standing `Sheet` is a live
  view of the repository's committed state *as this process advances it* —
  not an immutable snapshot pinned at open time. When snapshot stability and
  post-write visibility conflict, gitsheets picks visibility: a consumer that
  just committed a record must be able to read it back through the handles it
  already holds. (First production consumers universally worked around the
  pinned-snapshot behavior rather than relying on it — see
  [#184](https://github.com/JarvusInnovations/gitsheets/issues/184).) Pinned
  historical reads go through explicit refs, not through withholding refresh.

## Coordinates with

- [api/repository.md](../api/repository.md)
- [api/sheet.md](../api/sheet.md)
- [api/store.md](../api/store.md)
- [behaviors/transactions.md](transactions.md)
- [behaviors/indexing.md](indexing.md)
- [behaviors/push-sync.md](push-sync.md)
- [GitHub #184](https://github.com/JarvusInnovations/gitsheets/issues/184) — motivating issue
