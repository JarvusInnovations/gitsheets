# Request-bound transactions

Pattern: **one HTTP request → one git commit**, with the request's metadata captured as structured trailers. Every mutation in the request commits atomically with a fully traceable author + action + subject + request-context trailers, so the commit log doubles as the audit log.

Example uses Fastify, but the pattern works identically with Koa, Express, Hono, or any HTTP layer.

## Why this pattern

Every commit produced by `repo.transact` carries:

- **Author** (the actor — who did this)
- **Subject line** (what they did)
- **Trailers** (structured key-value metadata: action, subject ID, request context)

These show up in `git log --format=fuller` and parse with `git interpret-trailers`. The result: `git log --grep='^Action: user.create$'` answers "every user creation," `git log --author=jane@x.org` answers "every action jane took," and `git log -- users/janedoe.toml` answers "every change to this record."

You don't need an audit table.

## Set up

```bash
npm install gitsheets zod fastify @fastify/cookie
```

`.gitsheets/users.toml`:

```toml
[gitsheet]
root = 'users'
path = '${{ slug }}'

[gitsheet.schema]
type = 'object'
required = ['slug', 'email']

[gitsheet.schema.properties.slug]
type = 'string'

[gitsheet.schema.properties.email]
type = 'string'
format = 'email'

[gitsheet.schema.properties.fullName]
type = 'string'
```

## Hold the store at app startup

```typescript
// src/store.ts
import { openRepo, openStore } from 'gitsheets';
import { z } from 'zod';

const UserSchema = z.object({
  slug: z.string(),
  email: z.string().email(),
  fullName: z.string().optional(),
});

const ProjectSchema = z.object({
  slug: z.string(),
  title: z.string(),
});

const MembershipSchema = z.object({
  userSlug: z.string(),
  projectSlug: z.string(),
});

const repo = await openRepo();
export const store = await openStore(repo, {
  validators: {
    users: UserSchema,
    projects: ProjectSchema,
    memberships: MembershipSchema,
  },
});
```

## Optional: start a push daemon

If you want commits auto-pushed to a remote (CD pipeline, replica), wire one up at boot. See [production push daemon](production-push-daemon.md) for the full story.

```typescript
// src/store.ts (continued)
import { repo } from './store.js';

if (process.env.NODE_ENV === 'production') {
  const daemon = await repo.startPushDaemon({ remote: 'origin' });
  daemon.on('error', ({ err, attempt }) =>
    console.error('[push-daemon]', err, 'attempt', attempt),
  );
}
```

## The handler pattern

```typescript
// src/routes/users.ts
import { FastifyInstance } from 'fastify';
import { ValidationError, NotFoundError } from 'gitsheets';
import { store } from '../store.js';

export async function userRoutes(app: FastifyInstance) {
  app.post('/api/users', async (req, reply) => {
    const actor = req.session.actor;  // your auth layer
    const body = req.body as { slug: string; email: string; fullName?: string };

    try {
      const result = await store.transact(
        {
          message: `${actor.slug}: POST /api/users`,
          author: { name: actor.fullName, email: actor.email },
          trailers: {
            // semantic trailers — describe the action
            Action: 'user.create',
            'Subject-Slug': body.slug,
            'Actor-Slug': actor.slug,
            // request-context trailers — describe the request
            Host: req.headers.host ?? '',
            'User-Agent': req.headers['user-agent'] ?? '',
            'User-Ip': req.ip,
            'Response-Code': '201',
          },
        },
        async (tx) => {
          return tx.users.upsert(body);
        },
      );

      reply.code(201);
      return { ok: true, commit: result.commitHash, path: result.value.path };
    } catch (err) {
      if (err instanceof ValidationError) {
        reply.code(422);
        return { error: 'validation_failed', issues: err.issues };
      }
      if (err instanceof NotFoundError) {
        reply.code(404);
        return { error: err.code, message: err.message };
      }
      throw err;
    }
  });
}
```

What this commit looks like in `git log`:

```text
commit 9a3f...
Author: Jane Doe <jane@x.org>

    jane: POST /api/users

    Action: user.create
    Subject-Slug: bobsmith
    Actor-Slug: jane
    Host: api.example.com
    User-Agent: curl/8.4.0
    User-Ip: 192.0.2.1
    Response-Code: 201
```

