---
status: done
pr: https://github.com/JarvusInnovations/gitsheets/pull/216
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
      core-backed binding — **288 gitsheets + 66 gitsheets-axi + 101 napi green**
      after Phase B (full orchestration on the core; addon built + `npm ci` +
      `npm run build && npm test`).
- [x] The published **entry** (`index.d.ts`) type surface is **byte-identical**
      to the pre-cutover baseline (`1db5e14`). The only closure-`.d.ts` deltas are
      in de-facto-internal types: the `@internal` `Repository`/`Transaction`/
      `Sheet` constructor-option shapes, removed undocumented-internal
      `Transaction` members (`tree`/`markMutated`/`parentRef`/`branchRef` — the
      tree/markMutated pair is called out as internal in `specs/api/transaction.md`),
      a new `@internal` `Transaction.writeFile`, a new `toTrailerArray` helper, a
      spec-mandated `FormatConfig.normalize?: boolean` (aligning the public type
      with `specs/behaviors/content-types.md`), and doc-comment/whitespace changes.
      No documented public method signature or result type
      (`UpsertResult`/`WillChangeResult`/`DiffChange`/`TransactionResult`/`Store`/
      `QueryFilter`/`BlobHandle`) changed.
- [x] `/audit-spec-drift` run against the API + behavior specs — see Notes.
- [x] `smol-toml` / `@iarna` / `ajv` (+ `ajv-formats`) / `markdownlint` **removed**
      (Phase A) and now `@hologit/holo-tree` **removed** ✓. No `from 'hologit'` /
      `@hologit/holo-tree` / JS-engine imports remain in `packages/*/src`
      (grep-proven). `sort-keys` + `node:vm` retained (public `Sheet.normalizeRecord`
      array-field sort + the exported `Template` render + raw-JS sort comparators);
      `rfc6902` retained (public `DiffChange.patch` `Operation` type + the markdown
      `diffFrom` path).
