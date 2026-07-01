---
status: done
depends: [markdown-codec-core]
specs:
  - specs/behaviors/content-types.md
  - specs/rust-core.md
issues: [127]
pr: https://github.com/JarvusInnovations/gitsheets/pull/214
---

# Plan: native markdown body normalization (dprint) in the core

## Scope

Replace the JS `markdownlint` body normalization with a **native Rust
`dprint-plugin-markdown` formatter in the core**, so markdown body bytes are
byte-stable and **identical across every binding** (Node, Python, …). **In:** the
native normalizer wired into the codec write path, the `content-types.md` spec
change (the `markdownlint` config surface → a native-normalize toggle), the
version pin (behavior contract), and a re-baseline of the core's markdown
fixtures. **Out:** the Node cutover that deletes `format/markdown.ts` and
re-baselines the JS vitest markdown expectations (that's
[`node-binding-thin`](node-binding-thin.md)).

> **Why this exists / supersedes a deferral.** `markdown-codec-core` framed bodies
> verbatim and left lint+fix to a **host-side** `markdownlint` pre-pass — which
> would let Python and Node normalize markdown bodies *differently* (a
> bytes-authority gap). Decision (with the user): markdown data is negligible, so
> re-baseline to a native formatter. `dprint-plugin-markdown` owns the canonical
> body form natively in the core. This removes the host-side markdownlint plumbing
> (incl. `markdownResolveLintConfig`) and the `markdownlint` npm dependency.

## Implements

- [`specs/behaviors/content-types.md`](../specs/behaviors/content-types.md) —
  amended: body normalization is the native formatter, not `markdownlint`; the
  config surface changes accordingly. **Spec-first, its own commit.**
- [`specs/rust-core.md`](../specs/rust-core.md) — the bytes-authority owns markdown
  body normalization; the formatter version is pinned like the serializer, engine,
  and collator.

## Approach

- **Spec first (own commit).** Amend `content-types.md`: markdown/mdx bodies are
  normalized by the native formatter on write; replace `[gitsheet.format.markdownlint]`
  / `markdownlint = false` with a native toggle (e.g. `normalize = false` to keep
  bodies verbatim; default on). Keep it minimal — drop markdownlint-rule-specific
  config (markdownlint is gone). State the one-time re-baseline of body bytes.
- **Native normalizer.** Add `dprint-plugin-markdown` as a core dependency.
  **Confirm it's usable as a direct Rust library API** (`format_text`-style),
  not only as a dprint CLI/WASM plugin — if it can't be embedded directly, STOP
  and report (fall back to `comrak`). Normalize the body on codec **serialize**
  (write), idempotently; parse/read leaves the body as-is.
- **Config: aggressive, with `textWrap: "never"`.** Unwrap each paragraph to a
  single logical line (remove soft line breaks; preserve hard breaks + block
  boundaries) and take dprint's opinionated normalization (table column
  alignment, consistent list/emphasis/heading/code-fence style, blank-line
  collapsing). `textWrap: "never"` means `lineWidth` does NOT affect prose bytes,
  so it need not be a fragile contract input for prose (record whatever still
  matters, e.g. table behavior). Capture the EXACT emitted config in code +
  `content-types.md`.
- **Pin** the formatter version (`=x.y.z`) and the chosen config — body bytes
  depend on them, so they're a canonical-behavior contract input alongside the
  serializer/engine/collator.
- **Remove** the host-side markdownlint plumbing from `markdown-codec-core`
  (`markdownResolveLintConfig` and the napi entry point) — superseded.
- **Re-baseline** the core's markdown fixtures (Rust + napi `sheet-markdown.mjs`)
  to the native formatter's output.

## Validation

