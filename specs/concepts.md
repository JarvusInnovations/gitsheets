# Concepts

The vocabulary every consumer needs. Read this before the API specs.

## Repository

A git repository that contains gitsheets-managed data. Created from disk via `openRepo({ gitDir? })`. The library reads + writes git objects through hologit and through the underlying `git` CLI.

A repository can also contain ordinary code, docs, anything — gitsheets only cares about paths under `.gitsheets/` (sheet configs) and the data paths each sheet declares.

## Sheet

A typed collection of records, declared by a TOML file at `.gitsheets/<name>.toml`. Each sheet has:

- A **name** (the basename of its config file)
- A **root path** — the directory under which the sheet's records live (default: `.`)
- A **path template** — how a record maps to a file path
- An optional **JSON Schema** — the record shape contract (see [behaviors/validation.md](behaviors/validation.md))
- Optional **canonical normalization rules** for array field sorting (see [behaviors/normalization.md](behaviors/normalization.md))

A repository may contain many sheets. They share the repo but otherwise are independent.

## Record

A single TOML document stored under the sheet's root, at the path rendered from the sheet's path template against the record's fields.

Records are validated on every write — first against the persisted JSON Schema, then against any consumer-supplied Standard Schema validator.

Records have implicit annotations gitsheets attaches at read time (the sheet name they came from, the path they were read from) — accessed via well-known Symbols (`Symbol.for('gitsheets-sheet')`, `Symbol.for('gitsheets-path')`) so they don't collide with the record's own fields.

## Path Template

A small DSL for "where does this record live in the tree, and how do queries prune the search."

```text
${{ field }}                # bare field reference
${{ expression }}           # JS expression evaluated against the record
${{ field/** }}             # recursive field — value may contain `/` and matches subtrees
literal-text-${{ field }}   # literal prefix/suffix attached to an expression
${{ a }}/${{ b }}           # path segments
```

Path templates serve two roles:

1. **Where to write** — gitsheets renders the template against a record to determine its file path.
2. **How to query efficiently** — when a query includes the path template's fields, gitsheets walks only matching subtrees instead of every record.

See [behaviors/path-templates.md](behaviors/path-templates.md) for the syntax and traversal rules.

## Attachment

A binary blob colocated with a record. Stored at `<recordPath>/<attachmentName>` — e.g., a record at `users/jane.toml` may have an attachment at `users/jane/avatar.jpg`.

Attachments are first-class — get/set methods on `Sheet`, included in tree commits the same way records are.

## Transaction

A scope that bundles one or more sheet mutations into a single commit. Opens against a parent ref, runs a handler that performs mutations, commits on success (no commit on throw).

A transaction carries an **author**, **committer**, **commit message** (subject line + body), and **trailers** (git-style key/value metadata).

Mutations outside a transaction (in permissive mode) implicitly open and commit a single-mutation transaction. The transaction model is the same either way; only the explicit-vs-implicit framing differs. See [behaviors/transactions.md](behaviors/transactions.md).

## Store

A top-level typed wrapper that auto-discovers sheets in a repository and binds them to consumer-supplied Standard Schema validators. Returns a typed object whose properties are the sheets:

```typescript
const store = await openStore(repo, { validators });
store.users.upsert(record);    // typed against UserSchema
store.transact(opts, async tx => {
  tx.users.upsert(...);
});
```

The Store is sugar around `Repository.openSheets()` + `Repository.transact()` with TypeScript-level sheet-name + record-shape inference.

## Index

An in-memory secondary index on a sheet, keyed by a function the consumer supplies. Lazy by default (built on first lookup), with an eager opt-in.

```typescript
sheet.defineIndex('byEmail', { unique: true }, (record) => record.email.toLowerCase());
const jane = await sheet.findByIndex('byEmail', 'jane@example.com');
```

Indices are not persisted to the git repo. They live in process memory, invalidate on `upsert` / `delete` (same instance) or on out-of-band ref movement, and rebuild on demand. See [behaviors/indexing.md](behaviors/indexing.md).

## Push Daemon

An optional, library-side background task that pushes new commits to a configured git remote with retry/backoff. Push-only — no pull at runtime. See [behaviors/push-sync.md](behaviors/push-sync.md).

## Validation layers

Two layers run on every write, in order:

1. **JSON Schema** (persisted in `.gitsheets/<sheet>.toml`) — the shape contract that travels with the repo.
2. **Standard Schema** (consumer-supplied, optional) — richer validation: branded types, refinements, transforms.

See [behaviors/validation.md](behaviors/validation.md).

## Canonical normalization

Independent of validation: rules that affect *how the record's bytes are written* so logically-equal records produce byte-identical TOML.

- **Object keys** are alphabetically sorted (deep).
- **Array fields** may declare a `sort` config to enforce a deterministic element order before write.

See [behaviors/normalization.md](behaviors/normalization.md).

## Format

A sheet's on-disk storage format. Default: TOML (`.toml` files). Setting `[gitsheet.format] type = 'markdown'` (or `'mdx'`) switches to markdown files with TOML frontmatter and a designated body field. Format is fixed per sheet — there's no per-record discriminator because the path template has to render a single canonical filename per record.

The pluggable format module (`src/format/`) registers `toml`, `markdown`, and `mdx`; future formats slot in without re-shaping the sheet config grammar.

See [behaviors/content-types.md](behaviors/content-types.md).

## Body field (content-typed sheets)

A content-typed sheet declares one of its record fields as the body (`[gitsheet.format] body = '<field>'`). At serialize time the body field is split out into the markdown body of the file; everything else becomes TOML frontmatter. At parse time the inverse: frontmatter becomes record fields, body bytes become the body field. The body field cannot collide with a path-template field.

Bodies are *lazy* — `Sheet.query` / `queryFirst` / `queryAll` accept `opts.withBody` (default `true`); `withBody: false` skips body bytes entirely. `Sheet.loadBody(record)` hydrates a body-less record on demand. Index builds always use body-less reads.

## Prefix scoping

`prefix` is a runtime knob (on `Repository.openSheet({ prefix })` / `Transaction.sheet(name, { prefix })` / the CLI `--prefix` flag) that scopes record reads/writes to a sub-tree under the sheet's configured root. Useful for multi-tenant deployments where one git repo holds many tenants under `<root>/<tenant>/...`. The `.gitsheets/<name>.toml` sheet config file is unaffected — only the record data tree is scoped.

## Commits as audit log

There is no separate audit table. Every mutation produces a commit with author, committer, timestamp, full diff, message, and structured trailers. Queries that an audit table would serve are answered by `git log --grep` / `--author` / `-- <path>/`.

This isn't a feature gitsheets builds — it's the *substrate* gitsheets sits on. But it's worth naming because it shapes downstream behavior: trailer conventions (see [behaviors/transactions.md](behaviors/transactions.md)) exist so that the commit log itself is queryable.
