---
status: done
depends: []
specs:
  - specs/behaviors/attachments.md
  - specs/api/sheet.md
issues: [244]
pr: 246
---

# Close out attachment-handle spec↔code drift (#244)

## Scope

Resolve the spec drift flagged in #244: `specs/behaviors/attachments.md` documented a `repo.writeBlobFromFile('/path')` helper and hologit-era `BlobObject` handles that the 2.x surface never implemented.

## Implements

- `specs/behaviors/attachments.md`, `specs/api/sheet.md` (naming corrections; no behavior change)

## Approach

The primary drift (`writeBlobFromFile` example + "hologit BlobObject or whatever the new substrate provides" prose) was already superseded by #242's bytes-accepting `setAttachment` spec rewrite. This plan sweeps the residue: remaining `BlobObject` references corrected to the shipped types — `BlobHandle` for diff `srcBlob`/`dstBlob`, `AttachmentBlobHandle` for attachment getters — across `specs/api/sheet.md`, `specs/behaviors/attachments.md`, and `docs/api.md`. A file-path convenience helper was deliberately **not** added: with `setAttachment` accepting raw bytes (#234), `readFile` → one call covers the case; reopen if a consumer needs streaming file writes.

## Validation

- [x] `grep -rn "writeBlobFromFile\|BlobObject" specs/ docs/` returns only migration-guide historical references
- [x] Names verified against the shipped surface (`packages/gitsheets/src/sheet.ts`: `BlobHandle`, `AttachmentBlobHandle`)

## Risks / unknowns

None — docs-only.

## Notes

Decision recorded: spec amended rather than implementing `writeBlobFromFile`; rationale above.

## Follow-ups

- None.
