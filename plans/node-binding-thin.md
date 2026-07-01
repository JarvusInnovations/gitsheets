---
status: in-progress
depends: [sheet-store-core, canonical-rebaseline, markdown-codec-core, locale-collation-core, markdown-normalize-core, attachment-staging-core]
specs:
  - specs/rust-core.md
  - specs/api/conventions.md
issues: [127]
---

# Plan: re-thin the Node binding over the full core (the cutover)

## Scope

Make the published `gitsheets` npm package a **thin marshalling shell** over
`gitsheets-core`, and retire the JS engine implementation. This is the Node
**cutover**: the moment consumers run on the Rust core end-to-end. **In:** the
`gitsheets-napi` surface, the idiomatic JS API preserved unchanged, the consumer
(Standard Schema) validator hook, error mapping, removal of the now-dead JS
engine, and the live re-baseline. **Out:** Python (parallel plan).

## Implements

- [`specs/rust-core.md`](../specs/rust-core.md) — the thin-binding half of the
  split; "no consumer-visible public-API change" except the deliberate, documented
  bytes re-baseline.
- [`specs/api/conventions.md`](../specs/api/conventions.md) — the public surface is
  preserved exactly.

## Approach

- Wire the public `Repository`/`Sheet`/`Transaction`/`Store` classes to call
  `gitsheets-core` via `gitsheets-napi`, keeping signatures identical.
- Run the **Standard Schema validator** in the binding (native object), before
  marshalling to the core — per the documented write order.
- Map core error variants → the existing typed error classes.
- **Delete** the JS engine (TOML serialize/parse, normalization, path templates,
  validation, query, Sheet/Tx) now that the core owns them; drop `smol-toml`,
  `@iarna`, `ajv` from the JS layer where the core subsumes them.
- Ship the **canonical re-baseline** as part of the cutover (the one
  consumer-visible byte change, documented).

## Validation

- [x] The **entire** existing gitsheets vitest suite passes against the
      core-backed binding — **287 gitsheets + 66 gitsheets-axi green** after
      Phase A (bytes-authority through the core).
- [x] The published **entry** (`index.d.ts`) type surface is unchanged — no
      consumer-visible type change. (Internal-only `.d.ts` deltas: a new
      non-re-exported `core.d.ts`; `compileSchema` — never in the entry surface —
      removed from `validation.d.ts`.)
- [ ] `/audit-spec-drift` clean against the API + behavior specs. *(pending —
      run after Phase B.)*
- [~] `smol-toml` / `@iarna` / `ajv` (+ `ajv-formats`) / `markdownlint`
      **removed** ✓. `@hologit/holo-tree` / `sort-keys` / `rfc6902` **still
      present** — they back the not-yet-cutover orchestration/read path (Phase B).
      `from 'hologit'` never appeared; holo-tree is still imported by
      `substrate.ts` / `working-tree.ts` / `repository.ts` / `sheet.ts`.
- [ ] Bulk upsert/query benchmarked vs the pre-cutover JS path. *(deferred to
      Phase B — the write path still runs on holo-tree, so a bulk benchmark isn't
      yet meaningful.)*

## Risks / unknowns

- **Re-baseline as a consumer-visible change** — the one place the migration breaks
  byte-stability. Document loudly; provide the one-command re-normalize for
  existing repos (from [`canonical-rebaseline`](canonical-rebaseline.md)).
- **The consumer-validator round-trip** (native → core) must not regress validation
  timing or error semantics.

## Notes

