# Behavior: Content Types (markdown / mdx)

## Rule

A sheet's records are stored as `.toml` files by default. Setting `[gitsheet.format]` switches a sheet's on-disk format — `markdown` stores records as `.md` files with TOML frontmatter and a designated body field; `mdx` is the same parser writing `.mdx`. Format is fixed **per sheet**, not per record.

## Applies To

- [api/sheet.md](../api/sheet.md) — `query`, `queryFirst`, `queryAll`, `loadBody`, `upsert`, `patch`, `findByIndex`
- [behaviors/normalization.md](normalization.md) — canonical frontmatter via the existing sort-keys-deep TOML serializer
- [behaviors/validation.md](validation.md) — JSON Schema unchanged; the body field is just a string-typed property on the record

## Why sheet-level (not per-record)

If both `users/jane.md` and `users/jane.toml` could coexist, the path template would render the same key (`jane`) for two distinct files — uniqueness breaks. The format discriminator lives on the sheet to keep the path-template's key-to-file mapping single-valued.

## Config

```toml
# .gitsheets/posts.toml
[gitsheet]
root = 'posts'
path = '${{ slug }}'

[gitsheet.format]
type = 'markdown'           # default: 'toml'. 'mdx' is an alias (same parser, .mdx extension).
body = 'body'               # field name that holds the body text; required when type='markdown' or 'mdx'

[gitsheet.format.markdownlint]
# Optional. Passed straight through as markdownlint config.
# Defaults applied on top of consumer settings:
#   default = true     (all default rules)
#   MD013 = false      (line-length 80 disabled — prose / long lines OK)
#   MD041 = false      (first-line H1 not required — many bodies start with prose)
```

Disable normalization entirely with `markdownlint = false`:

```toml
[gitsheet.format]
type = 'markdown'
body = 'body'
markdownlint = false
```

## On-disk format

```markdown
+++
slug = 'hello-world'
publishedAt = 2024-05-16T10:00:00Z
tags = [ 'intro', 'meta' ]
title = 'Hello, world'
+++

# Hello, world

This is the body, normalized by markdownlint.
```

