---
status: in-progress
depends: []
specs:
  - specs/behaviors/content-types.md
  - specs/api/sheet.md
issues: [308]
---

# Plan: accept an explicit null body on markdown upsert

## Scope

On a content-typed sheet, `upsert` (and `willChange`) accept a record whose
body field is explicitly `null` without `allowMissingBody`, writing an
empty body. Absent / `undefined` keeps throwing. Host-only: the napi
marshal drops null-valued keys, so the core sees an absent body; the host
guard is where "null" is still observable, and it passes the opt-in
through on the consumer's behalf.

Out of scope: reading an empty body back as `null` (#308 point 2) — it
would be the first place a record carried a null, against the
normalization rule; parked until a spec decision.

## Implements

- `specs/behaviors/content-types.md` — "Upsert with a body-less record".
- `specs/api/sheet.md` — `allowMissingBody` note.

## Approach

1. `Sheet.#prepareUpsert` and the `willChange` path: detect
   `record[bodyField] === null` and pass `allowMissingBody: true` to the
   core; the `undefined` guard is unchanged.
2. Tests in `sheet-markdown-lazy.test.ts`: null body upserts without
   opt-in and reads back `''`; `undefined` still throws; `willChange`
   agrees.
3. Docs: `docs/api.md`, skill `references/api.md` upsert rows.

## Validation

- [ ] vitest: the three cases above; existing suites unchanged.
- [ ] `npm run type-check` clean.

## Risks / unknowns

- None of note; the marshal contract (null keys dropped) is untouched,
  which a downstream consumer depends on.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
