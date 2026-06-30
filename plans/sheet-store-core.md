---
status: planned
depends: [record-query-index]
specs:
  - specs/rust-core.md
  - specs/api/sheet.md
  - specs/api/transaction.md
  - specs/api/store.md
  - specs/behaviors/transactions.md
issues: [127]
---

# Plan: Sheet / Transaction / Store state machine in the core

## Scope

Lift the orchestration layer — `Sheet`, `Transaction`, `Store` — into
`gitsheets-core`, on top of the record engine. **In:** the transaction lifecycle
(parent resolution, optimistic concurrency, commit + ref update), sheet config
resolution, the Store multi-sheet surface, and the strict/permissive mutation
rules. **Out:** the binding-level idiomatic surface and the consumer validator
(those stay per-binding) and the working-tree `--working` path (deferred).

## Implements

- [`specs/rust-core.md`](../specs/rust-core.md) — "The `Sheet` / `Transaction` /
  `Store` state machine" in the core.
- [`specs/api/sheet.md`](../specs/api/sheet.md),
  [`specs/api/transaction.md`](../specs/api/transaction.md),
  [`specs/api/store.md`](../specs/api/store.md),
  [`specs/behaviors/transactions.md`](../specs/behaviors/transactions.md) —
  behavior-preserving (the *contracts* don't change; the implementation moves).

## Approach

- **Transaction.** parent resolution, the in-process mutex / serialization, the
  optimistic `parent_moved` re-check, no-op detection, commit-tree + update-ref
  (already in holo-tree's `commit_tree`/`update_ref`, now with explicit identity).
- **Sheet.** config resolution (`read_toml` for `.gitsheets/<name>.toml`), the
  upsert/willChange/patch pipeline, strict-vs-permissive mode.
- **Store.** the typed multi-sheet surface + `Store.transact`.
- The consumer-validator hook is a **callback into the binding** at the documented
  point (native object → consumer validator → core), since it runs host-side.

## Validation

- [ ] The full transaction lifecycle (commit, no-op, `parent_moved`, strict mode)
      matches the JS behavior and the specs.
- [ ] An upsert through the core produces the same commit/tree as the JS path for
      the same input (post-rebaseline), incl. correct author/committer identity.
- [ ] The consumer-validator callback fires at the right point and can reject a
      write before any bytes are written.
- [ ] The existing transaction/Sheet/Store test suite passes against the core.

## Risks / unknowns

- **The consumer-validator callback across FFI** is the trickiest seam — a
  host-language function invoked mid-core-operation. Design the re-entrancy
  carefully (or validate-then-commit in two phases to avoid calling back into the
  host while holding core state).
- **Behavioral parity surface is large** — this is where "no public-API change"
  is truly tested. Lean on the existing suite as the oracle.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
