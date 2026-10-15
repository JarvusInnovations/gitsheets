---
status: done
depends: [repo-sync]
specs:
  - specs/behaviors/push-sync.md
  - specs/api/repository.md
issues: [330]
pr: 333
---

# Plan: sync({ afterMove }) and repo.fetch()

## Scope

`sync({ afterMove })` awaits the callback under the write lock after a move
and the rebind; `repo.fetch()` exposes sync's fetch step. Host-only.

## Implements

- `specs/behaviors/push-sync.md` — sync steps 3–4, `repo.fetch`.
- `specs/api/repository.md` — `SyncOptions.afterMove`, `repo.fetch`.

## Approach

1. `Repository.fetch(opts)` → `FetchResult`; `sync` calls it.
2. `sync`: the core move, the rebind and `afterMove` all inside one
   `withLock`; daemon hand-off and conflict push after.
3. Tests: afterMove sees the moved ref and rebound sheets, a concurrent
   transact queued during afterMove commits only after it returns,
   transact inside afterMove is lock_held, not called when nothing moved;
   fetch ok / failure value.

## Validation

- [x] vitest: the cases above; existing sync suite unchanged.
- [x] type-check clean.

## Risks / unknowns

- None; the lock stays per Repository instance.

## Notes

- The core move, the rebind and `afterMove` share one `withLock`; the daemon
  hand-off and conflict push stay outside it.
- A transaction started *from inside* `afterMove` inherits its async
  context and is `lock_held`; one started from another context queues and
  commits after the callback returns (the test asserts the ordering).

## Follow-ups

- None.