## Multi-mutation handlers

The transaction's atomicity makes multi-sheet changes safe:

```typescript
app.delete('/api/projects/:slug', async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const actor = req.session.actor;

  const result = await store.transact(
    {
      message: `${actor.slug}: DELETE /api/projects/${slug}`,
      author: { name: actor.fullName, email: actor.email },
      trailers: {
        Action: 'project.delete',
        'Subject-Slug': slug,
        'Actor-Slug': actor.slug,
      },
    },
    async (tx) => {
      // delete the project
      await tx.projects.delete({ slug });

      // delete all memberships for that project
      for await (const m of tx.memberships.query({ projectSlug: slug })) {
        await tx.memberships.delete(m);
      }

      return { deletedProject: slug };
    },
  );

  // If anything in the handler throws, no commit happens — the project,
  // memberships, and any other affected sheets all stay as they were.
  return { ok: true, commit: result.commitHash };
});
```

Mid-handler throws roll back the whole tree. Half-applied state never lands.

## Error → response mapping

Map gitsheets's typed errors to HTTP status codes. The error classes carry a `status` field that's already the right HTTP status hint:

```typescript
import { GitsheetsError } from 'gitsheets';

app.setErrorHandler((err, req, reply) => {
  if (err instanceof GitsheetsError) {
    reply.code(err.status);
    return { error: err.code, message: err.message };
  }
  // ... your other error handling
});
```

For richer responses, switch on the class:

```typescript
if (err instanceof ValidationError) { /* return 422 with err.issues */ }
if (err instanceof NotFoundError)   { /* return 404 */ }
if (err instanceof TransactionError && err.code === 'parent_moved') {
  // Optimistic concurrency: a parallel commit landed first. Retry.
}
```

## Concurrency

The Repository's mutex serializes transactions: under load, concurrent `POST /api/users` requests queue. The mutex is FIFO and fast — each transaction is just an in-memory tree mutation + a `git commit-tree` exec. Throughput is bounded by `git commit-tree` (a few ms per call on a typical workstation).

If a request needs to do a long-running operation (HTTP fetch, image processing), do that *before* opening the transaction. The transaction's handler should be quick — every other request is queued behind it.

```typescript
app.post('/api/users', async (req, reply) => {
  // Slow work outside the tx
  const enrichedFields = await enrichFromExternalAPI(req.body);

  // Fast write inside the tx
  await store.transact({ ... }, async (tx) => {
    await tx.users.upsert({ ...req.body, ...enrichedFields });
  });
});
```

## Optimistic concurrency

If another process commits to the same branch between your transaction's start and commit, `repo.transact` throws `TransactionError('parent_moved')`. Typical handling: retry once.

```typescript
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (
        err instanceof TransactionError &&
        err.code === 'parent_moved' &&
        attempt < 3
      ) {
        continue;
      }
      throw err;
    }
  }
}

app.post('/api/users', async (req, reply) => {
  await withRetry(() => store.transact({ ... }, async (tx) => { ... }));
});
```

This is only useful when multiple processes write the same repo. For a single-process consumer, the in-process mutex already serializes you.

## Trailer conventions

Two kinds of trailers, both useful:

**Semantic** (describes the action):

- `Action` — dotted action name (`user.create`, `project.soft-delete`)
- `Subject-Type` — entity type
- `Subject-Id` / `Subject-Slug` — entity reference
- `Actor-Slug` / `Actor-Account-Level` — actor's identity
- `Reason` — free-form rationale (e.g., `spam policy violation`)

**Request context** (describes the HTTP request):

- `Host`
- `User-Agent`
- `User-Ip`
- `Content-Type`
- `Response-Code`

Keys must be HTTP-header style: `Capital-Then-Lowercase`. Multi-word hyphenated. The library validates this at transaction-open time; bad keys throw `TransactionError('commit_failed')` before any I/O.

## See also

- [Concepts: Transaction](../concepts.md#transaction)
- [`specs/behaviors/transactions.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/transactions.md) — trailer + author resolution rules
- [Typed sheet with Zod](typed-sheet-with-zod.md)
- [Production push daemon](production-push-daemon.md)
