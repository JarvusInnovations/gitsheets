# Deferred Features

Features intentionally **not in scope for v1.0**. Listed here so the omission is documented, not accidental.

## Maintenance

Every deferred item that's a viable future feature links to a tracking GitHub issue. The workflow is:

1. **When you ship a deferred item**, remove its entry from this file in the same PR that closes the issue. The spec file(s) for that feature become the source of truth — `deferred.md` only lists what's *currently* deferred.
2. **When you newly defer something during ongoing work**, add an entry here AND file an issue, then link them both ways.
3. **Speculative items** (no concrete consumer demand, no scheduled work) don't need an issue. The entry stays here until either a consumer surfaces a need (→ file an issue) or the feature is judged out-of-scope-forever (→ move to the "Dropped" section).

When in doubt about whether an entry belongs in `deferred.md`, the litmus test is: "if someone reads the spec for X and notices it's missing from the code, will this file explain why?"

## Deferred to v1.1

### Holo-tree migration (Rust substrate) — [#127](https://github.com/JarvusInnovations/gitsheets/issues/127)

- **What:** Swap the current hologit JS dependency for a Rust `holo-tree` crate via `napi-rs`. ~100x faster tree operations on the hot path.
- **Why deferred:** Public API rewrite (v1.0) and internal engine swap (v1.1) are two distinct changes. Coupling them would balloon the v1.0 review surface and delay consumer feedback.
- **Constraint:** Must not change the public API. Consumers see no difference, only performance.

## Deferred (no scheduled release)

### Watch mode — [#135](https://github.com/JarvusInnovations/gitsheets/issues/135)

- **What:** `repo.watch(callback)` API that emits events when the data tree changes externally (working-tree edits, ref updates from another process), letting consumers invalidate caches/indices live.
- **Why deferred:** Gitsheets typically operates against refs, not the working tree. The use case is real for dev/seeding workflows but not load-bearing for production consumers.

### Attachments iterator API — [#140](https://github.com/JarvusInnovations/gitsheets/issues/140)

- **What:** `for await (const { name, mimeType, blob } of sheet.attachments(record))` — a higher-level iterator over a record's attachments, replacing the current low-level `blobMap` surface.
- **Why deferred:** The current `getAttachments` / `getAttachment` / `setAttachment` API works; iterator is sugar. Nice ergonomics, not 1.0-critical.

### `git sheet init` scaffold command — [#139](https://github.com/JarvusInnovations/gitsheets/issues/139)

- **What:** A CLI command that writes a starter `.gitsheets/<name>.toml` from a JSON Schema file, from sample records, or from minimal flags.
- **Why deferred:** Consumers can hand-author the TOML. Real ergonomics win but not on the 1.0 critical path.

### YAML format support (input + output) — [#61](https://github.com/JarvusInnovations/gitsheets/issues/61)

- **What:** Accept and emit YAML in CLI ingest / export, alongside the existing JSON / TOML / CSV.
- **Why deferred:** Long-standing backlog request with no concrete current consumer.

### Content-typed records: markdown bodies with TOML frontmatter — [#158](https://github.com/JarvusInnovations/gitsheets/issues/158)

- **What:** Sheet-level `[gitsheet.format] type='markdown'` option that stores records as `.md` files with TOML frontmatter (`+++` delimited) and a designated body field, with optional markdownlint normalization of the body. Pluggable format discriminator leaves room for MDX (free alias) and future formats.
- **Why deferred:** Additive 1.x feature, opt-in per sheet, fully backward-compatible with TOML records. Not on the v1.0 critical path; landed as a tracked feature idea from a PR #144 design discussion.

### Persisted indexes

- **What:** Allow secondary indices (currently in-memory only) to materialize to disk under a `.gitsheets/.indexes/` tree, so consumers don't pay rebuild cost across restarts.
- **Why deferred:** At v1.0 corpus sizes, lazy rebuild is fast enough. If a consumer's corpus grows past the threshold where rebuild matters, this becomes a real concern.

### Richer query operators

- **What:** `$in`, `$or`, `$gt`-style operators on `Sheet.query`.
- **Why deferred:** Consumers can iterate `queryAll(...)` and `.filter(...)` in their own code. The whole-repo-fits-in-memory premise makes the operator richness less load-bearing.

### Persisted in-memory cache layer

- **What:** A library-managed cache around parsed records, surviving across requests in a long-running consumer.
- **Why deferred:** Once #138 (blob-hash record cache fix) lands, the existing per-sheet-instance cache covers most needs. A richer multi-instance cache can come if a consumer shows it's needed.

### `Sheet.diffFrom` — diff against a prior commit — [#152](https://github.com/JarvusInnovations/gitsheets/issues/152)

- **What:** `async *sheet.diffFrom(srcCommitHash?, { blobs?, records?, patches? })` yielding `{ path, status, src, dst, patch }` changes scoped to the sheet's root. Was used pre-v1.0 by the propose-review UI.
- **Why deferred:** Internally relies on shelling out to `git diff-tree`; the surface is useful but isn't on the v1.0 critical path. Documented in `api/sheet.md` as still part of the spec, but not implemented in the v1.0 substrate.

