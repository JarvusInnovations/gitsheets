# Typed sheet with Zod

End-to-end TypeScript ergonomics: declare records as Zod schemas, get full type inference through reads and writes.

## What you'll build

A `users` sheet whose records are typed against a Zod schema. Zod's `transform` runs on every write (lower-casing the email). Reads return the inferred type with no casting.

## Install

```bash
mkdir my-data && cd my-data
git init -b main
npm init -y
npm install gitsheets zod
```

## Declare the sheet

`.gitsheets/users.toml`:

```toml
[gitsheet]
root = 'users'
path = '${{ slug }}'

[gitsheet.schema]
type = 'object'
required = ['slug', 'email']
additionalProperties = false

[gitsheet.schema.properties.slug]
type = 'string'
pattern = '^[a-z0-9-]+$'

[gitsheet.schema.properties.email]
type = 'string'
format = 'email'

[gitsheet.schema.properties.fullName]
type = 'string'

[gitsheet.schema.properties.tags]
type = 'array'
items = { type = 'string' }
```

Commit the config so gitsheets sees it:

```bash
git add .gitsheets/
git commit -m "add users sheet"
```

The JSON Schema in the TOML is what travels with the repo. Anyone (or anything) reading the repo without your TS code can introspect it.

## Define the Zod schema

`src/schemas.ts`:

```typescript
import { z } from 'zod';

export const UserSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  email: z.string().email().transform((s) => s.toLowerCase()),
  fullName: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export type User = z.infer<typeof UserSchema>;
```

The transform lower-cases the email before it's written. Defaults apply when the field is absent.

## Open the store

`src/store.ts`:

```typescript
import { openRepo, openStore } from 'gitsheets';
import { UserSchema } from './schemas.js';

export async function makeStore() {
  const repo = await openRepo();
  return openStore(repo, {
    validators: { users: UserSchema },
  });
}
```

`openStore` discovers every `.gitsheets/<sheet>.toml` and binds the consumer-supplied validators by sheet name.

## Write a record

```typescript
const store = await makeStore();

await store.transact(
  {
    message: 'create jane',
    author: { name: 'Admin', email: 'admin@example.com' },
  },
  async (tx) => {
    await tx.users.upsert({
      slug: 'jane',
      email: 'Jane@X.ORG',          // ← Zod lower-cases this
      fullName: 'Jane Doe',
      // tags omitted → defaults to []
    });
  },
);
```

Type-check confirms:

```typescript
await tx.users.upsert({
  slug: 'jane',
  email: 'jane@x.org',
  wat: 'huh?',  // ← TS error: 'wat' not in User
});
```

The validators map is the source of type truth for `store.users.upsert`.

## Read records

```typescript
const jane = await store.users.queryFirst({ slug: 'jane' });
// jane: User | undefined

if (jane) {
  console.log(jane.fullName, jane.email);
  // jane.email is typed as string
  // jane.unknownField is a TS error
}
```

Same for `queryAll`:

```typescript
const all = await store.users.queryAll();
// all: User[]
```

And the iterator:

```typescript
for await (const user of store.users.query({ slug: 'jane' })) {
  // user: User
}
```

## Filter narrows to keyof T

```typescript
await store.users.queryAll({
  email: 'jane@x.org',           // ok
  unknownField: 'something',     // ← TS error
});
```

## Function predicates

For sub-queries the path-template can't prune:

```typescript
const recent = await store.users.queryAll({
  fullName: (value) => typeof value === 'string' && value.startsWith('J'),
});
```

The predicate type narrows: `value` is typed as the field's type, `record` as `User`.

## Patch existing records

```typescript
await store.transact({ message: 'fix jane' }, async (tx) => {
  await tx.users.patch(
    { slug: 'jane' },
    { fullName: 'Jane O. Doe', tags: ['admin'] },
  );
});
```

RFC 7396 semantics: `null` deletes, arrays replace, objects merge. The `partial` argument is `Partial<User>`.

## Sheets without validators

`openStore`'s typed surface only includes sheets named in `validators`. To access a sheet without a validator, drop down to `repo.openSheet(name)`:

```typescript
const adhoc = await repo.openSheet('rare-events');  // Sheet<Record<string, unknown>>
```

The persisted JSON Schema in `.gitsheets/rare-events.toml` still runs at runtime — only the TS-level shape is loose.

## See it on disk

```bash
ls users/
# jane.toml

cat users/jane.toml
```

```toml
email = 'jane@x.org'
fullName = 'Jane Doe'
slug = 'jane'
tags = [ ]
```

Keys sorted (canonical normalization), email lower-cased (Zod transform), `tags` defaulted to empty.

```bash
git log --format=fuller
```

The commit carries the author, message, and timestamp. Validation failures wouldn't have produced a commit at all.

## Validation errors

```typescript
try {
  await store.transact({ message: 'bad' }, async (tx) => {
    await tx.users.upsert({ slug: 'Jane Doe!', email: 'not-an-email' });
  });
} catch (err) {
  if (err instanceof ValidationError) {
    for (const issue of err.issues) {
      console.error(`${issue.path.join('.')}: ${issue.message}`);
      // slug: must match pattern "^[a-z0-9-]+$"  (json-schema)
      // email: must match format "email"          (json-schema)
    }
  }
}
```

JSON Schema runs first — Zod doesn't even see this record. If JSON Schema had passed and Zod rejected, the error would carry `source: 'standard-schema'` issues.

## See also

- [Validation](../validation.md) — the full pipeline
- [Concepts: Store](../concepts.md#store)
- [`specs/api/store.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/store.md)
