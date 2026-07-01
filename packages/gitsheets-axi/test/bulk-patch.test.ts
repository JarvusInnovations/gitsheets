// Bulk patch (JSON array / NDJSON of combined records → one commit). Each
// record's path-template fields form the query; the rest is the RFC 7396 merge.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { testRepo, type TestRepoHandle } from './test-repo.js';
import { runCli } from './run-cli.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

const USERS_TOML = `[gitsheet]
root = 'users'
path = '\${{ slug }}'

[gitsheet.schema]
type = 'object'
required = ['slug', 'email']

[gitsheet.schema.properties.slug]
type = 'string'

[gitsheet.schema.properties.email]
type = 'string'

[gitsheet.schema.properties.team]
type = 'string'

[gitsheet.schema.properties.role]
type = 'string'
`;

const SEED = JSON.stringify([
  { slug: 'jane', email: 'jane@x.org', team: 'eng' },
  { slug: 'bob', email: 'bob@x.org', team: 'eng' },
  { slug: 'mia', email: 'mia@x.org', team: 'ops' },
]);

async function seeded(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS_TOML);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users sheet');
  await runCli(['upsert', 'users', '--data', SEED], fixture.path);
  return fixture;
}

async function commitCount(fixture: TestRepoHandle): Promise<number> {
  const { stdout } = await fixture.git('rev-list', '--count', 'HEAD');
  return parseInt(stdout.trim(), 10);
}

describe('bulk patch', () => {
  it('patches many records in a single commit, merging (not replacing)', async () => {
    const fixture = await seeded();
    const before = await commitCount(fixture);
    const patches = JSON.stringify([
      { slug: 'jane', role: 'lead' },
      { slug: 'bob', role: 'ic' },
    ]);
    const { stdout, exitCode } = await runCli(['patch', 'users', '--data', patches], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: committed');
    expect(stdout).toContain('patched: 2');
    expect(await commitCount(fixture)).toBe(before + 1);

    // Merge semantics: role added, email/team preserved.
    const { stdout: jane } = await runCli(['read', 'users', 'jane'], fixture.path);
    expect(jane).toContain('role: lead');
    expect(jane).toContain('jane@x.org');
    expect(jane).toContain('team: eng');
  });

  it('autodetects NDJSON', async () => {
    const fixture = await seeded();
    const ndjson = ['{"slug":"jane","role":"lead"}', '{"slug":"mia","role":"ops-lead"}'].join('\n');
    const { stdout } = await runCli(['patch', 'users', '--data', ndjson], fixture.path);
    expect(stdout).toContain('patched: 2');
  });

  it('is idempotent — re-patching the same values is a no-op', async () => {
    const fixture = await seeded();
    const patches = JSON.stringify([{ slug: 'jane', role: 'lead' }]);
    await runCli(['patch', 'users', '--data', patches], fixture.path);
    const after1 = await commitCount(fixture);
    const { stdout } = await runCli(['patch', 'users', '--data', patches], fixture.path);
    expect(stdout).toContain('result: no-op');
    expect(stdout).toContain('unchanged: 1');
    expect(await commitCount(fixture)).toBe(after1);
  });

  it('null deletes a field (RFC 7396)', async () => {
    const fixture = await seeded();
    await runCli(['patch', 'users', '--data', JSON.stringify([{ slug: 'jane', team: null }])], fixture.path);
    const { stdout } = await runCli(['read', 'users', 'jane'], fixture.path);
    expect(stdout).not.toContain('team:');
  });

  it('aborts the whole batch when a record matches nothing', async () => {
    const fixture = await seeded();
    const before = await commitCount(fixture);
    const patches = JSON.stringify([
      { slug: 'jane', role: 'lead' },
      { slug: 'ghost', role: 'nope' }, // no such record
    ]);
    const { stdout, exitCode } = await runCli(['patch', 'users', '--data', patches], fixture.path);
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/Record 2 \(slug=ghost\)/);
    expect(stdout).toMatch(/no record matches/);
    expect(await commitCount(fixture)).toBe(before); // nothing committed
  });

  it('errors when a record carries none of the path-template fields', async () => {
    const fixture = await seeded();
    const { stdout, exitCode } = await runCli(
      ['patch', 'users', '--data', JSON.stringify([{ role: 'lead' }])],
      fixture.path,
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/path-template fields/);
  });

  it('commits only the changed subset', async () => {
    const fixture = await seeded();
    await runCli(['patch', 'users', '--data', JSON.stringify([{ slug: 'jane', role: 'lead' }])], fixture.path);
    const after1 = await commitCount(fixture);
    const mixed = JSON.stringify([
      { slug: 'jane', role: 'lead' }, // unchanged
      { slug: 'bob', role: 'ic' }, // changed
    ]);
    const { stdout } = await runCli(['patch', 'users', '--data', mixed], fixture.path);
    expect(stdout).toContain('patched: 1');
    expect(stdout).toContain('unchanged: 1');
    expect(await commitCount(fixture)).toBe(after1 + 1);
  });
});

describe('single patch still works', () => {
  it('patches one record via explicit query + --patch', async () => {
    const fixture = await seeded();
    const { stdout, exitCode } = await runCli(
      ['patch', 'users', '{"slug":"jane"}', '--patch', '{"role":"lead"}'],
      fixture.path,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: committed');
    expect(stdout).toContain('path: jane');
  });

  it('rejects --data alongside a query positional', async () => {
    const fixture = await seeded();
    const { stdout, exitCode } = await runCli(
      ['patch', 'users', '{"slug":"jane"}', '--data', '[{"slug":"jane","role":"x"}]'],
      fixture.path,
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/bulk mode/);
  });

  it('rejects --patch without a query positional', async () => {
    const fixture = await seeded();
    const { stdout, exitCode } = await runCli(
      ['patch', 'users', '--patch', '{"role":"x"}'],
      fixture.path,
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/single mode/);
  });
});
