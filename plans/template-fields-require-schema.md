---
status: done
depends: []
specs:
  - specs/behaviors/path-templates.md
  - specs/behaviors/validation.md
  - specs/api/cli.md
issues: [304]
pr: 309
---

# Plan: flag path-template fields the schema does not require

## Scope

At sheet open, in every binding, check the path template against the
sheet's persisted schema: each static template field (plain, recursive, or
date-bucket base) must be in the top-level `required` of the local
`[gitsheet.schema]` or of a declared contract, or be listed in the new
`[gitsheet].injectedFields` allow-list. Otherwise the open fails with
`ConfigError` (`config_invalid`) naming the field and both remedies.
Expression components are exempt. Sheets with no schema and no contracts
are not checked.

Out of scope: a warning mode (a library has no warning channel anyone
reads; the point is to fail before the first write), and inspecting
`required` nested inside `allOf` / `oneOf` / `if`.

## Implements

- `specs/behaviors/path-templates.md` — "Template fields must be schema-required".
- `specs/behaviors/validation.md` — "Template coherence" pointer.
- `specs/api/cli.md` — `contracts verify` reports the open failure.

## Approach

1. **Core config**: `parse_config` reads `injectedFields` (array of strings;
   anything else is `config_invalid`) into `SheetConfig.injected_fields`.
2. **Core template**: `Template::static_field_names()` — the top-level field
   of each `Field` / `Bucket` part, insertion-ordered and de-duplicated;
   expressions skipped.
3. **Core open**: `compile_effective_schema` also returns the union of each
   document's top-level `required` (local schema + every loaded contract),
   so the contracts are loaded once. `Sheet::open` runs the check when any
   schema document exists.
4. **napi**: `sheetConfigCheck(gitDir, treeRef, configPath, openRoot)` opens
   a core `Sheet` against the committed tree and discards it — the full
   open-time validation (config, contracts, template coherence) surfaced to
   the host through the typed error taxonomy. Added to `binding.cjs`.
5. **Host**: `loadConfig` calls `sheetConfigCheck` after its own parse (so
   host-native messages for malformed configs are unchanged), before caching.
   `repo.openSheet`, `contracts verify`, and `git sheet check` all go through
   it. Python needs nothing: `Sheet::open` is the check.
6. **Docs**: `docs/path-templates.md`, `docs/validation.md`,
   `skills/gitsheets/references/sheet-config.md` (`injectedFields` row + the
   rule under path template syntax).

## Validation

- [x] `cargo test`: open fails for a plain field, a recursive field, and a
      bucket base that the schema does not require; passes when required
      locally, required by a contract, or listed in `injectedFields`; an
      expression-only template is never checked; a sheet with no schema is
      never checked; a non-array `injectedFields` is `config_invalid`.
- [x] napi `node --test`: `sheetConfigCheck` throws `config_invalid` with the
      field named, and passes with `injectedFields`.
- [x] vitest (`gitsheets`): `repo.openSheet` throws `ConfigError`
      (`config_invalid`) for the bad template; `contracts verify` exits
      non-zero on it; `injectedFields` unblocks the open; existing suites
      unchanged.
- [x] pytest: `Sheet` open raises the config error for the bad template.
- [x] `cargo clippy --workspace --all-targets -- -D warnings` clean;
      `npm run type-check` clean.

## Risks / unknowns

- **Existing consumers** whose template names an optional or undeclared
  field will fail to open after upgrading. That is the bug this plan
  exists to catch; the fix is one config line. Called out in the release
  notes.
- **Cache key**: the host caches parsed config by config-blob hash, so a
  contract edit that drops a `required` entry without touching the config
  blob is not re-checked until the process restarts. Acceptable: contracts
  rarely drop requirements, and the core re-checks on every transaction
  open.

## Notes

- Error, not warning, at open: a library has no warning channel anyone reads.
  The escape hatch is `[gitsheet].injectedFields`; the message names both
  remedies.
- A dotted plain reference (`${{ meta.slug }}`) parses as an *expression* in
  the template grammar, so it is exempt like any expression; only a date
  bucket contributes a dotted base field.
- Static field extraction lives in both the core (`Template::static_field_names`)
  and the host `Template.getStaticFieldNames()` — one implementation per
  side, mirroring the existing `getFieldNames` pair — because `infer` /
  `migrate-config` run host-side (both CLIs) and need it to write `required`.
- Nine test fixtures across the suites templated on `slug` while their
  schemas required other fields: exactly the bug class, fixed by declaring
  `slug` injected or required.
- The napi test script enumerates files; `sheet-config-check.mjs` was added
  but not registered until #311 wired it in.

## Follow-ups

- None.
