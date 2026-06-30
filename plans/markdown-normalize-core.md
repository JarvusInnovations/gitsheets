---
status: in-progress
depends: [markdown-codec-core]
specs:
  - specs/behaviors/content-types.md
  - specs/rust-core.md
issues: [127]
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

- [ ] `content-types.md` describes native body normalization + the new config
      surface; it's a standalone reviewable commit.
- [ ] Body normalization is **deterministic + idempotent** (`normalize(normalize(b))
      == normalize(b)`); a markdown record round-trips byte-stably.
- [ ] `normalize = false` (or the chosen toggle) keeps the body verbatim.
- [ ] The `markdownlint` npm dependency and the host-side resolution plumbing are
      gone; the core owns normalization.
- [ ] `cargo build/test` + clippy clean; napi boundary suite passes (markdown
      fixtures re-baselined); the main JS suite stays green and independent (the
      JS package still uses its own markdown path until the cutover — don't break
      it here).

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

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
