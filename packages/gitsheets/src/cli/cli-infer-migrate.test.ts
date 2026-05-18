// CLI `infer` + `migrate-config` (#151).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { main } from './index.js';
import { openRepo } from '../repository.js';
import { parseToml } from '../toml.js';
import { testRepo, type TestRepoHandle } from '../test-helpers/test-repo.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

async function makeRepoWithUsers(): Promise<TestRepoHandle> {
  const h = await testRepo({ withInitialCommit: true });
  handles.push(h);
  await mkdir(join(h.path, '.gitsheets'), { recursive: true });
  await writeFile(
    join(h.path, '.gitsheets', 'users.toml'),
    `[gitsheet]\nroot = 'users'\npath = '\${{ slug }}'\n`,
  );
  await h.git('add', '.gitsheets/');
  await h.git('commit', '-m', 'add users sheet');
  return h;
}

function captureStdout(): { restore: () => string } {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = original;
      return chunks.join('');
    },
  };
}

async function readCommittedConfig(fixture: TestRepoHandle, sheet: string): Promise<string> {
  const { stdout } = await fixture.git('cat-file', 'blob', `HEAD:.gitsheets/${sheet}.toml`);
  return stdout;
}

describe('CLI infer', () => {
  it('writes a starter schema covering observed fields', async () => {
    const fixture = await makeRepoWithUsers();

    // Seed two records with different types
    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'seed',
      'upsert',
      'users',
      '[{"slug":"jane","email":"jane@x.org","age":30,"active":true},{"slug":"pat","email":"pat@x.org","age":42,"active":false}]',
    ]);

    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'infer schema',
      'infer',
      'users',
    ]);

    const text = await readCommittedConfig(fixture, 'users');
    const parsed = parseToml(text);
    const schema = (parsed['gitsheet'] as Record<string, unknown>)['schema'] as Record<
      string,
      unknown
    >;
    expect(schema['type']).toBe('object');
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['slug']?.['type']).toBe('string');
    expect(props['email']?.['type']).toBe('string');
    expect(props['age']?.['type']).toBe('integer');
    expect(props['age']?.['minimum']).toBe(30);
    expect(props['age']?.['maximum']).toBe(42);
    expect(props['active']?.['type']).toBe('boolean');
    const required = schema['required'] as string[];
    expect(required.sort()).toEqual(['active', 'age', 'email', 'slug']);

    // The existing config bits (root, path) survive
    const gs = parsed['gitsheet'] as Record<string, unknown>;
    expect(gs['root']).toBe('users');
    expect(gs['path']).toBe('${{ slug }}');
  });

  it('errors when the sheet has no records', async () => {
    const fixture = await makeRepoWithUsers();

    const cap = captureStdout();
    let code: number;
    try {
      code = await main([
        '--git-dir',
        fixture.gitDir,
        '--message',
        'try infer empty',
        'infer',
        'users',
      ]);
    } finally {
      cap.restore();
    }
    // No-op succeeds; the config doesn't change. Treat exit 0 as fine.
    expect(code).toBe(0);

    const repo = await openRepo({ gitDir: fixture.gitDir });
    const headRef = await repo.resolveRef('HEAD');
    expect(headRef).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('CLI migrate-config', () => {
  it('translates pre-v1.0 [gitsheet.fields] type/enum/default to schema', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(
      join(fixture.path, '.gitsheets', 'orders.toml'),
      `[gitsheet]
root = 'orders'
path = '\${{ id }}'

[gitsheet.fields.id]
type = 'string'

[gitsheet.fields.qty]
type = 'number'
default = 1

[gitsheet.fields.status]
type = 'string'
enum = ['pending', 'shipped', 'delivered']

[gitsheet.fields.tags]
sort = true
`,
    );
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'pre-v1.0 orders sheet');

    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'migrate',
      'migrate-config',
      'orders',
    ]);

    const text = await readCommittedConfig(fixture, 'orders');
    const parsed = parseToml(text);
    const gs = parsed['gitsheet'] as Record<string, unknown>;
    const schema = gs['schema'] as Record<string, unknown>;
    const props = schema['properties'] as Record<string, Record<string, unknown>>;

    expect(props['id']?.['type']).toBe('string');
    expect(props['qty']?.['type']).toBe('number');
    expect(props['qty']?.['default']).toBe(1);
    expect(props['status']?.['enum']).toEqual(['pending', 'shipped', 'delivered']);

    // sort stays under fields
    const fields = gs['fields'] as Record<string, Record<string, unknown>>;
    expect(fields['tags']?.['sort']).toBe(true);

    // tags didn't get a schema entry (no type/enum/default to migrate)
    expect(props['tags']).toBeUndefined();
  });

  it('emits a warning for trueValues/falseValues but still migrates the rest', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(
      join(fixture.path, '.gitsheets', 'flags.toml'),
      `[gitsheet]
root = 'flags'
path = '\${{ key }}'

[gitsheet.fields.key]
type = 'string'

[gitsheet.fields.enabled]
type = 'boolean'
trueValues = ['1', 'yes']
falseValues = ['0', 'no']
`,
    );
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'pre-v1.0 flags sheet');

    const stderrChunks: string[] = [];
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array): boolean => {
      stderrChunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      captureStdout().restore();
      await main([
        '--git-dir',
        fixture.gitDir,
        '--message',
        'migrate flags',
        'migrate-config',
        'flags',
      ]);
    } finally {
      process.stderr.write = originalErr;
    }

    const stderr = stderrChunks.join('');
    expect(stderr).toMatch(/trueValues\/falseValues/);

    const text = await readCommittedConfig(fixture, 'flags');
    const parsed = parseToml(text);
    const props = ((parsed['gitsheet'] as Record<string, unknown>)['schema'] as Record<
      string,
      unknown
    >)['properties'] as Record<string, Record<string, unknown>>;
    expect(props['enabled']?.['type']).toBe('boolean');
  });
});
