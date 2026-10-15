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
- [Template fields must be schema-required](#template-fields-must-be-schema-required)
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
| --- | --- | --- |
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
```

Expressions that throw `ReferenceError` for a missing identifier are treated as "un-renderable" (so queries with partial fields can walk the tree). Other thrown errors propagate.

**Don't use expressions to partition by date** (`${{ publishedAt.getUTCFullYear() }}/…`). Use the declarative date-bucket form below — it's shorter, timezone-safe by construction, and it's the only form whose queries can be range-pruned.

### Date-bucket partitioning: `${{ field: FORMAT }}` (v2.4+)

The idiomatic way to partition records by time. A field name, a colon, and one of a **closed set** of formats:

```toml
path = '${{ publishedAt: YYYY/MM/DD }}/${{ slug }}'   # posts/2026/03/09/hello.toml  (day partitions)
path = '${{ publishedAt: YYYY/MM }}/${{ slug }}'      # posts/2026/03/hello.toml     (month partitions)
path = '${{ publishedAt: YYYY }}/${{ slug }}'         # posts/2026/hello.toml        (year partitions)
path = '${{ publishedAt: YYYY/WW }}/${{ slug }}'      # posts/2026/11/hello.toml     (ISO-week partitions)
path = '${{ day: YYYY/MM/DD }}'                       # rollups/2026/03/09.toml      (bucket IS the identity — daily rollups)
```

| Format | Segments | Notes |
| --- | --- | --- |
| `YYYY` | calendar year | |
| `YYYY/MM` | year / month | `MM` zero-padded |
| `YYYY/MM/DD` | year / month / day | `MM`, `DD` zero-padded |
| `YYYY/WW` | ISO week-based year / ISO week | the `YYYY` here is the ISO **week-year**: 2027-01-01 renders `2026/53`; 2024-12-30 renders `2025/01` |

Rules worth knowing:

- **One token expands to multiple real directory levels** (`YYYY/MM/DD` is three), so the token must stand alone in its segment — `posts-${{ d: YYYY }}` is a `ConfigError`. It can sit anywhere in the template, including as the entire path.
- **UTC always.** Offset datetimes convert to UTC before the date parts are read; offset-less values are taken at face value. The same record renders the same path on every host — the bug class `getFullYear()` invites.
- **Accepted values**: `Date`s, TOML datetime / local-datetime / local-date, and ISO 8601 strings (`2026-03-09`, `2026-03-09T12:00:00Z`, `…-05:00`). Anything else (a number, an unparseable string) fails the write with `PathTemplateError`; a *missing* field is un-renderable like any other missing path field.
- **Anything outside the four formats** (`YYYY-MM`, `MM/DD`, `YYYY/MM/DD/HH`) is `ConfigError('config_invalid')` at sheet-open. Needs beyond the set (hour buckets, quarters) fall back to the expression form, but then nothing prunes.
- Pair it with a schema: `[gitsheet.schema.properties.publishedAt] type = 'string' format = 'date-time'` so the field is validated and normalized as a datetime. Without a schema, a JSON upsert stores the ISO string as a string (which still buckets correctly, but range filters then compare lexicographically rather than as instants).

### How queries use the template

A query that supplies path-template fields reads only the matching subtrees instead of every record — this is what makes partitioned sheets scale. On a date-bucketed sheet:

- **Equality** on the bucket field (`{ publishedAt: new Date('2026-03-09T12:00:00Z') }`) descends the exact `2026/03/09/` partition.
- **A range** on the bucket field (`{ publishedAt: { $gte: '2025-11-20', $lt: '2026-02-03' } }`) walks only the partitions between the bounds — whole years / months / days outside the range are never opened. See `api.md` → "Range filters" for the operator grammar, `axi.md` for the `--filter 'publishedAt>=2025-11-20'` form.
- **Absent** from the query → the bucket segments are wildcards (full walk, still correct).

Ranges prune **only** on bucket components. A `${{ year }}` string field or an expression component doesn't order like its directory names, so a range on it still filters correctly but reads every record.

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

1. JSON Schema (this block) via the Rust core's `jsonschema` validator (Draft-07, formats asserted, strict — an unknown/typo'd keyword fails to compile with `ConfigError('config_invalid')` at sheet-open)
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

- `$data` references (a schema referencing another field's runtime value) are **disabled** — a `[gitsheet.schema]` containing `$data` fails to compile with `ConfigError('config_invalid')`.
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
title = 'title'        # optional — denormalize body's first H1 into this field
normalize = true       # default true — reformat the body on write (see below)
```

Bodies are normalized on write by the native `dprint-plugin-markdown` formatter embedded in the core (the same bytes across every binding). It runs aggressive with `textWrap: never`: each paragraph is unwrapped to one logical line, tables are column-aligned, and list/emphasis/heading/code-fence styles are made consistent (unordered lists become `-`, headings ATX). There is no per-rule config; it is on or off. (Before v2 this was a host-side `markdownlint --fix` pass with a `[gitsheet.format.markdownlint]` rule table — both are gone.)

When `title` is set, the library enforces `record[<title>] === <body's first H1, or undefined>` on every write. `Sheet.upsert` with disagreeing input throws `ValidationError`; `Sheet.patch({title: 'X'})` rewrites the body's H1; `Sheet.patch({body: '# Y\n…'})` re-derives the title. The on-disk file remains a standalone markdown document — the H1 stays in the body verbatim.

Disable normalization entirely (bodies written verbatim):

```toml
[gitsheet.format]
type = 'markdown'
body = 'body'
normalize = false
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

This is the body. Normalized on write by the core's native markdown formatter.
```

- Frontmatter is canonical TOML (deep-sorted keys via the existing `stringifyRecord` path).
- Delimiter is `+++` (Hugo-style; YAML-style `---` is rejected to preserve TOML Date types).
- **File always ends with one `\n`.** That final newline is the file's, not the body's — a body value of `'hi\n'` round-trips as `'hi'` (idempotent across serialize/parse).

### Format types

| `type` | Extension | Notes |
| --- | --- | --- |
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
# normalize = false   # optional: write bodies verbatim (default is native reformat)

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

## Template fields must be schema-required

When a sheet has a persisted schema (`[gitsheet.schema]` and/or `implements`), every *static* template field — `${{ field }}`, `${{ field/** }}`, or a date bucket's base field — must be in a top-level `required` list of the local schema or a declared contract. Otherwise `openSheet` (and every CLI command that opens the sheet, including `contracts verify`) fails with `ConfigError('config_invalid')` naming the field. Expression components are exempt; schemaless sheets are not checked. **There is no exemption list** (the 2.8.0 `injectedFields` key was removed in 2.9.0 and is rejected by name).

Why: a record carries every field its path renders — path rendering is a pure function of the stored record (specs/principles.md "Records carry their own path"). A path field the service "injects" before upsert (a tenant key, a parent's slug) belongs on the record and in `required`; when a child's path is keyed by its parent's handle, that handle *is* the reference to the parent. Don't suggest stripping or injecting path fields in consumer code — put them in the schema.

```toml
[gitsheet]
root = 'roles'
path = '${{ projectSlug }}/${{ slug }}'

[gitsheet.schema]
type = 'object'
required = ['projectSlug', 'slug']
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
3. **Format-specific normalization** — for markdown sheets (unless `normalize = false`), the body is reformatted by the core's native `dprint-plugin-markdown` formatter.

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
