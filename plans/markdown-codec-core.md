---
status: in-progress
depends: [sheet-store-core]
specs:
  - specs/rust-core.md
  - specs/behaviors/content-types.md
issues: [127]
---

# Plan: markdown/mdx content-type codec in the core

## Scope

Port the content-typed record format (`markdown`/`mdx`: TOML frontmatter + a
designated body field, stored as `.md`/`.mdx`) into `gitsheets-core`, so markdown
sheets round-trip through the core like TOML sheets do. **In:** the
frontmatter+body codec (parse/serialize), H1-title extraction, lazy body, the
`markdownlint` body-normalization pass, and `allowMissingBody`. **Out:** the Node
binding cutover that consumes it ([`node-binding-thin`](node-binding-thin.md)).

> **Why this exists.** `sheet-store-core` deferred the markdown codec — markdown
> record ops currently fail loudly in the core. But markdown/content-types is a
> **shipping, tested** feature of the JS package (≈9 vitest files). The Node
> cutover must pass the *entire* suite while deleting the JS engine, so the codec
> must live in the core first. (Split out as a pre-cutover prerequisite.)

## Implements

- [`specs/behaviors/content-types.md`](../specs/behaviors/content-types.md) —
  re-implemented behavior-preserving in Rust.
- [`specs/rust-core.md`](../specs/rust-core.md) — the bytes-authority owns the
  on-disk record format, markdown included.

## Approach

- **Codec.** Port `packages/gitsheets/src/format/markdown.ts` (and `format/index.ts`,
  the format dispatch) to the core: parse `.md`/`.mdx` = TOML frontmatter block +
  body field; serialize the inverse, byte-stable. The frontmatter goes through the
  same canonical TOML serializer as TOML records (one bytes-authority).
- **Title / body rules.** H1-title extraction (`title-from-h1`), the body field
  name from `[gitsheet.format].body`, lazy body loading, `allowMissingBody`.
- **markdownlint normalization.** The body-normalization pass on write
  (`markdownlint` config passed through). Match the JS output, or — if a faithful
  Rust markdownlint is impractical — flag it explicitly as a parity risk and
  decide (native pass vs. a documented divergence) rather than silently skipping.
- Wire the format dispatch into the `record`/`sheet` write/read paths (format is
  fixed per-sheet via `[gitsheet.format]`), batch-first.

## Validation

- [ ] A markdown record round-trips byte-identically to the canonical on-disk form
      (frontmatter + body), matching `format/markdown.ts` behavior.
- [ ] H1 title extraction, lazy body, and `allowMissingBody` match the JS suite.
- [ ] Body `markdownlint` normalization matches the JS output (or the divergence is
      enumerated and justified).
- [ ] `cargo build/test` + clippy clean; napi boundary suite passes; the main JS
      suite stays green and independent.

## Risks / unknowns

- **markdownlint parity** — the JS body normalization uses the `markdownlint`
  package; a Rust equivalent may differ. This is the biggest unknown; budget a
  real parity pass and treat any divergence as a finding.
- **Lazy body** across the FFI — the lazy-load semantics must survive the boundary
  (don't force-load bodies the consumer didn't ask for).

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
