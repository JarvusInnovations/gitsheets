---
status: done
depends: [template-fields-require-schema]
specs:
  - specs/principles.md
  - specs/behaviors/path-templates.md
  - specs/behaviors/validation.md
issues: [304]
pr: 321
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

- [x] `cargo test`: the removed key is `config_invalid` naming it; the
      unrequired-field case names the remedy without an exemption.
- [x] napi + pytest: the same two cases.
- [x] vitest + axi: fixtures pass with `required` instead; the removed key
      rejects at `openSheet`.
- [x] clippy / type-check clean.

## Risks / unknowns

- The only known adopter never pushed an `injectedFields` config.

## Notes

- The removed key is rejected by name (`config_invalid`, "injectedFields was
  removed", pointing at the principle) rather than passed as an unknown key,
  so nobody silently loses the check they thought they had escaped.
- The fixture replacement everywhere is a local `[gitsheet.schema]` that
  requires the template key; builders that already took a schema add `slug`
  to its `required`.

## Follow-ups

- Tracked as: a possible `x-references` annotation keyword in contracts
  (declaring `project-memberships.projectSlug → projects.slug`) if the
  consumer's Zod-metadata prototype proves out; strict contract compilation
  would need to accept it. Not committed to.
