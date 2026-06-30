---
status: done
depends: [sheet-store-core]
specs:
  - specs/rust-core.md
  - specs/behaviors/content-types.md
issues: [127]
pr: https://github.com/JarvusInnovations/gitsheets/pull/212
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

- [x] A markdown record round-trips byte-identically to the canonical on-disk form
      (frontmatter + body), matching `format/markdown.ts` behavior. *(codec unit
      tests + `test/sheet-markdown.mjs` round-trip/idempotence; frontmatter bytes
      via the existing canonical serializer, already corpus-parity-proven.)*
- [x] H1 title extraction, lazy body, and `allowMissingBody` match the JS suite.
      *(ported to the codec units + the napi boundary suite.)*
- [x] Body `markdownlint` normalization — **divergence enumerated and justified**:
      the core does NOT run markdownlint (no byte-identical Rust port exists); it
      frames the body verbatim and computes the effective ruleset, leaving the
      lint+fix pass to a host-side pre-pass. See Notes.
- [x] `cargo build/test` + clippy clean; napi boundary suite passes (89/89); the
      main JS suite stays green (287 unit + integration) and never imports the
      `.node` addon.

## Risks / unknowns

- **markdownlint parity** — the JS body normalization uses the `markdownlint`
  package; a Rust equivalent may differ. This is the biggest unknown; budget a
  real parity pass and treat any divergence as a finding.
- **Lazy body** across the FFI — the lazy-load semantics must survive the boundary
  (don't force-load bodies the consumer didn't ask for).

## Notes

**What was built.** A `codec` module in `gitsheets-core` that format-dispatches
record serialize/parse: TOML records stay on the canonical TOML path; `markdown`/
`mdx` records encode as `+++`-delimited TOML frontmatter + a designated body
field (`.md`/`.mdx`). The frontmatter is serialized through the **same**
`canonical::serialize` as TOML records — one bytes-authority, no second TOML
path. The codec covers the full `splitOnDelimiters` behavior (UTF-8 BOM strip,
first-pair split with embedded `+++` lines preserved, the up-to-two leading + one
trailing newline handling), title-from-H1 extraction with the upsert
disagreement guard (`validation_failed` + issue), the `rewriteLeadingH1` patch
helper, and `parseHeaderOnly`. `+++` and first-H1 matching use the `regex` crate
with JS-equivalent multiline `^`/`$` + greedy `\s*` semantics (the H1 capture is
`[^\r\n]+?`, matching JS `.` excluding `\r`), so delimiter/H1 parsing is exact
rather than a hand-rolled approximation. Wired into the `Sheet` pipeline:
`prepare_upsert` serializes through the codec and enforces the body-presence
guard via `allow_missing_body`; `Sheet::list`/`CoreTransaction.list` gained a
`with_body` switch; index builds use body-less reads. The `require_toml`
deferral guard is gone. Boundary suite `test/sheet-markdown.mjs` (added to the
`npm test` script + CI) drives both the direct codec and end-to-end markdown
sheets through a transaction.

**markdownlint parity result — enumerated divergence (the headline finding).**
The JS oracle normalizes the body with the `markdownlint` npm package
(`lint` + `applyFixes`) on write. **The core does not reimplement this.**
`markdownlint` is ~40 rules of bespoke, interdependent fix logic with no
byte-identical Rust port; a partial reimplementation would *silently* emit
different body bytes for any body triggering a rule it handled differently or not
at all — exactly the failure mode the plan forbids ("STOP and report rather than
silently shipping different body bytes"). The chosen architecture instead splits
the concern cleanly:

- The core codec frames the body **verbatim** — the byte-deterministic,
  language-agnostic part (delimiters, frontmatter, trailing-newline,
  title-from-H1). It is byte-identical to `markdown.ts` **with `markdownlint =
  false`** (verified: round-trip + idempotence in both the cargo and node suites).
- The markdownlint **configuration** is fully parsed and the effective ruleset
  computed by the core (`config::Markdownlint::resolve` — defaults `{default:
  true, MD013: false, MD041: false}` layered with user overrides, plus the
  `MD041` auto-enable when title-from-H1 is on), exposed over the FFI as
  `markdownResolveLintConfig`. **Nothing is dropped.**
- The **application** of markdownlint to the body is a host-side pre-pass: the
  binding runs the `markdownlint` package (already in the Node ecosystem, and
  staying there post-cutover as a ~10-line pre-pass) before handing the record to
  the codec — exactly how the consumer Standard-Schema validator runs host-side.
  The core never calls back into the host (re-entrancy hazard).

Net for the cutover: `markdown.ts` is deletable; the body-normalization call
moves into the thin Node binding (lint → core codec), the framing matches
byte-for-byte, and the JS suite stays green. This is the one observable boundary
difference and it is intentional, documented (codec + `Markdownlint` rustdoc,
this plan), and does not change emitted body bytes silently — the core's body
bytes are exactly its input.

**Lazy-body handling.** Preserved across the FFI. `codec::parse_header_only`
reads frontmatter only and leaves the body field absent; `Sheet::list(.., false)`
and `CoreTransaction.list(name, false)` thread it through, and index builds
always read body-less (a `keyFn` on the body field sees it absent and the record
degenerates out of the index — matching the spec). The body is hydrated by a
full read (`list(.., true)`), the core analogue of `Sheet.loadBody`.

**Error-class divergence (minor, enumerated).** The JS body-presence and
body-not-a-string guards throw `TypeError`; the core surfaces them through the
typed taxonomy as `validation_failed` (message preserved). The cutover's thin
binding can remap these to `TypeError` host-side if exact class parity is wanted;
the tests assert on message/`code`, which match.

## Follow-ups

- **Node cutover (`node-binding-thin`, out of scope here).** Consume this codec:
  move the `markdownlint` lint+fix into the thin binding as the body pre-pass
  (feeding `markdownResolveLintConfig`'s ruleset), delete `format/markdown.ts`'s
  engine, and route `Sheet` markdown reads/writes through the core. Keep the
  ~9 markdown vitest files green; decide there whether to remap the body guards
  to `TypeError` for exact class parity.
- **`Sheet.query` body-field filter guard.** The `withBody: false` + filter-on-
  body `TypeError` guard (content-types spec) stays host-side today; if the query
  pipeline moves fully into the core, port the guard alongside it.
- **Pathological H1 edge.** A heading that is only `#` followed by spaces yields
  `None` here vs JS returning a whitespace string — untested, unrealistic for
  API-authored bodies; revisit only if a real body hits it.
