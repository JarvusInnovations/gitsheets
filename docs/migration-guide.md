# Migrating from pre-v1.0

If you've been running a pre-v1.0 internal install, here's what changes and how to update.

## What's removed entirely

- **The `GitSheets` class** (`backend/lib/GitSheets.js`) — early-prototype API. Replaced by `Repository` + `Sheet` + `Transaction`.
- **The HTTP server** (`backend/server.js`) — Koa-based REST surface. The library no longer ships an HTTP layer; build your own with Fastify / Koa / Express / Hono and call the JS API.
- **The Vue frontend** (`src/*` Vue, `tests/e2e` Cypress) — demo UI. If you need a UI, build it as a separate consumer.
- **CSV-ingest commands** (`backend/commands/singer-target.js`) — Singer target. Not in the v1.0 surface.
- **`deepmerge` for `--patch-existing`** — replaced by RFC 7396 JSON Merge Patch (`Sheet.patch(query, partial)`).

## What's reshaped

- **`gitsheets` is now a single npm package** at the repo root (was `backend/`).
- **TypeScript-first, ESM-only.** `"type": "module"`. Node ≥ 20 or Bun ≥ 1.
- **`[gitsheet.fields]` config** moves to `[gitsheet.schema]` (JSON Schema). The `sort` rules stay where they are. See the [migrating-config recipe](recipes/migrating-config.md).
- **Errors are typed classes.** No more string-matching on `err.message`. See [`api/errors.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/errors.md) for the hierarchy + stable codes.

## API translation table

| Pre-v1.0 | v1.0 |
| --- | --- |
| `new GitSheets({ gitDir })` | `await openRepo({ gitDir })` |
| `gitsheets.getSheet(name)` | `await repo.openSheet(name)` |
| `sheet.upsert(record)` | `sheet.upsert(record)` (same name, now goes through a transaction) |
| `sheet.delete(query)` | `sheet.delete(query)` (same name) |
| `sheet.query(filter)` | `sheet.query(filter)` async iterator (same name) |
| `sheet.commit(message)` | `repo.transact({ message }, async tx => { await tx.sheet(...).upsert(...) })` |
| `--patch-existing` (CLI, `deepmerge`) | `--patch` (CLI, RFC 7396 — semantic change: `null` deletes, arrays replace) |
| HTTP `POST /sheets/:name` | Your own HTTP layer + `sheet.upsert(...)` |

## Permissive vs strict mode

Pre-v1.0, every `upsert` mutated the working tree and required an explicit `commit()` to make changes durable. v1.0 inverts this:

- **Permissive default** — standalone `sheet.upsert(record)` auto-opens a transaction with an auto-generated commit message. Simple scripts just work.
- **Strict mode** — call `repo.requireExplicitTransactions()` to require every write to go through `repo.transact`. Useful when you want every commit to carry intentional metadata (author, message, trailers).

```typescript
// Permissive (default)
await sheet.upsert({ slug: 'jane', email: 'jane@x.org' });
// → commits with message "users upsert"

// Strict
repo.requireExplicitTransactions();
await sheet.upsert({ slug: 'jane', email: 'jane@x.org' });
// ✗ throws TransactionError('transaction_required')

await repo.transact({ message: 'add jane' }, async (tx) => {
  await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
});
// ✓
```

For production / request-bound flows, prefer strict mode + explicit `repo.transact` — see the [request-bound transactions recipe](recipes/request-bound-transactions.md).

## A worked translation

### Pre-v1.0

```javascript
const { GitSheets } = require('gitsheets');

const gs = new GitSheets({ gitDir: '/data/.git' });
await gs.init();

const users = await gs.getSheet('users');

await users.upsert({ slug: 'jane', email: 'jane@x.org' });
await users.upsert({ slug: 'bob', email: 'bob@x.org' });
await users.commit('add users');

const found = await users.queryFirst({ slug: 'jane' });
```

### v1.0

```typescript
import { openRepo } from 'gitsheets';

const repo = await openRepo({ gitDir: '/data/.git' });
const users = await repo.openSheet('users');

await repo.transact(
  { message: 'add users' },
  async (tx) => {
    const s = tx.sheet('users');
    await s.upsert({ slug: 'jane', email: 'jane@x.org' });
    await s.upsert({ slug: 'bob', email: 'bob@x.org' });
  },
);

const found = await users.queryFirst({ slug: 'jane' });
```

Differences:

- ESM `import` instead of CommonJS `require`
- `openRepo` (factory) instead of `new GitSheets()` + `await gs.init()`
- `openSheet` instead of `getSheet` (factory consistency)
- Bundle multiple upserts into one transaction with `repo.transact` — same shape, atomic, one commit
- `queryFirst` is unchanged

## Validation reshape

If you had `[gitsheet.fields]` configs, see the [migrating-config recipe](recipes/migrating-config.md) for the field-by-field migration. The short story:

- `type` / `enum` / `default` move to `[gitsheet.schema.properties.<name>]`
- `sort` stays at `[gitsheet.fields.<name>.sort]` (different concept — canonical normalization)
- `trueValues` / `falseValues` move to your CSV ingest code (no longer a sheet-config concern)

## Error handling

Pre-v1.0 you might have done:

```javascript
try {
  await users.upsert(record);
} catch (err) {
  if (err.message.startsWith('invalid tree ref')) { /* ... */ }
}
```

v1.0:

```typescript
import { GitsheetsError, ValidationError, RefError } from 'gitsheets';

try {
  await users.upsert(record);
} catch (err) {
  if (err instanceof ValidationError) {
    // err.issues — structured ValidationIssue[]
  } else if (err instanceof RefError) {
    // err.code === 'ref_not_found' | 'not_an_ancestor'
  } else if (err instanceof GitsheetsError) {
    // err.code — stable string
    // err.status — HTTP status hint
  } else {
    throw err;
  }
}
```

Every gitsheets error extends `GitsheetsError` and carries a stable `code`. See [`specs/api/errors.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/errors.md) for the full hierarchy + code table.

