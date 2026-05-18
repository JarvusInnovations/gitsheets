# gitsheets

A git-backed document store for low-volume, high-touch, human-scale data.

Records are TOML files in a git repo, organized by a per-sheet path template. Every mutation is a commit — the commit log is the audit log. Schemas live alongside the data; validation runs on every write. Branches give you propose-review workflows for free. Content-typed sheets (markdown with TOML frontmatter) support documents-as-records workflows.

```bash
npm install gitsheets
```

ESM-only. Targets Node.js ≥ 20 and Bun ≥ 1. CLI installs as `gitsheets` and `git-sheet`.

## Quick taste

```typescript
import { openRepo } from 'gitsheets';

const repo = await openRepo();
const users = await repo.openSheet('users');

await repo.transact({ message: 'add jane' }, async (tx) => {
  await tx.sheet('users').upsert({
    slug: 'jane',
    email: 'jane@x.org',
    fullName: 'Jane Doe',
  });
});

const jane = await users.queryFirst({ slug: 'jane' });
```

Sheet config (`.gitsheets/users.toml`):

```toml
[gitsheet]
root = 'users'
path = '${{ slug }}'

[gitsheet.schema]
type = 'object'
required = ['slug', 'email']

[gitsheet.schema.properties.slug]
type = 'string'
pattern = '^[a-z0-9-]+$'

[gitsheet.schema.properties.email]
type = 'string'
format = 'email'
```

That lands on disk as `users/jane.toml` with deep-sorted keys for byte-stable diffs.

## What you get

- **Typed reads + writes.** `Sheet<T>` is generic; combine with [Standard Schema](https://standardschema.dev) validators (Zod, Valibot, ArkType, Effect Schema) via `openStore` for end-to-end TS types.
- **Transactions.** `repo.transact(opts, async tx => …)` bundles multi-sheet mutations into a single commit with author + structured trailers.
- **JSON Schema validation** layered with optional consumer Standard Schema validators. Both run on every write.
- **Canonical normalization** on write — deep-sorted keys, per-field array sort rules — so byte-equality means logical-equality and git diffs are meaningful.
- **Path templates** with `${{ field }}` and `${{ expression }}` syntax, recursive `${{ field/** }}`, multi-variable per-segment.
- **Content-typed sheets.** Opt into `[gitsheet.format] type = 'markdown'` for records as `.md` files with TOML frontmatter and a designated body field. Lazy body loading; markdownlint-normalized bodies.
- **Secondary indices.** `sheet.defineIndex(name, fn)` — in-memory, lazy, auto-rebuilt on tree-hash change.
- **Push daemon.** Optional library-side background task that pushes new commits with retry/backoff. Push-only (single-writer model).
- **Attachments.** Binary blobs colocated with records; first-class API; cascade-delete with the record.
- **CLI** (`gitsheets` / `git sheet`) for upsert / query / read / edit / check / normalize / init / infer / migrate-config.

## Companion: `gitsheets-axi`

For agent-driven shell invocation, see [`gitsheets-axi`](https://www.npmjs.com/package/gitsheets-axi) — same operations, agent ergonomics (TOON output, idempotent mutations, self-installing session hooks).

## Docs

- **[Quick start](https://jarvusinnovations.github.io/gitsheets/quick-start)** — install → declare a sheet → write a record → read it back
- **[Concepts](https://jarvusinnovations.github.io/gitsheets/concepts)** — Repository, Sheet, Path Template, Transaction, Store, Index, Push Daemon
- **[API reference](https://jarvusinnovations.github.io/gitsheets/api)** — public exports + pointers into per-symbol spec
- **[CLI reference](https://jarvusinnovations.github.io/gitsheets/cli)** — every command, every flag, exit codes
- **[Recipes](https://jarvusinnovations.github.io/gitsheets/)** — typed sheets with Zod, request-bound transactions, push-daemon setup, markdown CMS

[`specs/`](https://github.com/JarvusInnovations/gitsheets/tree/develop/specs) in the source repository is the authoritative API + behavior contract.

## License

Apache-2.0.