- [x] `content-types.md` describes native body normalization + the new config
      surface; it's a standalone reviewable commit (`docs(specs): rebaseline
      content-types normalization to native dprint`).
- [x] Body normalization is **deterministic + idempotent** (`normalize(normalize(b))
      == normalize(b)`); a markdown record round-trips byte-stably. Demonstrated in
      `codec::tests::normalize_body_is_deterministic_and_idempotent` +
      `serialize_normalizes_the_body_on_write`, and the napi `normalizeBody is
      deterministic and idempotent` test.
- [x] `normalize = false` keeps the body verbatim
      (`codec::tests::normalize_false_frames_the_body_verbatim`, napi
      `normalize:false frames the body verbatim`).
- [x] The `markdownlint` host-side resolution plumbing is gone; the core owns
      normalization (grep of `rust/` for `Markdownlint`/`resolveLint` is clean; the
      only residual `markdownlint` mentions are doc comments noting its removal).
      The `markdownlint` npm dep stays in `packages/gitsheets` until the Node
      cutover (`node-binding-thin`), as scoped.
- [x] `cargo build/test` + clippy clean; napi boundary suite passes (markdown
      fixtures re-baselined); the main JS suite stays green and independent.

## Risks / unknowns

- **dprint embeddability** — confirm `dprint-plugin-markdown` exposes a direct Rust
  formatting API usable as a normal crate dependency (not just a WASM dprint
  plugin). If not, fall back to `comrak::format_commonmark` (and note the switch).
- **Re-baseline scope** — markdown data is negligible by design, but enumerate
  exactly which in-repo fixtures change.
- **Config surface churn** — dropping markdownlint-specific config is a (small)
  consumer-visible API change; it's acceptable because markdown is barely used and
  pre-1.0, but document it in `content-types.md`.

## Notes

- **dprint vs comrak: dprint won.** `dprint-plugin-markdown` embeds directly as a
  normal Rust crate — `dprint_plugin_markdown::format_text(text, &Configuration,
  format_code_block_cb) -> Result<Option<String>>` — no WASM/CLI plugin harness,
  no `comrak` fallback needed. Confirmed with a throwaway crate before wiring: it
  formatted messy input to clean, idempotent output. Pinned **`=0.22.1`** (latest;
  ~11 transitive crates, incl. `pulldown-cmark`).
- **Exact config** (`codec::MARKDOWN_CONFIG`, all set explicitly so emitted bytes
  are nailed down by our file, not a transitive default):
  `textWrap=never`, `emphasisKind=underscores`, `strongKind=asterisks`,
  `unorderedListKind=dashes`, `headingKind=atx`, `listIndentKind=commonMark`.
  `textWrap=never` unwraps each paragraph to one logical line, so `lineWidth` is
  inert for prose (left at the crate default).
- **Idempotence demo.** `"#  Hello\n\n\n\nsome   text that\nis soft-wrapped\n\n*
  one\n*  two\n"` → `"# Hello\n\nsome text that is soft-wrapped\n\n- one\n- two\n"`,
  and normalizing that again yields the same bytes. Asserted in both the Rust unit
  tests and the napi boundary suite; also proven end-to-end (`willChange` no-op on
  a round-tripped record).
- **Ordering.** Normalization runs **before** title-from-H1 extraction, so a
  setext H1 (`Title\n====`) is converted to ATX and *then* recognized — a
  setext-authored title is extracted rather than lost.
- **Removed plumbing.** `config::Markdownlint` enum + `resolve` (the host-pre-pass
  ruleset), the napi `markdown_resolve_lint_config` / `markdownResolveLintConfig`
  entry, and the `markdownlint` re-export. Replaced `FormatConfig.markdownlint`
  with `FormatConfig.normalize: bool`. Added `codec::normalize_body` (+ napi
  `markdownNormalizeBody`) and a `normalize?` param on `markdownSerialize`.
- **Re-baselined fixtures.** `rust/gitsheets-core/src/codec.rs` tests (new:
  `normalize_body_is_deterministic_and_idempotent`,
  `normalize_body_rewrites_emphasis_and_setext_headings`,
  `serialize_normalizes_the_body_on_write`,
  `normalize_false_frames_the_body_verbatim`,
  `normalization_feeds_title_from_setext_h1`; helpers switched to `normalize:
  bool`) and `rust/gitsheets-napi/test/sheet-markdown.mjs` (the 3
  `resolveLintConfig` tests replaced by 5 native-normalization tests). The
  *existing* clean-input fixtures were already idempotent under dprint, so only
  those explicit new cases and the config-surface tests
  (`rust/gitsheets-core/src/config.rs`: `normalize_*`) changed — no golden-byte
  fixture files (`.md`/`.toml`) needed regenerating.
- **Validation results.** `cargo test -p gitsheets-core` = 148 pass; `cargo clippy
  --workspace --all-targets -- -D warnings` clean; `cargo build --workspace
  --all-targets` clean; napi `npm test` = 94 pass (30 markdown); root
  `npm run type-check` clean and `npm test` green (33 files/287 + 8 files/66) —
  the gitsheets-axi tests require `npm run build` first (unbuilt `dist/` in a fresh
  worktree; unrelated to this change).

## Follow-ups

- **Node cutover (`node-binding-thin`).** Delete `packages/gitsheets/src/format/
  markdown.ts`'s markdownlint pipeline, remove the `markdownlint` npm dependency,
  and re-baseline the JS vitest markdown expectations to the native formatter —
  out of scope here (this plan changed only the core + its fixtures).
- **Config re-emit.** `dprint-plugin-markdown` also supports a `deno()` preset and
  a code-block formatter callback; gitsheets leaves embedded code blocks verbatim.
  Revisit if consumers want fenced-code normalization.
