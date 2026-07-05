// End-to-end tests for null/undefined handling on write (#232) — the
// specs/behaviors/normalization.md "Null / undefined handling" contract at the
// package layer.
//
// The real-world consumer shape this protects: optional fields modeled as
// `.nullable().optional()` (Zod/Valibot/…) with a `?? null` normalization at
// the write boundary. 1.x (@iarna/toml) silently dropped null-valued keys at
// serialize time; the Rust-core cutover initially threw on them; the specced
// behavior is the 1.x drop — an absent optional field IS an absent key.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ValidationError } from './errors.js';
import { openRepo } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';
import { type StandardSchemaV1 } from './validation.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

const PEOPLE_CONFIG = `[gitsheet]
root = 'people'
path = '\${{ slug }}'

[gitsheet.schema]
type = 'object'
required = ['slug']

[gitsheet.schema.properties.slug]
type = 'string'

[gitsheet.schema.properties.middleName]
type = ['string', 'null']

[gitsheet.schema.properties.bio]
type = ['string', 'null']
`;

async function seededRepo(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'people.toml'), PEOPLE_CONFIG);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add people sheet');
  return fixture;
}

/**
 * A Standard Schema validator mimicking the `.nullable().optional()` +
 * `?? null` pattern: every cleared optional field is normalized to an explicit
 * `null` on the validated output — exactly what Zod's
 * `z.string().nullable().optional().transform((v) => v ?? null)` (or a manual
 * write-boundary `?? null`) produces.
 */
const nullNormalizingValidator: StandardSchemaV1<unknown, Record<string, unknown>> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value: unknown) {
      const v = value as Record<string, unknown>;
      return {
        value: {
          ...v,
          middleName: v['middleName'] ?? null,
          bio: v['bio'] ?? null,
        },
      };
    },
  },
};

describe('null/undefined-valued keys on write (#232)', () => {
  it('a Standard Schema validator emitting nulls for cleared optionals writes cleanly, with no trace in the bytes', async () => {
    const fixture = await seededRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    // 2.x initially threw here ("cannot marshal JS value of type Null").
    const sheet = await repo.openSheet('people', { validator: nullNormalizingValidator });
    await sheet.upsert({ slug: 'jane', middleName: undefined });

    // Read back: the cleared optionals are absent keys, not nulls. (Records
    // carry non-enumerable-ish symbol metadata; compare string keys.)
    const fresh = await repo.openSheet('people');
    const found = await fresh.queryFirst({ slug: 'jane' });
    expect(found).toMatchObject({ slug: 'jane' });
    expect(Object.keys(found ?? {})).toEqual(['slug']);
    expect(found?.['middleName']).toBeUndefined();

    // The on-disk bytes carry no trace — what 1.x @iarna/toml produced.
    const { stdout: bytes } = await fixture.git('cat-file', 'blob', 'HEAD:people/jane.toml');
    expect(bytes).toBe('slug = "jane"\n');
  });

  it('writing the null-cleared record over the stripped record is a byte-level no-op (no new commit)', async () => {
    const fixture = await seededRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    // First write: the record with the optionals simply never set.
    const first = await repo.transact({ message: 'stripped' }, async (tx) =>
      tx.sheet('people').upsert({ slug: 'jane', bio: 'hi' }),
    );
    expect(first.commitHash).toMatch(/^[0-9a-f]{40}$/);

    // Second write: logically the same record, but with cleared optionals as
    // explicit nulls. Byte-identical canonical output ⇒ no-op transaction.
    const second = await repo.transact({ message: 'null-cleared' }, async (tx) =>
      tx.sheet('people').upsert({ slug: 'jane', bio: 'hi', middleName: null }),
    );
    expect(second.commitHash).toBeNull();
  });

  it('drops nullish keys recursively: nested tables and objects inside arrays', async () => {
    const fixture = await seededRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'nested' }, async (tx) =>
      tx.sheet('people').upsert({
        slug: 'nested',
        contact: { email: 'n@x.org', phone: null },
        roles: [{ title: 'chair', until: null }, { title: 'member' }],
      }),
    );

    const sheet = await repo.openSheet('people');
    const found = await sheet.queryFirst({ slug: 'nested' });
    expect(found).toMatchObject({
      slug: 'nested',
      contact: { email: 'n@x.org' },
      roles: [{ title: 'chair' }, { title: 'member' }],
    });
    expect(Object.keys(found?.['contact'] as object)).toEqual(['email']);
    expect(Object.keys((found?.['roles'] as object[])[0]!)).toEqual(['title']);

    const { stdout: bytes } = await fixture.git('cat-file', 'blob', 'HEAD:people/nested.toml');
    expect(bytes).not.toContain('phone');
    expect(bytes).not.toContain('until');
  });

  it('a required field set to null fails validation as missing (absent == null)', async () => {
    const fixture = await seededRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    try {
      await repo.transact({ message: 'bad' }, async (tx) =>
        tx.sheet('people').upsert({ slug: null, bio: 'x' } as never),
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      // The null-valued required key was dropped before validation, so the
      // failure is "missing required property" — not a type error on null.
      expect(ve.issues.some((i) => /required/i.test(i.message))).toBe(true);
    }
  });

  it('a null array ELEMENT is rejected with the index named (not silently dropped)', async () => {
    const fixture = await seededRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const headBefore = await repo.resolveRef('HEAD');
    await expect(
      repo.transact({ message: 'bad' }, async (tx) =>
        tx.sheet('people').upsert({ slug: 'holes', tags: ['a', null, 'c'] }),
      ),
    ).rejects.toThrow(/array element \(index 1\)/);

    // No tree mutation happened.
    expect(await repo.resolveRef('HEAD')).toBe(headBefore);
  });
});
