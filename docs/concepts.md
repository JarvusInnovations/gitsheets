# Concepts

The vocabulary every consumer needs. Read this before the API reference or recipes.

## Repository

A git repository that contains gitsheets-managed data. Opened with `openRepo({ gitDir? })`. The library reads and writes git objects through the underlying `git` CLI (via hologit).

A repository can contain ordinary code, docs, or anything else — gitsheets only cares about paths under `.gitsheets/` (sheet configs) and the data paths each sheet declares.

```typescript
import { openRepo } from 'gitsheets';

const repo = await openRepo();                            // discovered from cwd
const repo = await openRepo({ gitDir: '/path/to/.git' }); // explicit
```

Fresh repositories (no commits yet) are supported.

## Sheet

A typed collection of records, declared by a TOML file at `.gitsheets/<name>.toml`. Each sheet has:

- A **name** — the basename of its config file
- A **root path** — directory under which the sheet's records live (default: `.`)
- A **path template** — how a record maps to a file path
- An optional **JSON Schema** — the persisted shape contract
- Optional **canonical normalization rules** for array-field sorting

A repository may declare many sheets. They share the repo but are otherwise independent.

```toml
# .gitsheets/users.toml
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

## Record

A single TOML document stored under the sheet's root, at the path rendered from the sheet's path template against the record's fields.

Records are validated on every write — first against the persisted JSON Schema, then against any consumer-supplied Standard Schema validator.

Records carry implicit annotations gitsheets attaches at read time (sheet name, source path) — accessed via well-known Symbols (`RECORD_SHEET_KEY`, `RECORD_PATH_KEY`) so they don't collide with the record's own fields.

## Path Template

A small DSL for "where does this record live in the tree, and how do queries prune the search."

```text
${{ field }}                # bare field reference
${{ expression }}           # JS expression evaluated against the record
${{ field/** }}             # recursive field — value may contain `/`
literal-text-${{ field }}   # literal text attached to an expression
${{ a }}/${{ b }}           # path segments separated by `/`
```

Path templates serve two roles:

1. **Where to write** — gitsheets renders the template against a record to determine its file path.
2. **How to query efficiently** — when a query includes the path template's fields, gitsheets walks only matching subtrees instead of every record.

See [path templates](path-templates.md) for full syntax and the query pruning algorithm.

## Transaction

A scope that bundles one or more sheet mutations into a single commit. Opens against a parent ref, runs a handler that performs mutations, commits on success (no commit on throw).

A transaction carries an **author**, **committer**, **commit message**, and **trailers** (git-style key/value metadata).

```typescript
const result = await repo.transact(
  {
    parent: 'main',                    // ref name or commit hash; default: HEAD
    author: { name, email },           // default: git config
    message: 'janedoe: POST /api/users',
    trailers: { Action: 'user.create', 'Subject-Slug': 'janedoe' },
  },
  async (tx) => {
    await tx.sheet('users').upsert({ slug: 'janedoe', email: 'jane@x.org' });
    await tx.sheet('audits').upsert({ action: 'user.create', subject: 'janedoe' });
    return { ok: true };
  },
);
// result: { value, commitHash, treeHash, ref, parentCommitHash }
```

**Mutations outside a transaction** (permissive mode, the default) implicitly open and commit a single-mutation transaction with an auto-generated message. The transaction model is the same either way; only the explicit-vs-implicit framing differs.

**Strict mode** (`repo.requireExplicitTransactions()`) flips the default: standalone `Sheet.upsert` / `delete` / `patch` throws `TransactionError('transaction_required')`. Useful when you want every write to carry intentional metadata.

## Store

A top-level typed wrapper that auto-discovers sheets and binds them to consumer-supplied [Standard Schema](https://standardschema.dev) validators (Zod, Valibot, ArkType, Effect Schema, ...).

```typescript
import { openRepo, openStore } from 'gitsheets';
import { z } from 'zod';

const UserSchema = z.object({
  slug: z.string(),
  email: z.string().email(),
  fullName: z.string().optional(),
});

const repo = await openRepo();
const store = await openStore(repo, {
  validators: { users: UserSchema },
});

// fully typed against z.infer<typeof UserSchema>
const jane = await store.users.queryFirst({ slug: 'janedoe' });
// jane is User | undefined

await store.transact({ message: '...' }, async (tx) => {
  await tx.users.upsert({ slug: 'jane', email: 'jane@x.org' });
});
```

`Store` is sugar around `Repository.openSheets()` + `Repository.transact()` with TypeScript-level sheet-name + record-shape inference. Sheets not in the `validators` map are accessible via `repo.openSheet(name)` — they fall outside the typed `Store` surface.

## Index

An in-memory secondary index on a sheet, keyed by a function the consumer supplies. Lazy by default (built on first lookup), with an eager opt-in.

```typescript
sheet.defineIndex('byEmail', { unique: true }, (record) => record.email.toLowerCase());

const jane = await sheet.findByIndex('byEmail', 'jane@example.com');
```

Indices are **not persisted** — they live in process memory, invalidate on `upsert` / `delete` (same instance) or on out-of-band ref movement, and rebuild on demand.

Use indices for "find by email" / "find all memberships for this person" — access paths the path template can't serve in the dominant direction.

## Push Daemon

An optional, library-side background task that pushes new commits to a configured git remote with retry and exponential backoff. **Push-only — never pulls.**

```typescript
const daemon = await repo.startPushDaemon({
  remote: 'origin',
  backoff: 'exponential',
  maxRetries: Infinity,
});

daemon.on('push',  ({ commit, durationMs }) => log.info({ commit, durationMs }));
daemon.on('error', ({ commit, err, attempt }) => log.warn({ err, attempt }));
daemon.on('retry', ({ commit, attempt, nextDelayMs }) => log.info({ attempt, nextDelayMs }));

// ... later, at shutdown:
await daemon.stop({ timeoutMs: 30_000 });
```

A consumer process that writes to gitsheets is the **single writer**. Pulling from the remote at runtime would risk overwriting in-memory state; that's why the daemon is push-only. If a consumer needs to incorporate changes from elsewhere, the canonical path is: stop the consumer, pull, restart.

See the [production push daemon recipe](recipes/production-push-daemon.md) for auth strategies and monitoring patterns.

## Validation

Two stacked layers run on every write, in order:

1. **JSON Schema** (persisted in `.gitsheets/<sheet>.toml`) — the shape contract that travels with the repo.
2. **Standard Schema** (consumer-supplied, optional) — richer validation: branded types, refinements, transforms.

Failure at either layer throws `ValidationError` with a structured `issues` array. The `source` field on each issue identifies which layer raised it.

The Standard Schema layer can **transform** the record (lower-casing, defaulting, parsing) — the transformed value is what gets normalized + written.

See [validation](validation.md) for the full pipeline.

## Canonical normalization

Independent of validation: rules that affect *how the record's bytes are written* so logically-equal records produce byte-identical TOML.

- **Object keys** are alphabetically sorted (deep)
- **Array fields** may declare a `sort` rule to enforce element order before write

Determinism makes git diffs meaningful and enables hash-based caching.

## Attachment

A binary blob colocated with a record. Stored at `<recordPath>/<attachmentName>` — e.g., a record at `users/jane.toml` may have an attachment at `users/jane/avatar.jpg`.

```typescript
await sheet.setAttachment(record, 'avatar.jpg', blob);
const blob = await sheet.getAttachment(record, 'avatar.jpg');
```

Attachments are first-class: included in tree commits, deleted with their record (cascade), accessible per-record via `sheet.getAttachments(record)`.

## Commits as audit log

There is no separate audit table. Every mutation produces a commit with author, committer, timestamp, full diff, message, and structured trailers. Queries an audit table would serve are answered by `git log --grep` / `--author` / `-- <path>/`.

```bash
# Every mutation that touched users/jane.toml
git log -- users/jane.toml

# Every commit with Action=user.create trailer
git log --grep='^Action: user.create$'

# Every commit by a specific actor
git log --author=jane@x.org
```

This isn't a feature gitsheets builds — it's the *substrate* gitsheets sits on. But trailer conventions exist so the commit log itself stays queryable.

## See also

- [`specs/concepts.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/concepts.md) — the authoritative version of this page
- [API reference](api.md)
- [CLI reference](cli.md)
- The [recipes](README.md#recipes) for concrete consumer-level examples
