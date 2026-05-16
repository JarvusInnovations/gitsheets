# Behavior: Validation

## Rule

Records are validated on every write through two stacked layers, in order:

1. **JSON Schema** — declared in `.gitsheets/<sheet>.toml`, **persisted with the data**. Framework-agnostic. The shape contract the repo carries.
2. **Standard Schema** _(optional, consumer-supplied)_ — runs after JSON Schema, **lives in consumer code**. Adds branded types, refinements, transforms.

A failure at either layer throws `ValidationError`. Validation runs synchronously inside `Sheet.upsert` / `Sheet.patch`, before any tree mutation.

## Applies To

- [`.gitsheets/<sheet>.toml`](../concepts.md#sheet) — `[gitsheet.schema]` block
- [api/sheet.md](../api/sheet.md) — `upsert`, `patch`
- [api/repository.md](../api/repository.md) — `openSheet(name, { validator? })`
- [api/store.md](../api/store.md) — `openStore(repo, { validators? })`

## Why two layers

What gets persisted with the data vs. what lives in consumer code:

- **Persisted** — the _shape_ of records. A consumer cloning the repo without consumer code should be able to introspect what records look like.
- **Consumer-side** — _which framework_ validates them. Zod, Valibot, ArkType — application choices.

JSON Schema is the standard for "describe the shape of this data," readable by every validation framework on the planet. Standard Schema is the modern runtime interface for "call any validator framework" without coupling to one.

## Persisted format

```toml
# .gitsheets/users.toml
[gitsheet]
root = 'users'
path = '${{ slug }}'

[gitsheet.schema]
type = 'object'
required = ['slug', 'email', 'fullName']
additionalProperties = false

[gitsheet.schema.properties.slug]
type = 'string'
pattern = '^[a-z0-9][a-z0-9-]{1,49}$'

[gitsheet.schema.properties.email]
type = 'string'
format = 'email'

[gitsheet.schema.properties.fullName]
type = 'string'
minLength = 1
maxLength = 120

[gitsheet.schema.properties.bio]
type = 'string'
maxLength = 10000
```

The `[gitsheet.schema]` block IS a JSON Schema, encoded in TOML. Top-level keys map straightforwardly: `type`, `required`, `additionalProperties`, `properties.<name>`, `format`, `pattern`, `minLength`, etc.

For nested objects: `[gitsheet.schema.properties.address]` declares the address property; `[gitsheet.schema.properties.address.properties.city]` declares its nested property. Deeply nested schemas can use the JSON-file escape hatch (see below).

## TOML conventions for JSON Schema

- **Top-level table:** `[gitsheet.schema]`
- **Properties:** `[gitsheet.schema.properties.<name>]`
- **Arrays of types:** `type = ['string', 'null']` (TOML supports arrays of strings cleanly)
- **Enums:** `enum = ['draft', 'active', 'archived']`
- **`$ref`:** prefer inline definitions for record-shape schemas. For shared schemas across sheets, `$ref` to a sibling file is permitted: `$ref = './schemas/address.schema.json'` resolves relative to the `.gitsheets/<sheet>.toml`.
- **Escape hatch:** if `[gitsheet.schema]` is awkward in TOML for a complex schema, set `[gitsheet.schema]` to `{ $ref = './schemas/<sheet>.schema.json' }` and put the full schema in a JSON file alongside.

The single-TOML-file approach is the default. Use the escape hatch sparingly.

## Validation engine

- JSON Schema validation runs through **`ajv`** (or equivalent). The library configures `ajv` once per sheet with the sheet's schema compiled.
- All formats from `ajv-formats` are available: `email`, `date-time`, `uri`, `uuid`, etc.
- `strict: true` mode is enabled — unknown JSON Schema keywords produce a `ConfigError` (`config_invalid`) at sheet-open time rather than silently being ignored.

## Standard Schema layer

Consumers pass a [Standard Schema](https://standardschema.dev)–compatible validator:

```typescript
const sheet = await repo.openSheet('users', { validator: UserZodSchema });

// or via Store
const store = await openStore(repo, { validators: { users: UserZodSchema } });
```

The validator is called as:

```typescript
const result = await validator['~standard'].validate(record);
if (result.issues) { /* ValidationError */ }
else { record = result.value; }  // validator may transform
```

The transformed `result.value` (if the validator does coercion / transforms) becomes the record that gets written.

The Standard Schema layer is optional. Without it, only JSON Schema runs.

## Order

1. Record arrives at `Sheet.upsert(record)` (or `Sheet.patch(query, partial)` after the merge step).
2. JSON Schema validation. On failure: `ValidationError` with all JSON Schema issues. No transform.
3. Standard Schema validation (if configured). On failure: `ValidationError` with all Standard Schema issues. Record may be transformed.
4. Canonical normalization (see [behaviors/normalization.md](normalization.md)).
5. Path render + write.

`ValidationError.issues` combines both layers' issue arrays. Each issue's `source` field identifies which layer it came from.

## Migration of pre-v1.0 `[gitsheet.fields]` config

| Pre-v1.0 field | v1.0 placement | Notes |
|---|---|---|
| `type: 'number' \| 'string' \| 'boolean'` | `[gitsheet.schema.properties.<name>].type` | Lossless |
| `enum: [...]` | `[gitsheet.schema.properties.<name>].enum` | Lossless |
| `default: <value>` | `[gitsheet.schema.properties.<name>].default` | Lossless |
| `sort: ...` | `[gitsheet.fields.<name>.sort]` (unchanged) | Stays — different concept (canonical normalization, not validation) |
| `trueValues: [...]`, `falseValues: [...]` | Moves to CSV-ingest helper | Validation-time boolean coercion was always CSV-input-specific; surfaced separately |

The `git sheet migrate-config <sheet>` CLI command (see [api/cli.md](../api/cli.md)) performs this migration. Lossless for the first three rows; emits a warning for the fourth pointing at the CSV-ingest helper.

## Schema inference

`git sheet infer <sheet>` scans existing records and writes a starter JSON Schema:

- For each property observed, takes the union of observed types
- For string properties, conservatively _omits_ `pattern` / `format` constraints (consumer adds these manually)
- For numbers, records observed min/max as a hint
- For arrays, records the element type

Output is a starting point. The user reviews and tightens before committing.

## Implication for the typed Store

When `openStore(repo, { validators })` is called:

- Each sheet's JSON Schema runs on every write
- If `validators[sheetName]` exists, that validator runs after JSON Schema
- TypeScript types flow from the consumer's validator (Zod's `z.infer`, etc.)
- Sheets without a validator in the map type as `Sheet<Record<string, unknown>>` — JSON Schema still runs at runtime; only the TS type is loose

## Coordinates with

- [api/sheet.md](../api/sheet.md)
- [api/store.md](../api/store.md)
- [api/errors.md](../api/errors.md)
- [behaviors/normalization.md](normalization.md)
- [GitHub #130](https://github.com/JarvusInnovations/gitsheets/issues/130) — the implementation issue
- [GitHub #136](https://github.com/JarvusInnovations/gitsheets/issues/136) — the error taxonomy
