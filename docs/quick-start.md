# Quick start

Fresh TypeScript project to a typed write in ≤5 minutes.

## Install

```bash
mkdir my-data && cd my-data
git init -b main
npm init -y
npm install gitsheets zod
```

## Declare a sheet

Create `.gitsheets/users.toml`:

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
```

Commit it so gitsheets sees it:

```bash
git add .gitsheets/
git commit -m "add users sheet"
```

## Write your first record

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

await store.transact(
  {
    message: 'janedoe: POST /api/users',
    author: { name: 'Jane Doe', email: 'jane@x.org' },
    trailers: { Action: 'user.create' },
  },
  async (tx) => {
    await tx.users.upsert({ slug: 'janedoe', email: 'jane@x.org' });
  },
);
```

That produces a commit on the current branch:

```bash
git log -1 --format=fuller
```

## Read it back

```typescript
const jane = await store.users.queryFirst({ slug: 'janedoe' });
// jane is z.infer<typeof UserSchema> | undefined
```

## What just happened

1. `openStore` discovered the `users` sheet from `.gitsheets/`.
2. `tx.users.upsert(...)` validated the record against the persisted JSON
   Schema and the Zod schema, applied canonical normalization, rendered the
   path `users/janedoe.toml`, and staged the write.
3. `store.transact` committed the staged tree with your message, author, and
   trailers, and advanced `main` to the new commit.

See [`docs/cli.md`](cli.md) for the shell-side surface or the
[`specs/`](https://github.com/JarvusInnovations/gitsheets/tree/develop/specs)
directory for the full contract.
