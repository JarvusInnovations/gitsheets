# Migrating a legacy `[gitsheet.fields]` config

Pre-v1.0 gitsheets used a `[gitsheet.fields]` block for typed field configuration. v1.0 replaces it with a proper `[gitsheet.schema]` JSON Schema block. The mapping is lossless for `type` / `enum` / `default`; `sort` stays where it is (it's a different concept); `trueValues` / `falseValues` move to a CSV-ingest helper.

The `gitsheets migrate-config <sheet>` CLI command (shipped in v1.1) automates this:

```bash
gitsheets migrate-config users --message='migrate users config to v1.0 schema'
```

This guide walks through what the command does step-by-step, useful when you want to understand the resulting config or apply migrations by hand.

## Mapping table

| Pre-v1.0 field config | v1.0 placement | Notes |
| --- | --- | --- |
| `type: 'number' \| 'string' \| 'boolean'` | `[gitsheet.schema.properties.<name>].type` | Lossless |
| `enum: [...]` | `[gitsheet.schema.properties.<name>].enum` | Lossless |
| `default: <value>` | `[gitsheet.schema.properties.<name>].default` | Lossless |
| `sort: ...` | `[gitsheet.fields.<name>.sort]` (unchanged) | Stays — different concept |
| `trueValues: [...]`, `falseValues: [...]` | Move to CSV-ingest helper | Was always CSV-specific |

## Worked example

### Before (pre-v1.0)

```toml
# .gitsheets/users.toml
[gitsheet]
root = 'users'
path = '${{ slug }}'

[gitsheet.fields.slug]
type = 'string'

[gitsheet.fields.email]
type = 'string'

[gitsheet.fields.accountLevel]
type = 'string'
enum = [ 'staff', 'member', 'guest' ]
default = 'member'

[gitsheet.fields.active]
type = 'boolean'
default = true
trueValues = [ 'yes', 'y', '1', 'true', 'TRUE' ]
falseValues = [ 'no', 'n', '0', 'false', 'FALSE' ]

[gitsheet.fields.tags]
sort = [ 'namespace', 'slug' ]
```

### After (v1.0)

```toml
# .gitsheets/users.toml
[gitsheet]
root = 'users'
path = '${{ slug }}'

# Validation lives in [gitsheet.schema] — a JSON Schema in TOML.
[gitsheet.schema]
type = 'object'
required = [ 'slug', 'email' ]

[gitsheet.schema.properties.slug]
type = 'string'

[gitsheet.schema.properties.email]
type = 'string'
format = 'email'

[gitsheet.schema.properties.accountLevel]
type = 'string'
enum = [ 'staff', 'member', 'guest' ]
default = 'member'

[gitsheet.schema.properties.active]
type = 'boolean'
default = true

# Canonical normalization (the `sort` rule) stays under [gitsheet.fields.*].
[gitsheet.fields.tags]
sort = [ 'namespace', 'slug' ]
```

What changed:

- `[gitsheet.fields.<name>]` table moved to `[gitsheet.schema.properties.<name>]` for the `type` / `enum` / `default` fields
- Added `[gitsheet.schema]` parent with `type = 'object'` and a `required` array (recommended — be explicit about which fields are mandatory)
- Added `format = 'email'` on the email field (you can take advantage of ajv-formats now)
- `trueValues` / `falseValues` removed — these were always CSV-input coercion, not validation. See [CSV ingest](#csv-ingest-tip) below.
- `[gitsheet.fields.tags]` with `sort` is **unchanged** — canonical normalization is a separate concept that stays where it is

## Step by step

### 1. Add the `[gitsheet.schema]` table

For each sheet config:

```toml
[gitsheet.schema]
type = 'object'
required = [ ... ]  # list every field your business logic needs
additionalProperties = false  # optional — reject unknown fields
```

`required` is a hardening choice. Listing every effectively-required field gives you validation-time errors instead of runtime nulls.

### 2. Translate field configs

For each `[gitsheet.fields.<name>]` in the old config, copy its `type`, `enum`, `default` into a new `[gitsheet.schema.properties.<name>]`:

```toml
# old
[gitsheet.fields.accountLevel]
type = 'string'
enum = [ 'staff', 'member', 'guest' ]
default = 'member'

# new
[gitsheet.schema.properties.accountLevel]
type = 'string'
enum = [ 'staff', 'member', 'guest' ]
default = 'member'
```

### 3. Take advantage of JSON Schema

JSON Schema is more expressive than the legacy field config. Reasonable upgrades:

```toml
[gitsheet.schema.properties.slug]
type = 'string'
pattern = '^[a-z0-9][a-z0-9-]{1,49}$'
# → enforces slug syntax

[gitsheet.schema.properties.email]
type = 'string'
format = 'email'
# → ajv-formats validates RFC 5322

[gitsheet.schema.properties.bio]
type = 'string'
maxLength = 10000
# → caps payload size

[gitsheet.schema.properties.tags]
type = 'array'
items = { type = 'string' }
uniqueItems = true
# → reject duplicate tags
```

### 4. Keep canonical-normalization rules

`sort` rules — for byte-stable array output — stay under `[gitsheet.fields.<name>.sort]`. They're not validation, they're how the record's bytes get written.

```toml
[gitsheet.fields.tags.sort]
namespace = 'ASC'
slug = 'ASC'
```

Or the array-shorthand:

```toml
[gitsheet.fields.tags]
sort = [ 'namespace', 'slug' ]
```

Or a boolean for scalar arrays:

```toml
[gitsheet.fields.aliases]
sort = true  # locale-aware sort
```

### 5. Re-normalize existing records (optional)

If the new schema's `default` values differ from what existing records have on disk, run `gitsheets normalize <sheet>` to re-write every record through the upsert pipeline:

```bash
gitsheets normalize users --message 'apply new defaults'
```

This produces one commit containing all changed records. Records already in the new shape produce no diff (canonical normalization is idempotent).

## CSV ingest tip

The pre-v1.0 `trueValues` / `falseValues` config let your CSV files use yes/no/1/0 for boolean columns. v1.0 unbundles this from validation — bool coercion is now your responsibility at the ingest boundary.

A common pattern: write a small ingest function that coerces incoming CSV cells, then call `sheet.upsert` with the typed record.

```typescript
import { parse } from 'csv-parse/sync';
import { readFile } from 'node:fs/promises';
import { openRepo } from 'gitsheets';

function coerceBoolean(s: string): boolean {
  return ['yes', 'y', '1', 'true', 'TRUE'].includes(s);
}

const csv = await readFile('users.csv', 'utf8');
const rows = parse(csv, { columns: true });

const repo = await openRepo();
await repo.transact({ message: 'CSV import' }, async (tx) => {
  const users = tx.sheet('users');
  for (const row of rows) {
    await users.upsert({
      slug: row.slug,
      email: row.email,
      active: coerceBoolean(row.active),
    });
  }
});
```

When `gitsheets upsert --format csv` (issue [#145](https://github.com/JarvusInnovations/gitsheets/issues/145)) lands in v1.x, the CLI gets a `--coerce-boolean` style flag for this.

## Verify

After the migration, validate against the new schema by writing a representative record:

```bash
gitsheets upsert users '{"slug":"test","email":"test@x.org","accountLevel":"member"}'
```

If it commits successfully, the schema accepted it. If it throws `ValidationError`, the issues will tell you what's wrong:

```text
gitsheets: ValidationError: record failed JSON Schema validation
  code:   validation_failed
  issue:  email: must match format "email" (json-schema)
```

## See also

- [Validation](../validation.md) — full pipeline
- [`gitsheets migrate-config`](../cli.md#gitsheets-migrate-config-sheet) — the CLI command that automates this whole flow
- [`specs/behaviors/validation.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/validation.md)
- [`specs/behaviors/normalization.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/normalization.md)
