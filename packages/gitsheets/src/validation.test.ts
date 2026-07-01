import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError, ValidationError } from './errors.js';
import { openRepo } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';
import {
  validateRecord,
  type StandardSchemaV1,
} from './validation.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

async function makeRepo(): Promise<TestRepoHandle> {
  const h = await testRepo({ withInitialCommit: true });
  handles.push(h);
  return h;
}

async function seedSheetConfig(fixture: TestRepoHandle, name: string, toml: string): Promise<void> {
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', `${name}.toml`), toml);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', `add ${name} sheet`);
}

describe('validateRecord (JSON Schema layer)', () => {
  it('passes when the record satisfies the schema', async () => {
    const out = await validateRecord({
      record: { slug: 'janedoe', email: 'jane@example.com' },
      schema: {
        type: 'object',
        required: ['slug', 'email'],
        properties: {
          slug: { type: 'string', pattern: '^[a-z0-9-]+$' },
          email: { type: 'string', format: 'email' },
        },
      },
      schemaSourcePath: '<test>',
    });
    expect(out).toEqual({ slug: 'janedoe', email: 'jane@example.com' });
  });

  it('throws ValidationError when required fields are missing', async () => {
    await expect(
      validateRecord({
        record: { slug: 'janedoe' },
        schema: {
          type: 'object',
          required: ['slug', 'email'],
          properties: { slug: { type: 'string' }, email: { type: 'string' } },
        },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('reports issues with structured ValidationIssue entries', async () => {
    try {
      await validateRecord({
        record: { slug: 'janedoe', email: 'not-an-email' },
        schema: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            email: { type: 'string', format: 'email' },
          },
        },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.code).toBe('validation_failed');
      expect(ve.issues.length).toBeGreaterThan(0);
      const emailIssue = ve.issues.find((i) => i.path.includes('email'));
      expect(emailIssue?.source).toBe('json-schema');
    }
  });

  it('ignores unknown JSON-Schema keywords (core lenient vs former ajv strict)', async () => {
    // Enumerated divergence: the former ajv pass ran `strict: true` and rejected
    // unknown keywords at compile with ConfigError(config_invalid). The core's
    // `jsonschema` crate is lenient — a typo'd/unknown keyword is silently
    // ignored, so the schema compiles and the record validates. See
    // specs/behaviors/validation.md and the node-binding-thin plan Notes.
    const out = await validateRecord({
      record: { x: 1 },
      schema: { type: 'object', frobnicate: true },
      schemaSourcePath: '.gitsheets/test.toml',
    });
    expect(out).toEqual({ x: 1 });
  });

  it('skips JSON Schema when schema is null', async () => {
    const out = await validateRecord({
      record: { whatever: 'goes' },
      schema: null,
    });
    expect(out).toEqual({ whatever: 'goes' });
  });
});

// --- Standard Schema layer ---

function makeStandardSchema<O extends Record<string, unknown> = Record<string, unknown>>(
  validate: (value: unknown) => { value: O } | { issues: Array<{ message: string; path?: string[] }> },
): StandardSchemaV1<unknown, O> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        return validate(value);
      },
    },
  };
}

describe('validateRecord (Standard Schema layer)', () => {
  it('runs after JSON Schema and can transform the record', async () => {
    const out = await validateRecord({
      record: { slug: 'JANEDOE' },
      schema: { type: 'object', properties: { slug: { type: 'string' } } },
      validator: makeStandardSchema((value) => ({
        value: {
          ...(value as Record<string, unknown>),
          slug: ((value as Record<string, unknown>)['slug'] as string).toLowerCase(),
        },
      })),
    });
    expect(out).toEqual({ slug: 'janedoe' });
  });

  it('throws ValidationError with standard-schema issues on failure', async () => {
    try {
      await validateRecord({
        record: { slug: 'x' },
        schema: null,
        validator: makeStandardSchema(() => ({
          issues: [{ message: 'slug too short', path: ['slug'] }],
        })),
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.issues[0]?.source).toBe('standard-schema');
      expect(ve.issues[0]?.path).toEqual(['slug']);
      expect(ve.issues[0]?.message).toBe('slug too short');
    }
  });

  it('skips Standard Schema when no validator is provided', async () => {
    const out = await validateRecord({ record: { x: 1 }, schema: null });
    expect(out).toEqual({ x: 1 });
  });
});

// --- End-to-end: schema in config blocks bad writes ---

const USERS_WITH_SCHEMA = `[gitsheet]
root = 'users'
path = '\${{ slug }}'

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
`;

describe('Sheet.upsert with [gitsheet.schema]', () => {
  it('blocks an invalid record before any tree mutation', async () => {
    const fixture = await makeRepo();
    await seedSheetConfig(fixture, 'users', USERS_WITH_SCHEMA);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const headBefore = await repo.resolveRef('HEAD');

    await expect(
      repo.transact({ message: 'invalid' }, async (tx) =>
        tx.sheet('users').upsert({ slug: 'bad slug!', email: 'jane@x.org' }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    const headAfter = await repo.resolveRef('HEAD');
    expect(headAfter).toBe(headBefore);
  });

  it('accepts a record that passes the schema', async () => {
    const fixture = await makeRepo();
    await seedSheetConfig(fixture, 'users', USERS_WITH_SCHEMA);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const r = await repo.transact({ message: 'valid' }, async (tx) =>
      tx.sheet('users').upsert({ slug: 'janedoe', email: 'jane@x.org' }),
    );
    expect(r.commitHash).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('openSheet({ validator })', () => {
  it('runs the Standard Schema after JSON Schema on writes', async () => {
    const fixture = await makeRepo();
    await seedSheetConfig(fixture, 'users', USERS_WITH_SCHEMA);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const downcaseEmail = makeStandardSchema<Record<string, unknown>>((value) => {
      const v = value as Record<string, unknown>;
      return {
        value: { ...v, email: (v['email'] as string).toLowerCase() } as Record<string, unknown>,
      };
    });

    // openSheet validator only attaches to the standalone Sheet; the tx-bound
    // Sheet (used inside repo.transact's handler) doesn't inherit it in v1.0
    // — Store will add validator threading later. This test verifies the
    // standalone (permissive) write path uses the validator.
    const sheet = await repo.openSheet('users', { validator: downcaseEmail });
    await sheet.upsert({ slug: 'mixedcase', email: 'JANE@X.ORG' });

    const fresh = await repo.openSheet('users');
    const found = await fresh.queryFirst({ slug: 'mixedcase' });
    expect(found?.['email']).toBe('jane@x.org');
  });

  it('reports Standard Schema failures alongside any JSON Schema issues', async () => {
    const fixture = await makeRepo();
    await seedSheetConfig(fixture, 'users', USERS_WITH_SCHEMA);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const requireSlugLength = makeStandardSchema((value) => {
      const slug = (value as Record<string, unknown>)['slug'] as string;
      if (slug.length < 5) {
        return { issues: [{ message: 'slug must be ≥ 5 chars', path: ['slug'] }] };
      }
      return { value: value as Record<string, unknown> };
    });

    const sheet = await repo.openSheet('users', { validator: requireSlugLength });
    try {
      await sheet.upsert({ slug: 'abc', email: 'a@x.org' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.issues.find((i) => i.source === 'standard-schema')).toBeDefined();
    }
  });
});
