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
title = 'title'             # optional — denormalize body's first H1 into this field (see "Title from H1")
normalize = true            # optional, default true — native body normalization on write (see below)
```

### Body normalization

Markdown/mdx bodies are normalized on **write** by the native Rust
`dprint-plugin-markdown` formatter, embedded directly in the bytes-authority
core. The formatter is the **single** source of body bytes across every binding
(Node, Python, …) — there is no host-side markdownlint pre-pass, so a given body
serializes to identical bytes regardless of which language drives the write.

The formatter runs **aggressive with `textWrap = "never"`**: each paragraph is
unwrapped to a single logical line (soft line breaks removed; hard breaks —
backslash or two-trailing-spaces — and block boundaries preserved), tables are
column-aligned, list / emphasis / heading / code-fence styles are made
consistent, and runs of blank lines collapse. Because `textWrap` is `never`, the
line width never affects prose bytes.

The exact emitted configuration (a canonical-behavior contract input, pinned in
`rust/gitsheets-core/Cargo.toml` alongside the serializer / engine / collator):

```text
dprint-plugin-markdown =0.22.1
  textWrap         = never        # unwrap paragraphs; line width is inert for prose
  emphasisKind     = underscores  # _italic_
  strongKind       = asterisks    # **bold**
  unorderedListKind = dashes      # - item
  headingKind      = atx          # # Heading (setext is converted to ATX)
  listIndentKind   = commonMark
```

Disable normalization with `normalize = false` — the body is then framed
**verbatim** (only the codec's structural framing applies: delimiters,
frontmatter, trailing-newline). Use this when bytes must be preserved exactly:

```toml
[gitsheet.format]
type = 'markdown'
body = 'body'
normalize = false
```

> **One-time re-baseline.** Switching body normalization from the former
> host-side `markdownlint --fix` pass to the native `dprint-plugin-markdown`
> formatter re-baselines on-disk body bytes once (e.g. emphasis `*italic*` →
> `_italic_`, list markers normalized to `-`, setext headings converted to ATX,
> soft-wrapped paragraphs unwrapped). Markdown data is negligible by design, so
> the re-baseline is acceptable; the `markdownlint` dependency and its
> rule-specific config surface are dropped.

## On-disk format

```markdown
+++
slug = 'hello-world'
publishedAt = 2024-05-16T10:00:00Z
tags = [ 'intro', 'meta' ]
title = 'Hello, world'
+++

# Hello, world

This is the body, normalized by the native dprint formatter.
```

- Frontmatter is canonical TOML (deep-sorted keys via the existing `stringifyRecord` path).
- Delimiter is `+++` (TOML-style; the YAML `---` alternative is rejected — it would force a YAML round-trip and lose TOML's Date types).
- **File ends with exactly one `\n`.** That final newline belongs to the file, not the body — a body value of `'hi\n'` is normalized to `'hi'` on the way out so the round-trip is idempotent.

## Read / write pipeline

### Write

1. Split the record: body field (the configured `body` name) → body text; everything else → frontmatter record.
2. Serialize frontmatter via `stringifyRecord` (deep-sorted keys, the existing canonical TOML path).
3. Normalize body via the native `dprint-plugin-markdown` formatter (skipped if `normalize = false`). Normalization runs **before** title-from-H1 extraction, so the extracted title agrees with the body that lands on disk.
4. Join `+++\n<frontmatter>+++\n\n<body>\n`.
5. Write the blob.

### Read

1. Split the on-disk text on the first `+++` opener and the next `+++` closer.
2. Parse frontmatter as TOML.
3. Body verbatim → inject under the configured `body` field name.

**Normalization is body-only.** The TOML frontmatter is never seen by the formatter — only the body string is handed to `dprint-plugin-markdown`. That avoids any risk of the formatter mangling TOML content that happens to look like markdown.

**Normalization is deterministic and idempotent.** `normalize(normalize(body)) == normalize(body)`, so a record round-trips byte-stably: re-upserting a record read back from disk is a no-op.

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

## Title from H1

When `[gitsheet.format].title` names a field, the format pipeline treats that field as a denormalization of the body's first H1.

### Invariant

> `record[<title>] === <body's first H1, or undefined>`

Frontmatter and body H1 always agree on disk. The pipeline enforces this on every write.

"First H1" is the first line of the body that matches the ATX-style regex `^# (.+?)[ \t]*$`. Setext-style (`Title\n====`) is not recognized.

### Why denormalize?

A common authoring convention is to put the title as the first H1 of the body:

```markdown
+++
slug = "hello-world"
+++

# Hello, world

Body content here.
```

