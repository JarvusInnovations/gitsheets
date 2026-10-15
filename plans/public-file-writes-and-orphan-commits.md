---
status: done
depends: []
specs:
  - specs/api/transaction.md
  - specs/behaviors/transactions.md
  - specs/api/repository.md
issues: [305]
pr: 311
---

# Plan: public tx.writeFile/deleteFile, orphan commits, branch creation

## Scope

- Promote `tx.writeFile(path, content)` / `tx.deleteFile(path)` from
  `@internal` to public: `content` is `string | Buffer | Uint8Array`,
  `writeFile` returns a `BlobHandle`. Python gains `write_file` /
  `delete_file`.
- `transact({ parent: null })`: orphan root commit — empty starting tree,
  no parents, `parentCommitHash: null`, always commits. With `branch`,
  the branch is created; an existing branch is refused at open
  (`commit_failed`).
- `opts.branch` naming a branch that does not exist is created at commit;
  one that exists (and is not the parent ref) is compare-and-swapped
  against its tip at open.

Out of scope: a `force` option to re-point an existing branch at an
orphan (delete the ref first).

## Implements

- `specs/api/transaction.md` — "Raw files", "Parent ref handling", errors.
- `specs/behaviors/transactions.md` — parent/branch handling.
- `specs/api/repository.md` — `transact` option shapes.

## Approach

1. **Core** `TransactionOptions.orphan: bool`; `resolve_parent` returns no
   parent and no parent ref for an orphan; a `branch` whose ref already
   exists is `CommitFailed` at begin. The branch tip is captured at begin
   (`branch_old`) whenever `branch_ref != parent_ref`, and `finalize`
   compare-and-swaps against it (`None` → create). Orphans skip the
   no-op tree comparison (they always commit).
2. **napi** `JsTransactionOptions.orphan?: boolean`; `writeFile` accepts
   `string | Buffer`. **pyo3** `begin(..., orphan=False)`; `write_file`
   (`str | bytes`) and `delete_file`.
3. **Host** `TransactionOptions.parent?: string | null` → `orphan`;
   `Transaction.writeFile` returns `BlobHandle` and takes bytes; both
   public with doc comments. Tests: orphan commit has no parent line,
   starts empty on a non-fresh repo, creates the branch, refuses an
   existing one; `branch` fork from `main`; `writeFile` with string and
   bytes; `deleteFile` boolean.
4. **Docs**: `docs/api.md` (Transaction rows, transact options), skill
   `references/api.md`.

## Validation

- [x] `cargo test`: orphan begin/finalize (no parents, empty start, branch
      created, existing branch refused, detached when no branch); fork
      branch created from `main`; CAS on a moved non-parent branch fails.
- [x] napi + pytest: orphan option round-trips; `write_file` bytes/str;
      `delete_file`.
- [x] vitest: the host tests above; existing CLI config-write tests pass.
- [x] clippy / type-check clean.

## Risks / unknowns

- **Branch create uses an unconditional ref set** when the branch is
  absent at open (holo-tree's `update_ref` has no must-not-exist mode).
  A branch created concurrently between open and commit would be
  overwritten; acceptable for the single-writer premise.

## Notes

- An orphan onto an existing branch is refused at `begin` with `commit_failed`
  rather than a new error code — there is no parent to make a move safe.
- `branch` naming a ref other than the parent captures that ref's tip at
  open and compare-and-swaps at commit; absent means created (holo-tree's
  `update_ref` has no must-not-exist mode, so creation is an unconditional
  set — acceptable under the single-writer premise).
- napi `begin` is a factory: its errors arrive as plain `Error` with the typed
  `code`, which the host's `callCore` maps; the boundary test checks the code.
- pyo3 0.29: `Bound::cast` not `downcast`; `extract::<String>()` for str.

## Follow-ups

- None.
