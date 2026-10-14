---
status: in-progress
depends: []
specs:
  - specs/api/transaction.md
  - specs/behaviors/transactions.md
  - specs/api/repository.md
issues: [305]
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

- [ ] `cargo test`: orphan begin/finalize (no parents, empty start, branch
      created, existing branch refused, detached when no branch); fork
      branch created from `main`; CAS on a moved non-parent branch fails.
- [ ] napi + pytest: orphan option round-trips; `write_file` bytes/str;
      `delete_file`.
- [ ] vitest: the host tests above; existing CLI config-write tests pass.
- [ ] clippy / type-check clean.

## Risks / unknowns

- **Branch create uses an unconditional ref set** when the branch is
  absent at open (holo-tree's `update_ref` has no must-not-exist mode).
  A branch created concurrently between open and commit would be
  overwritten; acceptable for the single-writer premise.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