### `Sheet.deleteAttachment(s)` — [#153](https://github.com/JarvusInnovations/gitsheets/issues/153)

- **What:** Explicit delete methods for individual attachments and full attachment sets.
- **Why deferred:** `Sheet.delete(record)` cascades and deletes the attachment directory as a whole; per-file attachment removal can be done by re-writing the surviving attachments via `setAttachments`. A dedicated method is ergonomic but not blocking. `api/sheet.md` mentions both; this entry tracks the explicit implementation.

### CLI `--format` and `--encoding` for upsert/query — [#145](https://github.com/JarvusInnovations/gitsheets/issues/145)

- **What:** `upsert` accepts `--format json|toml|csv` and `--encoding <enc>`; `query` accepts `--format json|csv|tsv|toml` plus `--headers`.
- **Why deferred:** v1.0 substrate CLI ships JSON-in / newline-JSON-out — enough to exercise the surface and prove integration. CSV/TOML in/out support is a separable CLI PR.

### CLI `gitsheets upsert --delete-missing` — [#146](https://github.com/JarvusInnovations/gitsheets/issues/146)

- **What:** Full-replace upsert mode — records in the sheet but not in the input are deleted in the same transaction.
- **Why deferred:** Destructive convenience flag; v1.0 ships additive-only to keep the surface narrow.

### CLI `gitsheets upsert --attachments` — [#147](https://github.com/JarvusInnovations/gitsheets/issues/147)

- **What:** `--attachments.<name>=<source-path>` flags to attach files alongside the record in the same transaction.
- **Why deferred:** Library substrate exists (`Sheet.setAttachment`); CLI wiring is purely arg-parsing.

### CLI `--prefix` and `--working` global flags — [#148](https://github.com/JarvusInnovations/gitsheets/issues/148)

- **What:** `--prefix` (sub-prefix under the data root) and `--working` (read/write the working tree rather than HEAD).
- **Why deferred:** Both need library plumbing too — `--prefix` would thread through `Repository.openSheet`, and `--working` would need `Repository` to resolve the working tree's state.

### CLI `gitsheets upsert --patch` — [#149](https://github.com/JarvusInnovations/gitsheets/issues/149)

- **What:** A `--patch` flag on `upsert` to apply RFC 7396 merge-patch semantics to existing records, sugar over `Sheet.patch`.
- **Why deferred:** The CLI ergonomics need design — how the input record splits between "query that selects the existing record" and "partial that gets merged" isn't obvious from a single JSON document. A v0 implementation that passed the input as both query and patch was a no-op and got removed. The library API `Sheet.patch(query, partial)` is the correct surface for now.

### CLI `gitsheets edit` — open record in $EDITOR — [#150](https://github.com/JarvusInnovations/gitsheets/issues/150)

- **What:** Open a record in `$EDITOR`, save, validate, upsert.
- **Why deferred:** Needs `$EDITOR` spawn + tmpfile dance; orthogonal to the substrate.

### CLI `gitsheets infer` + `migrate-config` — [#151](https://github.com/JarvusInnovations/gitsheets/issues/151)

- **What:** `infer` generates a starter `[gitsheet.schema]` from existing records; `migrate-config` converts pre-v1.0 `[gitsheet.fields]` configs.
- **Why deferred:** Validation-config tooling that supplements #130's library work. Library APIs exist; CLI surface follows.

## Dropped (no plan)

### `backend/server.js` HTTP server

- **What:** The pre-v1.0 Koa server that exposed gitsheets over HTTP.
- **Why dropped:** Consumers building HTTP APIs around gitsheets build their own HTTP layer. The library doesn't ship one.

### Vue frontend

- **What:** The pre-v1.0 single-page app at `src/` that demonstrated upload/diff/commit workflows.
- **Why dropped:** Demo-grade UI tied to the dropped HTTP server. If a UI is wanted, it's a separate project on top of the library.

### Legacy `GitSheets` class

- **What:** `backend/lib/GitSheets.js` — the pre-v1.0 single-class API with ref-oriented mutation and stream-based CSV import/export.
- **Why dropped:** Early-prototype API with no current users. The modern `Sheet` / `Repository` / `Transaction` model supersedes it.

### JSON:API surface

- **What:** A built-in JSON:API-compliant HTTP layer.
- **Why dropped:** JSON:API didn't take over, the library doesn't ship an HTTP layer anyway, and consumer-side framing is more flexible.

### Multi-package monorepo (`@gitsheets/core` + `@gitsheets/cli`)

- **What:** Split the npm package into separately-versioned core + CLI packages.
- **Why dropped:** Single-package shipping is simpler. Splitting is reversible later if a consumer wants the core without the CLI dependency surface.

## Out of scope (different responsibility)

These belong to consumers, not to gitsheets:

- **Authentication / authorization** — handled in consumer code or upstream
- **HTTP layer / request handling** — Fastify, Koa, Express, Hono, etc. — consumer's choice
- **Search index** — SQLite FTS, Meilisearch, etc. built on top
- **Migration framework** — schema migrations are one-shot scripts that commit to the data repo
- **Auth for the push daemon's git remote** — handled by the environment (SSH config, credential helper, GitHub App)
