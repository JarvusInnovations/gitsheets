# Deferred Features

Features intentionally **not in scope for v1.0**. Listed here so the omission is documented, not accidental.

When an item is promoted, move it from this file into the relevant active spec and update the [GitHub issue](https://github.com/JarvusInnovations/gitsheets/issues) that tracks it.

## Deferred to v1.1

### Holo-tree migration (Rust substrate)

- **What:** Swap the current hologit JS dependency for a Rust `holo-tree` crate via `napi-rs`. ~100x faster tree operations on the hot path.
- **Why deferred:** Public API rewrite (v1.0) and internal engine swap (v1.1) are two distinct changes. Coupling them would balloon the v1.0 review surface and delay consumer feedback.
- **Tracking:** [#127](https://github.com/JarvusInnovations/gitsheets/issues/127)
- **Constraint:** Must not change the public API. Consumers see no difference, only performance.

## Deferred (no scheduled release)

### Watch mode

- **What:** `repo.watch(callback)` API that emits events when the data tree changes externally (working-tree edits, ref updates from another process), letting consumers invalidate caches/indices live.
- **Why deferred:** Gitsheets typically operates against refs, not the working tree. The use case is real for dev/seeding workflows but not load-bearing for production consumers.
- **Tracking:** [#135](https://github.com/JarvusInnovations/gitsheets/issues/135)

### Attachments iterator API

- **What:** `for await (const { name, mimeType, blob } of sheet.attachments(record))` — a higher-level iterator over a record's attachments, replacing the current low-level `blobMap` surface.
- **Why deferred:** The current `getAttachments` / `getAttachment` / `setAttachment` API works; iterator is sugar. Nice ergonomics, not 1.0-critical.
- **Tracking:** [#140](https://github.com/JarvusInnovations/gitsheets/issues/140)

### `git sheet init` scaffold command

- **What:** A CLI command that writes a starter `.gitsheets/<name>.toml` from a JSON Schema file, from sample records, or from minimal flags.
- **Why deferred:** Consumers can hand-author the TOML. Real ergonomics win but not on the 1.0 critical path.
- **Tracking:** [#139](https://github.com/JarvusInnovations/gitsheets/issues/139)

### YAML format support (input + output)

- **What:** Accept and emit YAML in CLI ingest / export, alongside the existing JSON / TOML / CSV.
- **Why deferred:** Long-standing backlog request with no concrete current consumer.
- **Tracking:** [#61](https://github.com/JarvusInnovations/gitsheets/issues/61)

### Persisted indexes

- **What:** Allow secondary indices (currently in-memory only) to materialize to disk under a `.gitsheets/.indexes/` tree, so consumers don't pay rebuild cost across restarts.
- **Why deferred:** At v1.0 corpus sizes, lazy rebuild is fast enough. If a consumer's corpus grows past the threshold where rebuild matters, this becomes a real concern.

### Richer query operators

- **What:** `$in`, `$or`, `$gt`-style operators on `Sheet.query`.
- **Why deferred:** Consumers can iterate `queryAll(...)` and `.filter(...)` in their own code. The whole-repo-fits-in-memory premise makes the operator richness less load-bearing.

### Persisted in-memory cache layer

- **What:** A library-managed cache around parsed records, surviving across requests in a long-running consumer.
- **Why deferred:** Once #138 (blob-hash record cache fix) lands, the existing per-sheet-instance cache covers most needs. A richer multi-instance cache can come if a consumer shows it's needed.

### `Sheet.diffFrom` — diff against a prior commit

- **What:** `async *sheet.diffFrom(srcCommitHash?, { blobs?, records?, patches? })` yielding `{ path, status, src, dst, patch }` changes scoped to the sheet's root. Was used pre-v1.0 by the propose-review UI.
- **Why deferred:** Internally relies on shelling out to `git diff-tree`; the surface is useful but isn't on the v1.0 critical path. Documented in `api/sheet.md` as still part of the spec, but not implemented in the v1.0 substrate.
- **Tracking:** to be filed as a follow-up to #128.

### `Sheet.deleteAttachment(s)`

- **What:** Explicit delete methods for individual attachments and full attachment sets.
- **Why deferred:** `Sheet.delete(record)` cascades and deletes the attachment directory as a whole; per-file attachment removal can be done by re-writing the surviving attachments via `setAttachments`. A dedicated method is ergonomic but not blocking. `api/sheet.md` mentions both; this entry tracks the explicit implementation.

### CLI `--format`, `--encoding`, `--delete-missing`, `--attachments`, `--prefix`, `--working`

- **What:** Per `api/cli.md`, `upsert` accepts `--format json|toml|csv`, `--encoding`, `--delete-missing`, `--attachments.<path>=<spec>`; `query` accepts richer output formats; globally `--prefix` and `--working`.
- **Why deferred:** v1.0 substrate CLI ships JSON in / newline-JSON out — enough to exercise the surface and prove integration. The fuller CLI surface comes in a follow-up CLI PR (one-off file format support is mostly orthogonal to the library).

### CLI `git sheet edit`, `infer`, `migrate-config`

- **What:** Three additional CLI commands documented in `api/cli.md`.
- **Why deferred:** `edit` needs `$EDITOR` integration; `infer` and `migrate-config` are validation-config tooling that supplements #130. Library equivalents exist; CLI surface follows.
- **Tracking:** part of #130 follow-up + a future scoped issue for `edit`.

### `Sheet.query(opts.signal)` (AbortSignal)

- **What:** Cancel a streaming query via AbortSignal.
- **Why deferred:** Async generators naturally support `break`; the AbortSignal pattern is sugar for upstream HTTP integrations. Documented in `api/conventions.md`; not implemented in the v1.0 surface.

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
