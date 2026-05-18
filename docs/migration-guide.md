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

- **`Sheet.willChange(record, opts?)`** — new. Pre-flight idempotency check that runs upsert's full validation + normalization + serialization pipeline and compares the resulting bytes to the existing blob at the rendered path — without mutating the tree. Returns `{ changed, path, currentBlobHash?, nextText }`. Consumers that want commit-skipping semantics ("only commit if something actually changed") can pre-flight + skip when `changed: false`. Throws the same errors `upsert` would.
- **New utility exports**: `parseToml`, `parseConfigToml`, `stringifyRecord` (TOML round-tripping), `getFormat`, `hasFormat`, `registerFormat`, `resolveFormatConfig` (format dispatch). All were already in the package's internal modules; v1.3 surfaces them at the package root for consumers who need raw-bytes round-tripping or custom format registration.
- **New public type**: `WillChangeResult`.

### Tooling

- **`gitsheets-axi`** — new sibling npm package. Agent-facing CLI with TOON output, idempotent mutations, self-installing session hooks (Claude Code + Codex), format-aware default schemas. Lockstep-versioned with the library on minor. See [`docs/axi.md`](axi.md). Install with `npm install -g gitsheets-axi`.

### Repository layout (no consumer impact)

- The repository was promoted to an npm workspaces monorepo. The published `gitsheets` package now lives at `packages/gitsheets/`; the agent-facing companion at `packages/gitsheets-axi/`. Consumer code is unaffected — `import { ... } from 'gitsheets'` resolves the same surface as before, and the published tarball has the same shape.

### CLI

No new commands on the human `gitsheets` CLI in v1.3. The agent-facing operations (TOON output, idempotent mutations) live in `gitsheets-axi` rather than as flags on the human CLI — the two contracts disagree on too many defaults to coexist in one binary.

## Going forward

Once migrated, the recipes are the fastest path to common patterns:

- [Typed sheet with Zod](recipes/typed-sheet-with-zod.md)
- [Request-bound transactions in Fastify](recipes/request-bound-transactions.md)
- [Secondary indices](recipes/secondary-indices.md)
- [Production push daemon](recipes/production-push-daemon.md)

If you hit something the migration guide doesn't cover, open an issue — likely a missing migration note, possibly an actual gap.