## CLI changes

- `git sheet upsert` / `query` / `read` / `normalize` — same command shape, rebuilt against the new core
- `git sheet edit <sheet> <path>` — new in v1.1: `$EDITOR`-based round-trip on a record
- `git sheet init <sheet>` — new in v1.1: scaffold a starter `.gitsheets/<sheet>.toml`
- `git sheet infer <sheet>` / `migrate-config <sheet>` — new in v1.1: schema inference and pre-v1.0 fields-config migration
- `--patch-existing` → `--patch` (RFC 7396 semantics: `null` deletes, arrays replace)
- `--format` (`json|toml|csv` upsert; `json|csv|tsv|toml` query/read), `--encoding`, `--delete-missing`, `--attachment <name>=<source>` — all shipped in v1.1
- `--prefix` (`GITSHEETS_PREFIX`) for multi-tenant sub-tree scoping
- New global flags: `--message`, `--author-name`, `--author-email`, `--trailer Key=Value`, `--ref`, `--commit-to`
- Exit codes are stable from v1.0 onward — see [CLI reference](cli.md#exit-codes)
- `--working` (read/write the working tree state) remains deferred — tracked at [#165](https://github.com/JarvusInnovations/gitsheets/issues/165)

## v1.1 → v1.2

Fully additive minor release. Existing v1.1 code keeps working.

### Library

- **Content-typed records.** A sheet can opt into `[gitsheet.format] type = 'markdown'` (or `'mdx'`) to store records as `.md` files with TOML frontmatter and a designated body field. Bodies are normalized through `markdownlint --fix` on write; the frontmatter stays canonical TOML. Default remains TOML — existing sheets are unchanged. See [`behaviors/content-types.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/content-types.md) and the [Markdown CMS recipe](recipes/markdown-cms.md).
- **Lazy body loading.** `Sheet.query` / `queryFirst` / `queryAll` accept `opts.withBody` (default `true`). Setting `withBody: false` on a markdown sheet skips body bytes entirely — useful for listing pages and bulk metadata reads. Hydrate on demand with `await sheet.loadBody(record)`. Index builds always use body-less reads (don't index on body content). No effect on TOML sheets.
- **`Sheet.upsert(record, opts?)`.** Adds `opts.allowMissingBody` for content-typed sheets — explicit opt-in to upsert a record without a body field. Default behavior throws if the body field is missing, so a body-less upsert can't silently erase on-disk content. `Sheet.patch` handles `{ body: null }` deletions transparently (it passes `allowMissingBody: true` to the internal upsert).
- **New public types**: `Format`, `FormatConfig`, `UpsertOptions`.

### CLI

- **`gitsheets check <sheet> <file> [--fix]`** — new. Verify a record file in the working tree is parseable, schema-valid, and canonical. With `--fix`, rewrite to canonical. Never commits. Designed for post-edit hooks (`--fix`) and CI pre-commit verification (no `--fix`). Exit codes: 0 ok, 1 not-canonical (no `--fix`), 22 ValidationError, 64 ConfigError.
- **`gitsheets query --no-body`** — new flag. For content-typed sheets, suppresses the body field in output. No effect on TOML sheets.

### Tooling

- **`skills/gitsheets/`** — bundled Claude Code skill for developers consuming gitsheets. Reference material covering the CLI, the TypeScript API, and the sheet config syntax. Install it in your `.claude/skills/` (or via plugin) to give Claude focused gitsheets context.

## v1.2 → v1.3

Fully additive minor release. Existing v1.2 code keeps working.

### Library

- **`Sheet.willChange(record, opts?)`** — new in v1.3.0. Pre-flight idempotency check that runs upsert's full validation + normalization + serialization pipeline and compares the resulting bytes to the existing blob at the rendered path — without mutating the tree. Returns `{ changed, path, currentBlobHash?, nextText }`. Consumers that want commit-skipping semantics ("only commit if something actually changed") can pre-flight + skip when `changed: false`. Throws the same errors `upsert` would.
- **Title from body's H1.** Content-typed sheets can opt into `[gitsheet.format].title = '<field>'` to denormalize the body's first H1 into a frontmatter field. The library enforces `record.title === <body's first H1, or undefined>` on every write — `upsert` with disagreeing values throws `ValidationError`; `Sheet.patch({title: 'X'})` rewrites the body's H1 for you, `Sheet.patch({body: '# Y\n…'})` re-derives the title. Markdownlint's `MD041` auto-enables to fail loud on bodies that start with prose. Fully backward-compatible — sheets without `[gitsheet.format].title` behave exactly as v1.2. See [`behaviors/content-types.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/content-types.md#title-from-h1) and the [Markdown CMS recipe](recipes/markdown-cms.md#title-from-bodys-h1-recommended).
- **New utility exports**: `parseToml`, `parseConfigToml`, `stringifyRecord` (TOML round-tripping), `getFormat`, `hasFormat`, `registerFormat`, `resolveFormatConfig` (format dispatch). All were already in the package's internal modules; v1.3 surfaces them at the package root for consumers who need raw-bytes round-tripping or custom format registration.
- **New public type**: `WillChangeResult`.

### Tooling

- **`gitsheets-axi`** — new sibling npm package. Agent-facing CLI with TOON output, idempotent mutations, self-installing session hooks (Claude Code + Codex), format-aware default schemas. Lockstep-versioned with the library on minor. See [`docs/axi.md`](axi.md). Install with `npm install -g gitsheets-axi`.

### Repository layout (no consumer impact)

- The repository was promoted to an npm workspaces monorepo. The published `gitsheets` package now lives at `packages/gitsheets/`; the agent-facing companion at `packages/gitsheets-axi/`. Consumer code is unaffected — `import { ... } from 'gitsheets'` resolves the same surface as before, and the published tarball has the same shape.

### CLI

No new commands on the human `gitsheets` CLI in v1.3. The agent-facing operations (TOON output, idempotent mutations) live in `gitsheets-axi` rather than as flags on the human CLI — the two contracts disagree on too many defaults to coexist in one binary.

## v1.3.0 → v1.3.1

Patch release. Two fixes in service of snapshot-importer-style workflows.

### Library

- **`Sheet.clear()` is now O(1).** Previously walked the sheet's subtree and called `deleteChild` for every entry — fine at sheet sizes of a few hundred records, problematic at tens of thousands. The new implementation uses hologit's `TreeObject.clearChildren()` (added in hologit 0.50.2) to point the subtree at git's empty-tree hash in constant time. Same observable behavior; existing code unchanged.
- **No-op transactions no longer produce empty commits.** `Transaction#finalize` now compares the resulting tree-hash to the parent commit's tree-hash; equality means the staged state matches the parent and no commit is created. Concretely, **every "clear + re-upsert from snapshot" pattern against unchanged upstream data is now a clean no-op** (`commitHash === null`). Same goes for `upsert(record)` where the record's canonical bytes match what's on disk, and `delete` + re-`upsert` of an identical record.

  **Subtle behavior change:** an explicit `tx.markMutated()` call that isn't paired with a real tree mutation no longer produces a commit. Internal callers (upsert/delete/setAttachments/etc.) always pair `markMutated` with an actual mutation, so this shouldn't affect any real consumer. Consumers who genuinely want empty commits should use `git commit --allow-empty` outside the library.

### Dependency

- `hologit` bumped from `^0.49.1` to `^0.50.2` to pick up `TreeObject.clearChildren()` (the O(1) primitive backing the new `Sheet#clear()`).

## v1.x → v2.0 (the Rust core)

v2.0 replaces the Node.js engine with the Rust `gitsheets-core` crate: TOML
parse/serialize, normalization, validation, path templates, record CRUD, and
the tree/blob/commit substrate all run natively, and the npm package becomes a
thin marshalling shell over the `@gitsheets/core-napi` addon. The API surface
is intentionally unchanged — but three behavior changes bite real consumers.
All three surfaced during the first production 1.4.1 → 2.x upgrade; this
section is what turns "16 mystery test failures" into "read the section, apply
3 changes."

### 1. The `hologit` dependency is gone

2.x drops `hologit` entirely (tree/blob/commit ops run on `holo-tree`/gitoxide
*inside* the core). Anything that reached into it breaks:

- `repo.hologitRepo` no longer exists.
- `BlobObject` (e.g. `BlobObject.write`) is no longer importable via gitsheets.

The replacement for the common pattern — hashing binary content and attaching
it to a record — is the built-in blob primitive plus the attachment API:

```typescript
// 1.x
import { BlobObject } from 'hologit';

const blob = await BlobObject.write(repo.hologitRepo, buffer);
await sheet.setAttachments(record, { 'avatar.jpg': blob });
```

```typescript
// 2.x
const blob = await repo.writeBlob(buffer); // Promise<BlobHandle>
await sheet.setAttachments(record, { 'avatar.jpg': blob });
```

`repo.writeBlob(buf)` hashes the bytes into the object database and returns a
`BlobHandle` accepted everywhere a hologit `BlobObject` used to be
(`setAttachment`, `setAttachments`). `getAttachment`/`getAttachments`/
`sheet.attachments()` likewise return `BlobHandle`s with `.read()`/`.stream()`.

### 2. `null`/`undefined`-valued fields

TOML has no `null`, so a cleared optional field and a never-set field are the
same on-disk state: an absent key. 1.x (`@iarna/toml`) enforced this by
silently dropping null-valued keys at serialize time. **The initial 2.x
releases instead threw on marshal** (`cannot marshal JS value of type
Null/Undefined to a TOML value`) — breaking the standard consumer pattern of
`.nullable().optional()` schemas with `?? null` normalization on write.

**Fixed in this release**: the 1.x drop semantics are restored and now
specced ([`specs/behaviors/normalization.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/normalization.md#null--undefined-handling)).
A `null`/`undefined`-valued key is dropped, recursively (top-level fields,
nested tables, and objects inside arrays), before validation and
serialization — byte-identical to 1.x output, in every binding (Node and
Python). If you shimmed this with a `stripNullish` helper at your write
boundary, you can delete it.

One deliberate edge-case divergence from 1.x: a `null`/`undefined` **array
element** is an error naming the index (1.x silently dropped elements —
`[1, null, 2]` → `[1, 2]` — which shifts sibling indices and silently changes
data). Remove the element yourself if that's what you mean. A required field
set to `null` fails JSON-Schema validation as *missing*, same as 1.x.

### 3. Canonical bytes re-baseline (one-time)

The canonical serializer is now the core's `gitsheets-core::canonical` (the
Rust `toml` crate's formatting over a deep key sort), replacing `@iarna/toml`.
A record that was already canonical under 1.x may re-serialize to different —
but *value-identical* — bytes, once ([#196](https://github.com/JarvusInnovations/gitsheets/issues/196)).
Three reformat classes, all proven data-lossless and idempotent over a
~29.5k-record corpus ([PR #205](https://github.com/JarvusInnovations/gitsheets/pull/205)):

1. **Integer digit-group underscores drop** — `legacyId = 31_618` →
   `legacyId = 31618` (the dominant class).
2. **String requote** — strings containing both `"` and `'` move from escaped
   single-line form to readable triple-quoted `"""…"""` form.
3. **Multiline trailing-quote layout** — a multiline string ending in `"`
   loses `@iarna`'s line-continuation dance (same value, fewer lines).

Until you re-baseline, the first 2.x write of a record whose 1.x bytes fall in
one of these classes shows a spurious-looking (but value-neutral) diff. The
recommended migration is a **one-time re-serialize commit** over each existing
repo, which is idempotent (a second run produces zero diff — that's the
adoption check):

```bash
# Re-normalize every *.toml record under a directory, in place.
cargo run -p gitsheets-core --example normalize_tree -- path/to/records

git add path/to/records
git commit -m "chore: re-baseline records to the Rust canonical form"

# Verify idempotence — a second pass must report 0 files re-normalized:
cargo run -p gitsheets-core --example normalize_tree -- path/to/records
```

(Or use `git sheet normalize <sheet>` per sheet from the CLI.) See the
[canonical-form re-baseline notes](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/normalization.md#canonical-form-re-baseline-the-rust-serializer)
for the full contract.

## Going forward

Once migrated, the recipes are the fastest path to common patterns:

- [Typed sheet with Zod](recipes/typed-sheet-with-zod.md)
- [Request-bound transactions in Fastify](recipes/request-bound-transactions.md)
- [Secondary indices](recipes/secondary-indices.md)
- [Production push daemon](recipes/production-push-daemon.md)

If you hit something the migration guide doesn't cover, open an issue — likely a missing migration note, possibly an actual gap.