- Frontmatter is canonical TOML (deep-sorted keys via the existing `stringifyRecord` path).
- Delimiter is `+++` (TOML-style; the YAML `---` alternative is rejected — it would force a YAML round-trip and lose TOML's Date types).
- **File ends with exactly one `\n`.** That final newline belongs to the file, not the body — a body value of `'hi\n'` is normalized to `'hi'` on the way out so the round-trip is idempotent.

## Read / write pipeline

### Write

1. Split the record: body field (the configured `body` name) → body text; everything else → frontmatter record.
2. Serialize frontmatter via `stringifyRecord` (deep-sorted keys, the existing canonical TOML path).
3. Normalize body via `markdownlint --fix` with the configured rule set (skipped if `markdownlint = false`).
4. Join `+++\n<frontmatter>+++\n\n<body>\n`.
5. Write the blob.

### Read

1. Split the on-disk text on the first `+++` opener and the next `+++` closer.
2. Parse frontmatter as TOML.
3. Body verbatim → inject under the configured `body` field name.

**Normalization is body-only.** The TOML frontmatter is never seen by markdownlint — that avoids any risk of lint rules mangling TOML content that happens to look like markdown.

## Validation

JSON Schema in `[gitsheet.schema]` runs unchanged — the body field is a string-typed property on the record. Consumers declare it explicitly:

```toml
[gitsheet.schema.properties.body]
type = 'string'
```

The library does **not** auto-inject a body schema. Consumers can validate body length, allowed-content rules, etc. on their own terms.

Validation runs on writes only. Body-less reads (see below) skip validation as they always do.

## Path template + uniqueness

- Path template renders unchanged. The only difference is the file extension Sheet appends (`.md` for markdown, `.mdx` for mdx, `.toml` for everything else).
- **Body field name must not collide with a path-template field.** A sheet with `path = '${{ body }}'` + `body = 'body'` raises `ConfigError('config_invalid')` at sheet-open time — the body field cannot also identify the record.

## Lazy body loading

Frontmatter is small; bodies can be arbitrarily large. For bulk operations that only need metadata (filtering, indexing, reporting), reading + parsing every record's body is wasteful. The library supports opt-in body-less reads with explicit hydration.

### API shape

```typescript
// Default — body is loaded (matches non-markdown sheets)
for await (const post of sheet.query({ status: 'published' })) {
  console.log(post.title, post.body);
}

// Opt-in: frontmatter only
for await (const post of sheet.query({ status: 'published' }, { withBody: false })) {
  console.log(post.title);  // post.body is undefined
}

// Hydrate when needed
const full = await sheet.loadBody(post);
console.log(full.body);
```

Mirror on `queryFirst` / `queryAll`. `withBody` is a no-op on TOML sheets (no body concept).

### Parser

The body-less path uses `format.parseHeaderOnly`, which reads bytes from the blob until the closing `+++` line and stops. The body bytes are never materialized in memory.

### Indexes

- **Index builds always use body-less reads.** A `keyFn` that references `record.body` will see `undefined` and the record is excluded from the index (the keyFn returns undefined). This is deliberate — body content isn't a record identifier.
- **`findByIndex` returns body-less records.** Consumers needing the body call `sheet.loadBody(record)`.

### Query filters

- **Filters referencing the body field under `withBody: false` throw `TypeError` at query start.** Without this guard the filter would silently match nothing.
- With the default (`withBody: true` or unspecified), filters can reference the body field like any other.

### Patch

`Sheet.patch(query, partial)` always full-loads the existing record (its `queryFirst` runs with the default `withBody: true`). RFC 7396 semantics apply: `{body: null}` deletes the body (the body field is removed from the merged record; on serialize it becomes an empty body). The follow-up upsert receives an internal `allowMissingBody: true` to permit this.

### Upsert with a body-less record

- `sheet.upsert(record)` where the body field is `undefined` throws `TypeError` unless the consumer passes `upsert(record, { allowMissingBody: true })`.
- Rationale: `upsert` is a full-record replace. A body-less record would erase the on-disk body, which is rarely the intent. Explicit opt-in keeps the trade visible.
- Consumers wanting body-preserving frontmatter updates use `sheet.patch(query, partial)`.

### CLI

`gitsheets query <sheet>` includes the body by default. Pass `--no-body` to suppress it for bulk pipelines:

```bash
gitsheets query posts --filter status=published --no-body --format=csv
```

## Edge cases

- **Body contains `+++` on its own line** — the parser splits on the first matched pair only; the body preserves further `+++` lines verbatim.
- **Empty body** — file is `+++\n<frontmatter>+++\n\n\n` (markers + a single blank line + trailing newline); reads back as `body: ''`.
- **Body ends with `\n`** — round-trips as `body` without the trailing newline (the file's trailing newline is the file's, not the body's). Idempotent across serialize-parse cycles.
- **UTF-8 BOM at file start** — stripped on parse.
- **No frontmatter delimiters** — treated as body-only; the parsed record has just the body field set.
- **Mid-flight format switch** — not supported. A future `gitsheets migrate-format <sheet>` command can re-encode files when needed.

## Pluggable formats

The format dispatch lives in `src/format/`. Three implementations ship: `toml` (default), `markdown`, and `mdx` (markdown with `.mdx` extension). Additional formats (AsciiDoc, code-commented frontmatter, sidecar files) are future work — frontmatter conventions aren't universal across formats and each needs its own design.

## Coordinates with

- [api/sheet.md](../api/sheet.md)
- [behaviors/validation.md](validation.md)
- [behaviors/transactions.md](transactions.md)
- [GitHub #158](https://github.com/JarvusInnovations/gitsheets/issues/158) — feature design
