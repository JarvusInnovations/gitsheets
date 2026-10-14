---
status: in-progress
depends: []
specs:
  - specs/behaviors/attachments.md
  - specs/api/sheet.md
issues: [302]
---

# Plan: renaming a record moves its attachments

## Scope

A rename-on-upsert (record annotated with `RECORD_PATH_KEY`, new rendered
path differs) moves `<base>/<old>/` to `<base>/<new>/` in the same core
`stage_upsert`, merging into an existing destination directory. The
delete-then-upsert idiom stays lossy (cascade rule); the spec documents
keeping the annotation across a symbol-stripping validator.
`gitsheets-axi rename` switches to the upsert-with-annotation idiom so a
CLI rename carries attachments.

Out of scope: a `sheet.move(record, next)` API. Rename-on-upsert needs no
new surface, and the annotation idiom is one line; filed as a follow-up
only if a consumer still asks after this ships.

## Implements

- `specs/behaviors/attachments.md` — "Move on record rename".
- `specs/api/sheet.md` — `upsert` rename bullet.

## Approach

1. **Core** `Sheet::stage_upsert`: when `previous_path != record_path`,
   detach the `Child::Tree` at the old attachment dir from its parent and
   re-attach it at the new dir (O(1), clean subtree hash reused); if the
   destination already exists, merge entries (source wins on name).
   Then the existing old-record-file delete. Test: attachments present at
   the new path and absent at the old; merge case; no-op when the record
   has no attachments.
2. **axi `rename`**: upsert `{ ...existing, [field]: newPath }` (spread
   keeps the symbol annotation) and drop the explicit `delete(oldPath)`.
   Test: a renamed record keeps its attachment.
3. **Host test**: rename via upsert moves attachments; delete+upsert does
   not (documents the contract).
4. **Docs**: `docs/api.md` upsert row, skill `references/api.md`
   annotations paragraph, skill `references/axi.md` rename entry.

## Validation

- [ ] `cargo test`: rename moves the attachment subtree; merge into an
      existing destination; records without attachments unaffected.
- [ ] vitest (`gitsheets`): rename-on-upsert moves attachments (tx and
      permissive); delete+upsert loses them (asserted, as documented).
- [ ] vitest (`gitsheets-axi`): `rename` keeps attachments.
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean;
      `npm run type-check` clean.

## Risks / unknowns

- **Destination merge semantics** — source entries overwrite same-named
  destination entries. Chosen over "refuse" because an upsert that lands on
  an existing path already overwrites the record file; attachments follow
  the same rule.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
