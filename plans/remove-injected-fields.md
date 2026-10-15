---
status: in-progress
depends: [template-fields-require-schema]
specs:
  - specs/principles.md
  - specs/behaviors/path-templates.md
  - specs/behaviors/validation.md
issues: [304]
---

# Plan: remove injectedFields

## Scope

Drop the `[gitsheet].injectedFields` escape hatch shipped in 2.8.0. The
open-time template check becomes "every static template field is in a
top-level `required` of the local schema or a declared contract", no
exemptions; a config still carrying the key fails with
`ConfigError(config_invalid)` naming it. Write the principle behind the
decision (`specs/principles.md` "Records carry their own path") and link
it from the path-templates spec. Breaking relative to 2.8.0, called out in
the release notes.

## Implements

- `specs/principles.md` — the principle.
- `specs/behaviors/path-templates.md` — the check without an exemption
  list, plus the `## Principles` reference.
- `specs/behaviors/validation.md` — pointer.

## Approach

1. Core: drop `SheetConfig.injected_fields`; `parse_config` rejects the
   key with a message naming the principle; `Sheet::open` checks
   `required` only. Core / napi / Python / host / axi fixtures that
   declared `slug` injected now require it in a local
   `[gitsheet.schema]`.
2. Host: comment and tests; the removed-key case gets a host test.
3. Docs and the agent skill drop the key and point at the principle.

## Validation

- [ ] `cargo test`: the removed key is `config_invalid` naming it; the
      unrequired-field case names the remedy without an exemption.
- [ ] napi + pytest: the same two cases.
- [ ] vitest + axi: fixtures pass with `required` instead; the removed key
      rejects at `openSheet`.
- [ ] clippy / type-check clean.

## Risks / unknowns

- The only known adopter never pushed an `injectedFields` config.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
