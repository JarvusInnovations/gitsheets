---
status: in-progress
depends: []
specs:
  - specs/api/repository.md
  - specs/api/store.md
  - specs/behaviors/freshness.md
  - specs/api/errors.md
issues: [303]
---

# Plan: public read-only sheets at a ref

## Scope

`repo.openSheet(name, { ref })`, `repo.openSheets({ ref })`, and
`openStore(repo, { ref })` open sheets whose read snapshot is the tree
`ref` resolved to at open time. Pinned sheets are not registered for
auto-refresh / `repo.refresh()`; `sheet.refresh()` re-resolves the pinned
ref; `store.refresh()` on a pinned store refreshes its sheets. Permissive
writes throw `TransactionError(transaction_required)`. `clone()` keeps
the pin. Host-only.

Out of scope: a separate `store.at(ref)` sugar (the option on `openStore`
is the same thing), and pinning a transaction-bound sheet.

## Implements

- `specs/api/repository.md` — `openSheet` / `openSheets` `opts.ref`, errors.
- `specs/api/store.md` — "Pinned stores".
- `specs/behaviors/freshness.md` — "Ref-pinned sheets".
- `specs/api/errors.md` — `transaction_required` row.

## Approach

1. `Repository.#resolveTreeOf(ref)` (`git rev-parse --verify <ref>^{tree}`
   → `RefError(ref_not_found)`), used by `openSheet` / `openSheets` when
   `opts.ref` is set; an `@internal resolveTreeForRef` so `Sheet.refresh`
   can re-resolve.
2. `SheetConstructorOptions.pinnedRef`; the constructor skips
   `registerSheet` for pinned sheets; `refresh()` re-resolves the pin;
   `#checkStrictMode()` also rejects pinned writes; `clone()` carries it.
3. `OpenStoreOptions.ref` → `openSheets({ ref })` and
   `openSheet(name, { validator, ref })`; `refresh` refreshes each sheet
   when pinned.
4. Tests (`sheet-pinned.test.ts`): reads at a branch and at a commit;
   invisible HEAD commits; `sheet.refresh()` catches a branch up; writes
   throw; `openStore({ ref })` + `store.refresh()`; missing ref.
5. Docs: `docs/api.md`, skill `references/api.md`.

## Validation

- [ ] vitest: the cases above; existing freshness suite unchanged.
- [ ] `npm run type-check` clean.

## Risks / unknowns

- A branch-pinned sheet's `refresh()` moving the view is by design; the
  spec says so explicitly so no consumer mistakes it for immutability.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
