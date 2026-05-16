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

### CLI `--working` global flag — [#165](https://github.com/JarvusInnovations/gitsheets/issues/165)

- **What:** Read/write the working tree's state rather than HEAD.
- **Why deferred:** Substantive library work — `Repository` needs a parallel read/write path against on-disk files (no commit). Split out of #148 during v1.1; `--prefix` shipped, `--working` tracked separately.

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