- [x] Bulk upsert/query benchmarked vs the pre-cutover JS path (2000 records):
      core-backed upsert **586 ms** (0.29 ms/rec) vs pre-cutover **773 ms**
      (0.39 ms/rec) → ~24% faster; `queryAll` **115 ms** vs **279 ms** → ~2.4× faster
      (after memoizing `Sheet.readConfig` over the instance's immutable ref).

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
4. **Validation strict-mode: PARITY (unknown-keyword rejection restored).** The
   former `ajv` `strict: true` rejected unknown JSON-Schema keywords (and `$data`)
   at compile with `ConfigError(config_invalid)`. The `jsonschema` crate is lenient
   by itself, so — per the user's "require rejection now" decision — the core
   (`gitsheets-core::validation`) now **walks the schema at compile and rejects any
   keyword outside the known Draft-07 vocabulary** (and `$data`), raising
   `config_invalid`, restoring the `ajv` strict guard. So this is **NOT a behavior
   change** — it is at parity with the pre-cutover behavior (validity + instance
   path + failing-keyword `code` for valid schemas; `ConfigError` for a typo'd/
   `$data` schema). `specs/behaviors/validation.md` documents the strict behavior.
   (This corrects an earlier draft of these Notes that described a since-reverted
   leniency.)

**`.d.ts` / public surface:** the consumer entry surface (`index.d.ts`
re-exports) is byte-for-byte identical. Internal-module `.d.ts` deltas only:
new `core.d.ts` (not re-exported) and `compileSchema` removed from
`validation.d.ts` (never re-exported from the entry).

**Landed in Phase B — the orchestration/substrate swap (the cutover).** The
`Repository` / `Transaction` / `Sheet` / `Store` state machine + attachments +
query + diff now run entirely on `gitsheets-core` via the napi surface; the JS
`@hologit/holo-tree` engine is deleted and the dependency dropped. The thin
binding shape:

- **Repository / Transaction:** `repo.transact` → `CoreTransaction.begin/finalize`.
  The core owns parent/branch resolution, the two-phase `prepareUpsert` →
  [host runs the consumer Standard-Schema validator] → `stageUpsert`, no-op
  detection, the optimistic `parent_moved` re-check, CAS ref movement, and
  commit-message/trailer formatting (a direct port of `transaction.ts`). The JS
  `Transaction` is a thin wrapper. The in-process single-writer `Mutex`/queue +
  `AsyncLocalStorage` nested-tx guard stay host-side (the core exposes a
  *throwing* per-repo slot; queueing is a host concern), as do git-config author
  resolution and post-commit hooks.
- **Sheet:** tx-bound `upsert`/`willChange`/`patch`/`delete`/`clear`/attachments
  drive `CoreTransaction`; the rename delete (`RECORD_PATH_KEY` → the core's
  explicit `previous_path`) and the attachment-dir cascade are the core's.
  `diffFrom` → the rename-aware core `diffRecords` for TOML (markdown keeps the
  git-porcelain tree diff, since the core's ref reads are TOML-only). Non-tx reads
  (config, `query`, `loadBody`, `getAttachment(s)`, index builds) resolve against
  the open-time snapshot ref via git porcelain + the core read fns
  (`recordQuery`/`recordQueryCandidates`). Symbol annotations, lazy-body, abort,
  in-memory indexes, the unique-index pre-check, and the markdown body-guard
  `TypeError` shim stay host-side.
- **Attachments:** `writeBlob` + `setAttachments`/`deleteAttachment(s)`/
  `getAttachment(s)` route through the core inside the transaction (atomic staging);
  the iterator's `mimeType`/`.read()`/`.stream()` sugar stays host-side over the
  core's `name → hash` map.
- **New napi method:** `CoreTransaction.writeFile(path, content)` — the generic
  tx file-write the CLI `init`/`infer`/`migrate-config` commands use to commit a
  sheet-config edit atomically (the old host engine used `tx.tree.writeChild`; the
  CoreTransaction surface had no equivalent).

**Enumerated re-baseline / behavior changes in Phase B (only these):**
(3) Datetime equality by value in query filters (`queryMatches` now compares
`Date` by `getTime()`, matching the core's filter). (1) Datetime field changes +
(2) int-vs-float distinctions now surface in TOML `diffFrom` patches, because the
diff is computed in the core from the canonical bytes (both are lost once a
record round-trips through a JS object). Strict JSON-Schema validation was already
restored in Phase A (not a change). Two stale white-box tests were updated for the
removed internal `tx.tree`/`markMutated` (→ `tx.writeFile` / observable
assertions), and one config-key test moved `markdownlint = false` →
`normalize = false` (the spec's post-Phase-A disable key,
`specs/behaviors/content-types.md`) — neither is a consumer-behavior change.

**`/audit-spec-drift`:** run via the `spec-drift-auditor` agent. Two
cutover-introduced items were **fixed** in this pass: (a) `Sheet.willChange` had
lost the unique-index conflict pre-check when `#prepareUpsert` was retired —
restored (willChange now runs the core `prepareUpsert` for the normalized
candidate + `#uniqueIndexPrecheck`, per `specs/api/sheet.md#willChange`; a
regression test was added); (b) the host format layer keyed body normalization
off the legacy `markdownlint` key while the core write path honors `normalize`
(`specs/behaviors/content-types.md`) — the host now keys off `FormatConfig.normalize`
(added), so CLI check/edit serialization agrees with what an upsert commits.
The stale `@iarna/toml` "v1.0 substrate note" in `specs/behaviors/normalization.md`
was refreshed (the canonical form is now in effect). The remaining audit findings
are **pre-existing** and out of this cutover's scope (tracked, not fixed): the
ignored `openRepo({ workTree })` option; the `api/transaction.md` ↔
`behaviors/transactions.md` concurrency-wording inconsistency (queue vs throw);
`validateTrailers` throwing `commit_failed` for a format error; `store.transact`
exposing non-validator sheets at runtime; `buildSorter` running raw-JS comparators
via `node:vm` rather than the core boa engine (deferred in `rust-core.md`); and
the now-internally-unused but still-exported `Template.queryTree` /
`PathTemplateTree` seam (left exported to keep the entry `.d.ts` stable).

**Benchmark (2000 records):** core-backed bulk upsert **586 ms** (0.29 ms/rec) vs
the pre-cutover holo-tree path **773 ms** (0.39 ms/rec) — ~24% faster; `queryAll`
**115 ms** vs **279 ms** — ~2.4× faster. (Config memoization over the Sheet's
immutable ref removed a per-upsert `git rev-parse`; without it the write path was
~20× slower.)

**Addon-packaging decision:** still deferred (documented follow-up). This pass
links the locally-built addon via the workspace; the per-platform prebuild + npm
distribution (mirroring holo-tree's `optionalDependencies` playbook) is a
release-track item.

## Follow-ups

- **Format-aware core ref-reads (drop the TOML-only limitation).** The core's
  ref-based read fns (`recordRead`/`recordList`/`recordQuery`/`diffRecords`) parse
  blobs as canonical TOML only. The Node binding works around this host-side:
  markdown non-tx `query` uses `recordQueryCandidates` (format-agnostic pruning) +
  `git cat-file` + the host markdown codec, and markdown `diffFrom` stays on the
  git-porcelain tree diff (so the datetime/int-float diff re-baseline applies to
  TOML sheets only). A `withBody`/format-aware variant of the ref-read fns in the
  core would let markdown reads take the single-FFI fast path and unify `diffFrom`.
- **`willChange` on a standalone sheet** opens a short-lived read-only
  `CoreTransaction` (acquires the per-repo writer slot, then discards). Cheap and
  correct in isolation, but it serializes against a concurrent `repo.transact` on
  the same repo. A non-mutating core "prepare against a ref" entry point would
  remove the slot dependency.
- **Host config read for tx-bound sheets** resolves `.gitsheets/<name>.toml` from
  the transaction *parent* commit (git), while the core reads it from the
  in-progress tree. They agree for every current flow (config is never written and
  read back for records in the same tx), but a napi "read config from the tx tree"
  accessor would close the gap.
- **Core validator strict-mode parity — DONE (not a follow-up).** ajv-strict
  unknown-keyword / `$data` rejection was added to the core
  (`gitsheets-core::validation` walks the schema and raises `config_invalid` on
  unknown Draft-07 keywords), so strict validation is at parity — see Notes #4.
  (Remaining follow-up: the known-keyword vocabulary is Draft-07; broaden if a
  later draft is adopted.)
- **Per-platform addon prebuild + npm publish** (release track): build the six
  napi triples, publish the addon, and consume it as a real dependency instead of
  the workspace-linked local `.node`.
