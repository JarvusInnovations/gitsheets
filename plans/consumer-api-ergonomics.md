---
status: in-progress
depends: []
specs:
  - specs/behaviors/attachments.md
  - specs/api/sheet.md
  - specs/api/repository.md
  - specs/api/errors.md
  - specs/behaviors/transactions.md
  - specs/behaviors/validation.md
  - specs/api/store.md
issues: [234, 236, 237]
---

# Plan: Consumer API ergonomics — bytes attachments, withLock, Standard Schema typing

## Scope

The ergonomics batch from the first production 2.x migration
([#234](https://github.com/JarvusInnovations/gitsheets/issues/234),
[#236](https://github.com/JarvusInnovations/gitsheets/issues/236),
[#237](https://github.com/JarvusInnovations/gitsheets/issues/237)):

**In:**

- `Sheet.setAttachment` / `setAttachments` accept raw bytes
  (`Buffer` / `Uint8Array`) alongside `string` and `BlobHandle` — one-call
  attachment writes.
- `repo.withLock(fn)` — expose transact's write mutex for coordinating
  non-transact git ops; **non-reentrant**, with async-context deadlock guards
  throwing the new `TransactionError` code `lock_held`.
- Align the exported `StandardSchemaV1` types with the published Standard
  Schema v1 interface so compliant Zod v4 schemas assign without `as` casts;
  compile-time regression test against real Zod v4 (dev dependency).

**Out:**

- A `setAttachmentBytes` alias (redundant once `setAttachment` takes bytes;
  the issue offered either).
- Cross-process locking (out of scope like the transaction mutex itself).
- #184/#235 — the parallel `sheet-freshness-streaming` plan (PR #238).

## Implements

- [`specs/behaviors/attachments.md`](../specs/behaviors/attachments.md) —
  `setAttachment(record, name, content)` value-type table.
- [`specs/api/sheet.md`](../specs/api/sheet.md) — attachments signature note.
- [`specs/api/repository.md`](../specs/api/repository.md) — `repo.withLock(fn)`.
- [`specs/api/errors.md`](../specs/api/errors.md) — `lock_held` code row.
- [`specs/behaviors/transactions.md`](../specs/behaviors/transactions.md) —
  single-writer table rows for `withLock`.
- [`specs/behaviors/validation.md`](../specs/behaviors/validation.md) —
  "Type-level contract: no casts required".
- [`specs/api/store.md`](../specs/api/store.md) — validators assignability note.

## Approach

All host-shell (TypeScript); no Rust core / napi changes (`addon.writeBlob`
already takes a `Buffer`; the mutex and the type declarations are host
concerns).

- **#234** — widen the attachment content type to
  `string | Buffer | Uint8Array | BlobHandle`; in the tx-bound branch, hash
  `Uint8Array` bytes through `addon.writeBlob` (Buffer passthrough,
  `Buffer.from` copy for plain `Uint8Array`).
- **#236** — `withLock` acquires the existing `Mutex`; a module-level
  `AsyncLocalStorage` lock context marks the callback's async scope. Guards:
  `withLock` throws `lock_held` when called inside a lock context *or* a
  transaction handler; `transact` throws `lock_held` when called inside a
  lock context (permissive mutations auto-open transactions, so they're
  covered by the same guard).
- **#237** — replace the hand-rolled `StandardSchemaV1` subset in
  `validation.ts` with interfaces structurally identical to the published
  spec (`Props.types` carrier, `PropertyKey` issue paths, `vendor`/`version`),
  dropping the fake `__types__` prop; keep exported names. Host issue mapping
  learns `symbol` path segments. Add `zod` (v4) as a dev dependency of the
  `gitsheets` workspace and a vitest file whose *compilation* asserts direct
  assignability (`satisfies ValidatorMap`, `InferRecord` inference) and whose
  runtime asserts validate/transform/reject behavior through `openStore`.

## Validation

- [ ] `setAttachment(record, name, buffer)` and mixed-value `setAttachments`
      write attachments byte-identical to the `repo.writeBlob` two-step —
      vitest.
- [ ] `repo.withLock` serializes against `repo.transact` FIFO (observable
      ordering), returns the callback's value, releases on throw — vitest.
- [ ] All three self-deadlock shapes throw `TransactionError('lock_held')`
      immediately: `withLock` in `withLock`, `withLock` in a transact
      handler, `transact` (and a permissive mutation) in `withLock` — vitest.
- [ ] Real Zod v4 object schemas assign to `openStore({ validators })` and
      `openSheet({ validator })` with no casts; `InferRecord` yields the Zod
      output type; suite compiles under `tsc --noEmit` — compile-time test.
- [ ] Zod validate/transform/reject flows work end-to-end through the typed
      Store (transform reflected in written bytes; failure carries
      `source: 'standard-schema'` issues) — vitest runtime.
- [ ] Full suites green: package vitest + type-check, `cargo test`, napi
      `node --test` (core untouched).

## Risks / unknowns

- **Structural-typing drift vs future Zod majors** — the compile-time test
  pins against whatever Zod v4 minor is installed; a future Zod type change
  surfaces as a type-check failure here rather than in consumers.
- **`lock_held` is a new public error code** — additive; codes are stable
  and new scenarios get new codes per specs/api/errors.md.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
