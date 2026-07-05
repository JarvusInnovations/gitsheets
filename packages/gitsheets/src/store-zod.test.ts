// Zod v4 ↔ Standard Schema typing contract (#237).
//
// The COMPILATION of this file is the type-level regression test: real Zod v4
// schemas must assign to gitsheets' StandardSchemaV1 / ValidatorMap / the
// openStore + openSheet option types with NO `as` casts. If a change to the
// declared Standard Schema types breaks spec-compliant assignability, this
// file fails `tsc --noEmit` (and vitest's transform). The runtime half proves
// the same schemas validate / transform / reject end-to-end.
//
// See specs/behaviors/validation.md#type-level-contract-no-casts-required.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { ValidationError } from './errors.js';
import { openRepo, type Repository } from './repository.js';
import { openStore, type InferRecord, type ValidatorMap } from './store.js';
import type { StandardSchemaV1 } from './validation.js';

const handles: Array<{ cleanup: () => Promise<void> }> = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

const UserSchema = z.object({
  slug: z.string(),
  email: z.string(),
  displayName: z.string().default('Anonymous'),
});
type User = z.output<typeof UserSchema>;

// --- Type-level assertions (checked at compile time) ---

// 1. A Zod v4 schema IS a gitsheets StandardSchemaV1 — direct assignment, no cast.
const asStandard: StandardSchemaV1<unknown, User> = UserSchema;
void asStandard;

// 2. A map of Zod schemas satisfies ValidatorMap — the openStore validators shape.
const validators = { users: UserSchema } satisfies ValidatorMap;

// 3. InferRecord recovers the Zod OUTPUT type (post-transform/default).
expectTypeOf<InferRecord<typeof UserSchema>>().toEqualTypeOf<User>();

// --- Runtime fixture ---

const USERS = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

async function seededRepo(): Promise<Repository> {
  const { testRepo } = await import('./test-helpers/test-repo.js');
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users sheet');
  return openRepo({ gitDir: fixture.gitDir });
}

describe('Zod v4 schemas as gitsheets validators (#237)', () => {
  it('openStore accepts Zod validators with no cast and types flow through', async () => {
    const repo = await seededRepo();
    const store = await openStore(repo, { validators });

    await store.transact({ message: 'add jane' }, async (tx) => {
      await tx.users.upsert({ slug: 'jane', email: 'jane@x.org', displayName: 'Jane' });
    });

    const fresh = await openStore(repo, { validators });
    const jane = await fresh.users.queryFirst({ slug: 'jane' });
    expectTypeOf(jane).toEqualTypeOf<User | undefined>();
    expect(jane).toMatchObject({ slug: 'jane', email: 'jane@x.org' });
  });

  it('openSheet accepts a Zod validator with no cast', async () => {
    const repo = await seededRepo();
    const users = await repo.openSheet('users', { validator: UserSchema });
    await users.upsert({ slug: 'zed', email: 'zed@x.org', displayName: 'Zed' });

    const fresh = await repo.openSheet('users', { validator: UserSchema });
    const zed = await fresh.queryFirst({ slug: 'zed' });
    expect(zed).toMatchObject({ slug: 'zed' });
  });

  it('Zod transforms (defaults) are reflected in the written record', async () => {
    const repo = await seededRepo();
    const store = await openStore(repo, { validators });

    await store.transact({ message: 'defaulted' }, async (tx) => {
      // displayName omitted — Zod's .default() fills it during validation.
      // Sheet<T> is typed on the validator's OUTPUT; passing the pre-transform
      // input shape is runtime-supported but needs an explicit widening here.
      const input: z.input<typeof UserSchema> = { slug: 'anon', email: 'anon@x.org' };
      await tx.users.upsert(input as User);
    });

    const fresh = await openStore(repo, { validators });
    const anon = await fresh.users.queryFirst({ slug: 'anon' });
    expect(anon?.displayName).toBe('Anonymous');
  });

  it('Zod rejections surface as ValidationError with standard-schema issues', async () => {
    const repo = await seededRepo();
    const store = await openStore(repo, { validators });

    const err = await store
      .transact({ message: 'bad' }, async (tx) => {
        await tx.users.upsert({ slug: 'bad', email: 123 as unknown as string, displayName: 'x' });
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    const issues = (err as ValidationError).issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.source).toBe('standard-schema');
    expect(issues[0]!.path).toEqual(['email']);
  });
});
