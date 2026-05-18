# gitsheets sheet config reference

A sheet is declared by a TOML file at `.gitsheets/<sheet-name>.toml` in the data repo. The file holds the sheet's identity (root, path template), validation (schema), per-field rules (sort), and optional storage format (TOML / markdown / mdx).

## Table of contents

- [Minimal config](#minimal-config)
- [Top-level `[gitsheet]`](#top-level-gitsheet) — root, path
- [Path template syntax](#path-template-syntax) — `${{ field }}`, expressions, recursive `**`
- [`[gitsheet.schema]`](#gitsheetschema) — JSON Schema validation
- [`[gitsheet.fields.<name>]`](#gitsheetfieldsname) — per-field rules (sort)
- [`[gitsheet.format]`](#gitsheetformat) — TOML (default) / markdown / mdx
- [Body field collision](#body-field-collision) — markdown sheets
- [Common patterns](#common-patterns)
- [Validation behavior](#validation-behavior)
- [Canonical normalization](#canonical-normalization)

## Minimal config

```toml
[gitsheet]
root = 'users'
path = '${{ slug }}'
```

That's it. Records live at `users/<slug>.toml`. No validation, no normalization rules, default TOML format.

## Top-level `[gitsheet]`

| Key | Type | Notes |
|---|---|---|
| `root` | string | Sub-directory under the data root where this sheet's records live. Required. |
| `path` | string | Path template — see below. Required. Non-empty string. |

The sheet's full storage location is `<data-root>/<root>/<rendered-path>.<ext>`, where:

- `<data-root>` comes from the CLI `--root` flag or `GITSHEETS_ROOT` (default: repo root)
- `<root>` is from this config
- `<rendered-path>` is the result of evaluating the path template against the record
- `<ext>` is `.toml`, `.md`, or `.mdx` depending on `[gitsheet.format]`

## Path template syntax

Templates render record paths from record fields. The template is a string with one or more components separated by `/`. Each component can mix literal text with field references and expressions.

### Field reference: `${{ field }}`

```toml
path = '${{ slug }}'                          # → users/jane
path = '${{ domain }}/${{ username }}'        # → users/af.mil/jane
path = '${{ year }}-${{ slug }}'              # → posts/2024-hello-world
```

A field reference must evaluate against the record. If the field is missing or `undefined`, the render fails (`PathTemplateError`).

Fields render as strings: numbers and booleans stringify; Dates use `.toString()`; arrays and plain objects are un-renderable.

### Expressions: `${{ <js-expression> }}`

Any JavaScript expression is allowed. Bare identifiers resolve from the record:

```toml
path = '${{ slug.toLowerCase() }}'                  # → 'janedoe'
path = '${{ id || legacy_id }}'                     # fallback to legacy_id when id missing
path = '${{ publishedAt.getUTCFullYear() }}/${{ slug }}'  # year-partitioned
```

Expressions that throw `ReferenceError` for a missing identifier are treated as "un-renderable" (so queries with partial fields can walk the tree). Other thrown errors propagate.

### Multi-variable segments

Multiple references in one component are supported (this was fixed in v1.0 — earlier versions choked on it):

```toml
path = '${{ year }}-${{ month }}/${{ slug }}'      # → posts/2024-05/hello-world
```

### Recursive: `**`

A component of `**` matches arbitrary tree depth. Useful for free-form folder hierarchies that don't constrain a structured field:

```toml
path = '**/${{ slug }}'                            # any depth, slug as the leaf name
```

Only the leaf component is a record file; intermediate `**` matches subdirectories.

### Invalid characters

Per the spec, rendered segments reject Windows-invalid characters: `< > : " | ? *` and control chars (0x00–0x1f). For non-recursive segments, `/` is also rejected (preventing accidental path-structure expansion). Recursive segments allow `/`.

## `[gitsheet.schema]`

A standard JSON Schema validated on every write. Validation runs in this order:

1. JSON Schema (this block) via `ajv` in strict mode + `ajv-formats`
2. Standard Schema (consumer-supplied via `openSheet({validator})` or `openStore({validators})`) — Zod, Valibot, ArkType, Effect Schema

The Standard Schema layer can **transform** the record; the transformed value is what gets normalized and written.

```toml
[gitsheet.schema]
type = 'object'
required = ['slug', 'email']

[gitsheet.schema.properties.slug]
type = 'string'
pattern = '^[a-z0-9-]+$'

[gitsheet.schema.properties.email]
type = 'string'
format = 'email'

[gitsheet.schema.properties.accountLevel]
type = 'string'
enum = ['user', 'staff', 'admin']
default = 'user'
```

Notes:

- `$data` references (the ajv extension that lets a schema reference another field's runtime value) are **disabled** in v1.0 — a `[gitsheet.schema]` containing `$data` fails to compile with `ConfigError('config_invalid')`.
- Reads don't validate. Only writes.
- Default values from `default:` apply on write if the field is unset.

## `[gitsheet.fields.<name>]`

Per-field rules that affect *how the record is written*, not whether it's valid. Independent of `[gitsheet.schema]`.

Currently the only key is `sort` (for array-valued fields):

```toml
[gitsheet.fields.tags]
sort = true                # alphabetical ascending

[gitsheet.fields.attendees]
sort = ['lastName', 'firstName']        # sort by these fields, ASC each

[gitsheet.fields.priorities]
sort = { 'priority' = 'DESC', 'updatedAt' = 'ASC' }    # explicit directions
```

`sort` values:

- `true` — natural sort, ASC (uses `localeCompare` with numeric collation, case/punct-insensitive)
- `false` — no sort (default)
- `string[]` — list of field names to sort by, ASC each
- `Record<string, 'ASC' | 'DESC'>` — explicit per-field directions
- `string` — a JS expression of the form `(a, b) => { … }` (sandboxed via `vm.runInNewContext`)

The sort is applied on canonical normalization (every write goes through this). Array order on disk is byte-stable.

`fields` and `schema` are different concepts: `fields` controls *bytes-on-disk* (sort rules), `schema` controls *validity* (type/required/pattern/etc.).

## `[gitsheet.format]`

Optional. Switches the sheet's on-disk storage from `.toml` to markdown-with-frontmatter (`.md` or `.mdx`).

```toml
[gitsheet.format]
type = 'markdown'      # default: 'toml'. 'mdx' is an alias with .mdx extension.
body = 'body'          # required for markdown/mdx — field that holds the body text
title = 'title'        # optional — denormalize body's first H1 into this field (v1.3)

[gitsheet.format.markdownlint]
# Optional. Passed to markdownlint --fix during serialize.
# Default-rules-on-top: { default = true, MD013 = false, MD041 = false }
# When [gitsheet.format].title is set, MD041 auto-enables (consumer can override).
# Override any rule:
MD024 = false          # allow duplicate headings (long-form prose)
```

When `title` is set, the library enforces `record[<title>] === <body's first H1, or undefined>` on every write. `Sheet.upsert` with disagreeing input throws `ValidationError`; `Sheet.patch({title: 'X'})` rewrites the body's H1; `Sheet.patch({body: '# Y\n…'})` re-derives the title. The on-disk file remains a standalone markdown document — the H1 stays in the body verbatim.

Disable normalization entirely:

```toml
[gitsheet.format]
type = 'markdown'
body = 'body'
markdownlint = false
```

### On-disk layout (markdown / mdx)

```markdown
+++
publishedAt = 2026-05-16T10:00:00Z
slug = "hello-world"
tags = [ "intro", "meta" ]
title = "Hello, world"
+++

# Hello, world

This is the body. Normalized via markdownlint --fix on write.
```

- Frontmatter is canonical TOML (deep-sorted keys via the existing `stringifyRecord` path).
- Delimiter is `+++` (Hugo-style; YAML-style `---` is rejected to preserve TOML Date types).
- **File always ends with one `\n`.** That final newline is the file's, not the body's — a body value of `'hi\n'` round-trips as `'hi'` (idempotent across serialize/parse).

### Format types

| `type` | Extension | Notes |
|---|---|---|
| `'toml'` | `.toml` | Default. Whole record as TOML. |
| `'markdown'` | `.md` | TOML frontmatter + designated body field. |
| `'mdx'` | `.mdx` | Alias of markdown with `.mdx` extension. |

## Body field collision

For markdown / mdx sheets: the `body` field name **must not** appear in the path template. A sheet with `path = '${{ body }}'` + `body = 'body'` raises `ConfigError('config_invalid')` at sheet-open — the body field can't also identify the record (it would render the same path for any body content).

## Common patterns

### Slug-keyed records, simple TOML

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

### Multi-tenant via composite key

```toml
[gitsheet]
root = 'memberships'
path = '${{ org }}/${{ user }}'

# Patches auto-derive the query from path-template fields:
#   gitsheets upsert memberships '{"org":"acme","user":"jane","role":"admin"}' --patch
```

### Year-partitioned content

```toml
[gitsheet]
root = 'posts'
path = '${{ publishedAt.getUTCFullYear() }}/${{ slug }}'
```

### Markdown CMS

```toml
[gitsheet]
root = 'posts'
path = '${{ slug }}'

[gitsheet.format]
type = 'markdown'
body = 'body'

# Layered on top of library defaults (MD013, MD041 off):
[gitsheet.format.markdownlint]
MD024 = false       # allow duplicate headings (long-form content)

[gitsheet.schema]
type = 'object'
required = ['slug', 'title', 'body', 'publishedAt']

[gitsheet.schema.properties.slug]
type = 'string'
pattern = '^[a-z0-9-]+$'

[gitsheet.schema.properties.title]
type = 'string'
minLength = 1

[gitsheet.schema.properties.body]
type = 'string'

[gitsheet.schema.properties.publishedAt]
type = 'string'
format = 'date-time'

[gitsheet.schema.properties.tags]
type = 'array'
items.type = 'string'

[gitsheet.fields.tags]
sort = true       # alphabetize tags on every write
```

### Sort + index combination

```toml
[gitsheet]
root = 'tasks'
path = '${{ id }}'

[gitsheet.fields.assignees]
sort = ['lastName', 'firstName']     # canonical assignee order
```

```typescript
// In consumer code, register a secondary index on top:
sheet.defineIndex('byOwner', { unique: false }, (task) => task.owner);
const aliceTasks = await sheet.findByIndex('byOwner', 'alice');
```

## Validation behavior

- Validation runs **on writes only**. Reads return whatever's on disk.
- Failures throw `ValidationError` with `issues: ValidationIssue[]`. Each issue carries `path`, `message`, `source` ('json-schema' or 'standard-schema'), and optionally `schemaPath` / `code`.
- The Standard Schema layer can transform the record (lowercasing, defaulting, parsing). The transformed value is what gets normalized + written.
- To pre-validate without writing, use `validateRecord({ record, schema, validator? })` from the package root.

## Canonical normalization

Independent of validation. Applied on every write:

1. **Deep-sort object keys** (alphabetical, recursive).
2. **Per-field sort rules** from `[gitsheet.fields.<name>.sort]`.
3. **Format-specific normalization** — for markdown sheets, the body goes through `markdownlint --fix` with the configured rule set.

Bytes on disk are deterministic per logical-record state. Logically-equal records produce byte-identical files. This makes git diffs meaningful and enables content-hash-based caching.

The `gitsheets normalize <sheet>` CLI command re-runs the canonical write pipeline on every record (one transaction). For a single file, `gitsheets check <sheet> <file> --fix` does the working-tree-only equivalent.

## Sheet config location and the CLI

A config at `.gitsheets/<name>.toml` in the data repo is what `repo.openSheet(<name>)` looks for. The CLI's `--root` flag (or `GITSHEETS_ROOT`) changes where `.gitsheets/` is resolved — useful when gitsheets data lives in a subdirectory of a larger repo. `--prefix` (or `GITSHEETS_PREFIX`) scopes records further within the sheet for multi-tenant setups; the sheet config file is unaffected by `--prefix`.

## When in doubt

The behavior specs in [the gitsheets repo](https://github.com/JarvusInnovations/gitsheets/tree/develop/specs/behaviors) are the source of truth for edge cases:

- `path-templates.md` — template grammar + tree walk semantics
- `validation.md` — JSON Schema + Standard Schema pipeline
- `normalization.md` — canonical-write rules
- `content-types.md` — markdown/mdx format + lazy body loading
- `attachments.md` — sibling-blob storage
- `transactions.md` — single-writer, commit-on-success-only
- `push-sync.md` — push daemon
- `patch-semantics.md` — RFC 7396 merge details
- `indexing.md` — secondary index build + invalidation