The denormalization gives consumers both ergonomics: the title is queryable / indexable as a record field (no body load needed) AND the on-disk file is a standalone markdown document with a proper heading.

### Behavior — `Sheet.upsert(record, opts?)`

Consumer asserts the complete new state. The input must already satisfy the invariant.

| Input | Outcome |
|---|---|
| `{slug, body: '# Y\n…'}` | derives `title = 'Y'`, writes |
| `{slug, title: 'Y', body: '# Y\n…'}` | consistent, writes |
| `{slug, title: 'X', body: '# Y\n…'}` | throws `ValidationError` — input is self-inconsistent |
| `{slug, body: 'no heading\n…'}` | extracted title is `undefined` → frontmatter omits `title` |
| `{slug, title: 'X', body: 'no heading\n…'}` | throws `ValidationError` — supplied title without an H1 to back it |

The body-presence guard from `upsert` still applies — `{slug, title: 'X'}` (no body) throws regardless of the title invariant.

### Behavior — `Sheet.patch(query, partial)`

Consumer supplies a delta. Patch applies it and reconciles to maintain the invariant.

| `partial` | Patch's job |
|---|---|
| `{title: 'X'}` | rewrite body's first H1 to `# X` (or prepend `# X\n\n` if no H1); write `title = 'X'` |
| `{body: '# Y\n…'}` | re-derive title from new body's H1; write `title = 'Y'` |
| `{title: 'X', body: '# X\n…'}` | consistent, write as-is |
| `{title: 'X', body: '# Y\n…'}` | throws `ValidationError` — delta itself is self-inconsistent |
| `{tags: ['intro']}` | neither title nor body touched, invariant preserved trivially |
| `{body: 'no heading'}` | title becomes `undefined` (frontmatter omits `title`) |

The asymmetry between `upsert({title: 'X'})` (throws because body wasn't supplied) and `patch({title: 'X'})` (works — rewrites body's H1) mirrors PUT vs PATCH semantics: `upsert` is a state assertion; `patch` is a reconciled delta.

### Normalization interaction

Body normalization runs **before** title-from-H1 extraction, so the title is
derived from the bytes that land on disk. This means the formatter's heading
normalization feeds the invariant — e.g. a setext H1 (`Title\n=====`) is
converted to ATX (`# Title`) and *then* recognized as the first H1, so a
setext-authored title is extracted rather than silently lost.

The title invariant is enforced by the codec itself, independent of
normalization:

- Supplying `title` with a body that has **no** H1 throws `ValidationError`
  (`{slug, title: 'X', body: 'no heading'}` is self-inconsistent).
- Supplying **no** `title` with a body that has no H1 simply omits `title` from
  frontmatter.

(There is no markdownlint `MD041` auto-enable anymore — markdownlint is gone.)

### Performance

The denormalization is free at runtime — both reads stay fast:

| Operation | Cost vs. no-title-extraction |
|---|---|
| `query({}, {withBody: false})` | Same — title is in frontmatter, no body bytes loaded |
| `query()` (with body) | Same — body fully loaded as today |
| Index build | Same — body-less reads see title in frontmatter |
| `upsert` | + 1 regex scan over body (already in memory) |
| `patch({title})` | + 1 `rewriteLeadingH1` call (single regex replace) |

## Edge cases

- **Body contains `+++` on its own line** — the parser splits on the first matched pair only; the body preserves further `+++` lines verbatim.
- **Empty body** — file is `+++\n<frontmatter>+++\n\n\n` (markers + a single blank line + trailing newline); reads back as `body: ''`.
- **Body ends with `\n`** — round-trips as `body` without the trailing newline (the file's trailing newline is the file's, not the body's). Idempotent across serialize-parse cycles.
- **UTF-8 BOM at file start** — stripped on parse.
- **No frontmatter delimiters** — treated as body-only; the parsed record has just the body field set.
- **Mid-flight format switch** — not supported. A future `gitsheets migrate-format <sheet>` command can re-encode files when needed.

## Pluggable formats

The format dispatch lives in `packages/gitsheets/src/format/`. Three implementations ship: `toml` (default), `markdown`, and `mdx` (markdown with `.mdx` extension). Additional formats (AsciiDoc, code-commented frontmatter, sidecar files) are future work — frontmatter conventions aren't universal across formats and each needs its own design.

## Coordinates with

- [api/sheet.md](../api/sheet.md)
- [behaviors/validation.md](validation.md)
- [behaviors/transactions.md](transactions.md)
- [GitHub #158](https://github.com/JarvusInnovations/gitsheets/issues/158) — feature design