**Landed in this pass — Phase A: the bytes-authority half.** The package now
hard-depends on the `@gitsheets/core-napi` addon (registered as a workspace
member; the built `.node` links via the workspace). A new internal `core.ts`
loads the **raw** addon (`index.js`, not `binding.cjs` — whose duplicate error
classes we don't use) and maps the core's structured errors onto the canonical
`errors.ts` classes (verified via `simulateCoreError`: right `instanceof` /
`code` / `status` / `issues`). Routed through the core, all green:

- **TOML** — `stringifyRecord` / `parseToml` / `parseConfigToml` →
  `serializeRecords` / `parseRecords`. Dropped `@iarna/toml` + `smol-toml`.
- **Markdown** — `markdownFormat` + `extractFirstH1` / `rewriteLeadingH1` → the
  core codec (native `dprint-plugin-markdown`). Dropped `markdownlint`.
- **JSON-Schema validation** — `validateRecord`'s schema layer → `validateBatch`.
  Dropped `ajv` + `ajv-formats`. Standard Schema stays host-side.

**Enumerated bytes/behavior changes observed (consumer-facing):**

1. TOML canonical re-baseline (#5): the core requotes strings to the toml-crate
   form (embedded-quote string → multiline `"""…"""`) and drops integer
   underscores. **No test-corpus impact** — no test asserts the changed shapes —
   but it IS a real on-disk change; existing repos re-normalize once.
2. Markdown body re-baseline (#4): native dprint rewrites unordered-list markers
   to `-` and single-spaces them (`* item` → `- item`). 3 test expectations
   re-based to the pinned dprint output.
3. Markdown non-string-body guard (#6): kept as the historical `TypeError` via a
   cheap host-side guard before the core call; title↔H1 disagreement / missing-H1
   surface the core's typed `ValidationError`.
4. **Validation strict-mode leniency (NOT in the prompt's enumerated #1-6, but
   pre-accepted by the core — see `gitsheets-core::validation` "See the plan
   Notes").** Former `ajv` `strict: true` rejected unknown JSON-Schema keywords
   (and `$data`) at compile with `ConfigError(config_invalid)`; the core's
   `jsonschema` crate is lenient and silently ignores them, so a typo'd/`$data`
   schema now compiles. Record-level validation of valid schemas is at parity
   (validity + instance path + failing-keyword `code`). Updated
   `specs/behaviors/validation.md` + the one strict-mode test to the new behavior.

**`.d.ts` / public surface:** the consumer entry surface (`index.d.ts`
re-exports) is byte-for-byte identical. Internal-module `.d.ts` deltas only:
new `core.d.ts` (not re-exported) and `compileSchema` removed from
`validation.d.ts` (never re-exported from the entry).

**Deliberately NOT done — Phase B: the orchestration/thin-binding half.** The
`Repository` / `Transaction` / `Sheet` / `Store` state machine and the tree/read
path still run on `@hologit/holo-tree` (via `substrate.ts` / `working-tree.ts`);
`sort-keys` (normalize) and `rfc6902` (`diffFrom`) remain; `node:vm` still backs
the exported `Template` render + raw-JS sort comparators. This was scoped out of
this pass for correctness: it is a large, subtle rewrite of the ~1.6k-line
`sheet.ts` plus `transaction.ts` / `repository.ts` onto `CoreTransaction`'s
two-phase protocol and the batch read fns, with many host-side parity points to
preserve (see Follow-ups). The core surface to build against is proven at the
napi boundary; the remaining work is host-side marshalling glue, deferred rather
than rushed to a non-green state.

**Addon-packaging decision:** deferred (documented follow-up). This pass links
the locally-built addon via the workspace; the per-platform prebuild + npm
distribution (mirroring holo-tree's `optionalDependencies` playbook) is a
release-track item.

## Follow-ups

- **Phase B — orchestration cutover (the holo-tree drop).** Wire
  `Repository.transact` → `CoreTransaction.begin/finalize` (keep the JS `Mutex`
  around `begin` to preserve in-process queueing vs the core's throwing
  single-writer slot; keep ALS nested-tx detection + post-commit hooks + author
  resolution). Delegate tx-bound `Sheet` mutations to `CoreTransaction`
  (`prepareUpsert` → host Standard-Schema validator → `stageUpsert`; `delete` /
  `clear` / attachments / `willChange` / `list`). Non-tx reads → batch fns at
  `treeRef = "HEAD"` (`recordList`/`recordQuery` + **host-side** JS-function
  filters and symbol annotations `RECORD_PATH_KEY`/`RECORD_SHEET_KEY`; abort
  signal; lazy body). `diffFrom` → the rename-aware `diffRecords` (synthesize
  `srcMode`/`dstMode` from hash presence; wrap `srcHash`/`dstHash` in
  `makeBlobHandle`). Non-tx attachment reads → `git ls-tree` + `git cat-file`;
  `Repository.resolveRef` → `git rev-parse`. In-memory indexes rebuild over the
  non-tx list. Then delete `working-tree.ts` / `substrate.ts` / the `sheet.ts`
  engine internals and drop `@hologit/holo-tree` / `sort-keys` / `rfc6902`.
  Then: bulk upsert/query benchmark vs the pre-cutover path; `/audit-spec-drift`.
- **Core validator strict-mode parity.** If the spec's ajv-strict
  unknown-keyword / `$data` rejection is wanted back, it must be added to the
  core (`gitsheets-core::validation`) — the binding can't re-impose it without
  re-introducing `ajv`. Currently resolved by relaxing the spec (see Notes #4).
- **Per-platform addon prebuild + npm publish** (release track): build the six
  napi triples, publish the addon, and consume it as a real dependency instead of
  the workspace-linked local `.node`.
