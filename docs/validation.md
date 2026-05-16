# Validation

Records are validated on every write through two stacked layers, in order:

1. **JSON Schema** — declared in `.gitsheets/<sheet>.toml`, **persisted with the data**. Framework-agnostic. The shape contract the repo carries.
2. **Standard Schema** *(optional, consumer-supplied)* — runs after JSON Schema, **lives in consumer code**. Adds branded types, refinements, transforms.

A failure at either layer throws `ValidationError` with all issues from the failing layer. Validation runs synchronously inside `Sheet.upsert` / `Sheet.patch`, before any tree mutation.

## Why two layers

What gets persisted with the data vs. what lives in consumer code:

- **Persisted** — the *shape* of records. A consumer cloning the repo without consumer code should be able to introspect what records look like.
- **Consumer-side** — *which framework* validates them. Zod, Valibot, ArkType, Effect Schema — application choices.

JSON Schema is the standard for "describe the shape of this data," readable by every validation framework on the planet. [Standard Schema](https://standardschema.dev) is the modern runtime interface for "call any validator framework" without coupling to one.

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

The `[gitsheet.schema]` block **is** a JSON Schema, encoded in TOML. Top-level keys map straightforwardly: `type`, `required`, `additionalProperties`, `properties.<name>`, `format`, `pattern`, `minLength`, etc.

For nested objects: `[gitsheet.schema.properties.address]` declares the address property; `[gitsheet.schema.properties.address.properties.city]` declares its nested property.

### TOML conventions for JSON Schema

- **Top-level:** `[gitsheet.schema]`
- **Properties:** `[gitsheet.schema.properties.<name>]`
- **Arrays of types:** `type = ['string', 'null']`
- **Enums:** `enum = ['draft', 'active', 'archived']`
- **`$ref`:** prefer inline definitions for record-shape schemas. For shared schemas across sheets, `$ref = './schemas/address.schema.json'` resolves relative to the sheet's config file.
- **Escape hatch:** for deeply nested schemas that get awkward in TOML, set `[gitsheet.schema] = { $ref = './schemas/<sheet>.schema.json' }` and put the full schema in a JSON file alongside.

The single-TOML-file approach is the default. Use the JSON-file escape hatch sparingly.

## Validation engine

- **`ajv`** in `strict: true` mode. Unknown JSON Schema keywords produce a `ConfigError(config_invalid)` at sheet-open time rather than silently being ignored.
- All formats from `ajv-formats` are available: `email`, `date-time`, `uri`, `uuid`, `ipv4`, `ipv6`, etc.
- **`$data` references are disabled** in v1.0. A `[gitsheet.schema]` block containing `$data` fails to compile with `ConfigError(config_invalid)`.

Compiled validators are cached per schema-object identity, so repeated reads of the same sheet config hit the cache.

## Standard Schema layer

Consumers pass any [Standard Schema](https://standardschema.dev)–compatible validator:

```typescript
import { openRepo } from 'gitsheets';
import { z } from 'zod';

const UserSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  email: z.string().email().transform((s) => s.toLowerCase()),
  fullName: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

const repo = await openRepo();
const users = await repo.openSheet('users', { validator: UserSchema });

// Standard Schema's transform fires after JSON Schema passes — the email
// gets lowercased before the record is normalized and written.
await users.upsert({ slug: 'jane', email: 'Jane@X.ORG' });
//                                          ↑ written as 'jane@x.org'
```

Internally the library calls `validator['~standard'].validate(record)`. The returned `result.value` (if the validator transforms) becomes the record that gets normalized + written.

The Standard Schema layer is **optional**. Without it, only JSON Schema runs.

For full type inference across reads and writes, use [`openStore`](concepts.md#store) instead of `openSheet` — see the [typed-sheet-with-Zod recipe](recipes/typed-sheet-with-zod.md).

## Order of operations

```text
1. Record arrives at Sheet.upsert(record) / Sheet.patch(query, partial)
2. JSON Schema validation
   ↳ on failure: ValidationError { issues: [{source: 'json-schema', ...}] }
3. Standard Schema validation (if configured)
   ↳ on failure: ValidationError { issues: [{source: 'standard-schema', ...}] }
   ↳ on success: record may be transformed
4. Canonical normalization (deep key sort, array sort rules)
5. Path render + write
```

Validation **short-circuits**: if JSON Schema fails, Standard Schema doesn't run, so a thrown `ValidationError` contains issues from the failing layer only. Use the `source` field on each issue to distinguish them.

## Error shape

```typescript
try {
  await sheet.upsert({ slug: 'Bad Slug!', email: 'not-an-email' });
} catch (err) {
  if (err instanceof ValidationError) {
    for (const issue of err.issues) {
      console.error(`${issue.path.join('.')}: ${issue.message} (${issue.source})`);
    }
    // slug: must match pattern "^[a-z0-9-]+$" (json-schema)
    // email: must match format "email" (json-schema)
  }
}
```

```typescript
interface ValidationIssue {
  readonly path: string[];          // e.g., ['email'] or ['address', 'city']
  readonly message: string;         // human-readable
  readonly source: 'json-schema' | 'standard-schema';
  readonly schemaPath?: string;     // JSON Schema pointer when source === 'json-schema'
  readonly code?: string;           // schema-keyword name ('required', 'pattern', ...)
}
```

## Migrating from a pre-v1.0 `[gitsheet.fields]` config

| Pre-v1.0 field config | v1.0 placement |
| --- | --- |
| `type: 'number' \| 'string' \| 'boolean'` | `[gitsheet.schema.properties.<name>].type` |
| `enum: [...]` | `[gitsheet.schema.properties.<name>].enum` |
| `default: <value>` | `[gitsheet.schema.properties.<name>].default` |
| `sort: ...` | `[gitsheet.fields.<name>.sort]` (unchanged — different concept) |
| `trueValues` / `falseValues` | Out of scope for the validation layer — `gitsheets migrate-config` emits a warning; CSV-input boolean coercion stays a consumer concern |

See the [migrating-config recipe](recipes/migrating-config.md) for a worked example.

## Practical notes

- **Validate on read?** No. Reads return whatever's on disk. If on-disk records pre-date a schema tightening, your reads can return records that wouldn't pass current validation. Use `git sheet normalize` to re-check the whole sheet, or write your own audit pass.
- **Validate inside `tx.sheet(name)`?** Yes — every write inside a transaction runs the same pipeline. The Standard Schema layer only attaches to `Sheet` instances opened with a validator; inside `repo.transact`'s handler, `tx.sheet(name)` returns un-validated Sheets unless threaded through `openStore` (where `store.transact` carries validators into the tx).
- **Validate before writing externally?** Yes — `validateRecord({ record, schema, validator })` is exported, so consumers building UI forms or import pipelines can pre-flight records against the same pipeline.

## See also

- [`specs/behaviors/validation.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/validation.md) — authoritative spec
- [Typed sheet with Zod](recipes/typed-sheet-with-zod.md) — end-to-end Standard Schema usage
- [`specs/api/errors.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/errors.md) — error class hierarchy
