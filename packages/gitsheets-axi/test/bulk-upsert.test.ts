// Bulk upsert (JSON array / NDJSON autodetect → one commit) and the
// side-channel query exports (--json-out / --ndjson-out / --csv-out).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
`;

async function seedRepo({ withConfig = true }: { withConfig?: boolean } = {}): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  if (withConfig) {
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS_TOML);
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'add users sheet');
  }
  return fixture;
}

async function commitCount(fixture: TestRepoHandle): Promise<number> {
  const { stdout } = await fixture.git('rev-list', '--count', 'HEAD');
  return parseInt(stdout.trim(), 10);
}

const THREE = JSON.stringify([
  { slug: 'jane', email: 'jane@x.org', team: 'eng' },
  { slug: 'bob', email: 'bob@x.org', team: 'eng' },
  { slug: 'mia', email: 'mia@x.org', team: 'ops' },
]);

describe('bulk upsert', () => {
  it('imports a JSON array in a single commit', async () => {
    const fixture = await seedRepo();
    const before = await commitCount(fixture);
    const { stdout, exitCode } = await runCli(['upsert', 'users', '--data', THREE], fixture.path);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: committed');
    expect(stdout).toContain('upserted: 3');
    expect(stdout).toContain('unchanged: 0');
    // Exactly one new commit for all three records.
    expect(await commitCount(fixture)).toBe(before + 1);

    const { stdout: q } = await runCli(['query', 'users'], fixture.path);
    expect(q).toContain('count: 3 of 3 total');
  });

  it('surfaces the working-tree materialize hint', async () => {
    const fixture = await seedRepo();
    const { stdout } = await runCli(['upsert', 'users', '--data', THREE], fixture.path);
    expect(stdout).toMatch(/git checkout HEAD -- \./);
  });

  it('autodetects NDJSON (one object per line)', async () => {
    const fixture = await seedRepo();
    const ndjson = [
      '{"slug":"jane","email":"jane@x.org"}',
      '{"slug":"bob","email":"bob@x.org"}',
    ].join('\n');
    const { stdout, exitCode } = await runCli(['upsert', 'users', '--data', ndjson], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('upserted: 2');
  });

  it('is idempotent — re-importing the same batch is a no-op', async () => {
    const fixture = await seedRepo();
    await runCli(['upsert', 'users', '--data', THREE], fixture.path);
    const after1 = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(['upsert', 'users', '--data', THREE], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: no-op');
    expect(stdout).toContain('unchanged: 3');
    // No second commit.
    expect(await commitCount(fixture)).toBe(after1);
  });

  it('commits only the changed subset on a partial re-import', async () => {
    const fixture = await seedRepo();
    await runCli(['upsert', 'users', '--data', THREE], fixture.path);
    const after1 = await commitCount(fixture);

    const mixed = JSON.stringify([
      { slug: 'jane', email: 'jane@x.org', team: 'eng' }, // unchanged
      { slug: 'bob', email: 'bob@NEW.org', team: 'eng' }, // changed
    ]);
    const { stdout } = await runCli(['upsert', 'users', '--data', mixed], fixture.path);
    expect(stdout).toContain('upserted: 1');
    expect(stdout).toContain('unchanged: 1');
    expect(await commitCount(fixture)).toBe(after1 + 1);
  });

  it('aborts the whole batch when any record is invalid — nothing committed', async () => {
    const fixture = await seedRepo();
    const before = await commitCount(fixture);
    const bad = JSON.stringify([
      { slug: 'jane', email: 'jane@x.org' },
      { slug: 'bob' }, // missing required email
    ]);
    const { stdout, exitCode } = await runCli(['upsert', 'users', '--data', bad], fixture.path);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('error:');
    expect(stdout).toMatch(/Record 2 \(slug=bob\)/);
    // No partial commit.
    expect(await commitCount(fixture)).toBe(before);
  });
});

describe('config not committed', () => {
  it('hints to commit the config when it exists only in the working tree', async () => {
    const fixture = await seedRepo({ withConfig: false });
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS_TOML);
    // Deliberately NOT committed.
    const { stdout, exitCode } = await runCli(
      ['upsert', 'users', '--data', '{"slug":"jane","email":"j@x.org"}'],
      fixture.path,
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('isn\'t in the committed tree');
    expect(stdout).toMatch(/git add \.gitsheets\/users\.toml/);
  });
});

describe('query exports', () => {
  async function seeded(): Promise<TestRepoHandle> {
    const fixture = await seedRepo();
    await runCli(['upsert', 'users', '--data', THREE], fixture.path);
    return fixture;
  }

  function writtenPath(stdout: string): string {
    const m = stdout.match(/wrote: (\S+)/);
    if (!m) throw new Error(`no "wrote:" line in output:\n${stdout}`);
    return m[1]!;
  }

  it('--json-out writes the full set and round-trips back into upsert', async () => {
    const fixture = await seeded();
    // Preview capped at 1, but the file must carry all 3.
    const { stdout } = await runCli(
      ['query', 'users', '--limit', '1', '--json-out'],
      fixture.path,
    );
    expect(stdout).toContain('count: 1 of 3 total');
    expect(stdout).toContain('rows: 3');

    const file = writtenPath(stdout);
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as unknown[];
    expect(parsed).toHaveLength(3);

    // Round-trip: feeding the exported file straight back is a pure no-op.
    const { stdout: back } = await runCli(
      ['upsert', 'users', '--data', await readFile(file, 'utf-8')],
      fixture.path,
    );
    expect(back).toContain('result: no-op');
    expect(back).toContain('unchanged: 3');
  });

  it('--ndjson-out writes one object per line', async () => {
    const fixture = await seeded();
    const { stdout } = await runCli(['query', 'users', '--ndjson-out'], fixture.path);
    const file = writtenPath(stdout);
    const body = await readFile(file, 'utf-8');
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('--csv-out writes a header + one row per record', async () => {
    const fixture = await seeded();
    const { stdout } = await runCli(['query', 'users', '--csv-out'], fixture.path);
    const file = writtenPath(stdout);
    const body = await readFile(file, 'utf-8');
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(4); // header + 3
    expect(lines[0]).toContain('slug');
    expect(lines[0]).toContain('email');
  });

  it('rejects two export flags at once', async () => {
    const fixture = await seeded();
    const { stdout, exitCode } = await runCli(
      ['query', 'users', '--json-out', '--csv-out'],
      fixture.path,
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/one export flag/i);
  });
});
