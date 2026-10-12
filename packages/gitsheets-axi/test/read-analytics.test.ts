// Read-side analytics: count, rich --filter operators, query --group-by,
// --sort/--desc, and distinct. (#223 High tier.)

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

const REPOS_TOML = `[gitsheet]
root = 'repos'
path = '\${{ name }}'
`;

const REPOS = JSON.stringify([
  { name: 'a', visibility: 'public', status: 'classified', target_team: 'slate', pushed_at: '2023-05-01', archived: false },
  { name: 'b', visibility: 'private', status: 'unclassified', pushed_at: '2021-01-01', archived: false },
  { name: 'c', visibility: 'public', status: 'unclassified', pushed_at: '2020-06-01', archived: true },
  { name: 'd', visibility: 'public', status: 'classified', target_team: 'sencha', pushed_at: '2024-01-01', archived: false },
  { name: 'e', visibility: 'private', status: 'classified', target_team: 'slate', pushed_at: '2019-01-01', archived: true },
]);

async function seeded(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'repos.toml'), REPOS_TOML);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add repos sheet');
  await runCli(['upsert', 'repos', '--data', REPOS], fixture.path);
  return fixture;
}

describe('count', () => {
  it('counts all records with no filter', async () => {
    const fixture = await seeded();
    const { stdout, exitCode } = await runCli(['count', 'repos'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/count: 5\b/);
  });

  it('counts a filtered subset', async () => {
    const fixture = await seeded();
    const { stdout } = await runCli(['count', 'repos', '--filter', 'status=unclassified'], fixture.path);
    expect(stdout).toMatch(/count: 2\b/);
    expect(stdout).toMatch(/of: 5\b/);
  });

  it('honors a comparison filter', async () => {
    const fixture = await seeded();
    const { stdout } = await runCli(['count', 'repos', '--filter', 'pushed_at<2022-01-01'], fixture.path);
    expect(stdout).toMatch(/count: 3\b/); // 2021, 2020, 2019
  });
});

describe('query filter operators', () => {
  const cases: Array<[string, string[], number]> = [
    ['!=', ['status!=classified'], 2],
    ['in()', ['target_team in (slate,sencha)'], 3],
    ['regex ~', ['visibility~^pub'], 3],
    ['comparison >', ['pushed_at>2022-01-01'], 2],
    [':present', ['target_team:present'], 3],
    [':empty', ['target_team:empty'], 2],
    ['AND of two clauses', ['visibility=public', 'archived=false'], 2],
  ];
  for (const [label, filters, expected] of cases) {
    it(`filters with ${label}`, async () => {
      const fixture = await seeded();
      const args = ['query', 'repos'];
      for (const f of filters) args.push('--filter', f);
      const { stdout, exitCode } = await runCli(args, fixture.path);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(`of ${expected} total`);
    });
  }

  it('rejects a malformed filter', async () => {
    const fixture = await seeded();
    const { stdout, exitCode } = await runCli(['query', 'repos', '--filter', 'garbage'], fixture.path);
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/parse --filter/);
  });
});

describe('query --group-by', () => {
  it('emits faceted counts biggest-first', async () => {
    const fixture = await seeded();
    const { stdout, exitCode } = await runCli(['query', 'repos', '--group-by', 'visibility'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('groups[2]');
    expect(stdout).toContain('public,3');
    expect(stdout).toContain('private,2');
  });

  it('groups over the filtered set', async () => {
    const fixture = await seeded();
    const { stdout } = await runCli(
      ['query', 'repos', '--filter', 'status=classified', '--group-by', 'target_team'],
      fixture.path,
    );
    expect(stdout).toContain('slate,2'); // a + e
    expect(stdout).toContain('sencha,1'); // d
  });
});

describe('query --sort', () => {
  it('sorts ascending / descending, exported verbatim', async () => {
    const fixture = await seeded();
    const { stdout } = await runCli(['query', 'repos', '--sort', 'pushed_at', '--ndjson-out'], fixture.path);
    const file = stdout.match(/wrote: (\S+)/)![1]!;
    const rows = (await readFile(file, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => r.name)).toEqual(['e', 'c', 'b', 'a', 'd']);

    const { stdout: desc } = await runCli(['query', 'repos', '--sort', 'pushed_at', '--desc', '--ndjson-out'], fixture.path);
    const file2 = desc.match(/wrote: (\S+)/)![1]!;
    const rows2 = (await readFile(file2, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows2.map((r) => r.name)).toEqual(['d', 'a', 'b', 'c', 'e']);
  });
});

describe('distinct', () => {
  it('lists unique values of a field with counts, sorted alphabetically', async () => {
    const fixture = await seeded();
    const { stdout, exitCode } = await runCli(['distinct', 'repos', 'visibility'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('values[2]');
    expect(stdout).toContain('private,2');
    expect(stdout).toContain('public,3');
  });
});

describe('range pushdown on date-bucket path fields', () => {
  const POSTS_TOML = `[gitsheet]
root = 'posts'
path = '\${{ publishedAt: YYYY/MM/DD }}/\${{ slug }}'
`;
  const POSTS = JSON.stringify([
    { slug: 'a', publishedAt: '2025-10-05T10:00:00Z', kind: 'note' },
    { slug: 'b', publishedAt: '2025-11-19T23:59:59Z', kind: 'post' },
    { slug: 'c', publishedAt: '2025-11-20T00:00:00Z', kind: 'post' },
    { slug: 'd', publishedAt: '2025-12-31T23:00:00Z', kind: 'note' },
    { slug: 'e', publishedAt: '2026-02-03T00:00:00Z', kind: 'post' },
    { slug: 'f', publishedAt: '2026-02-03T09:00:00Z', kind: 'post' },
    { slug: 'g', publishedAt: '2026-06-01T00:00:00Z', kind: 'note' },
  ]);

  async function seededPosts(): Promise<TestRepoHandle> {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'posts.toml'), POSTS_TOML);
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'add posts sheet');
    await runCli(['upsert', 'posts', '--data', POSTS], fixture.path);
    return fixture;
  }

  it('query results match the host-only semantics across a year boundary', async () => {
    const fixture = await seededPosts();
    const { stdout, exitCode } = await runCli(
      ['query', 'posts', '--filter', 'publishedAt>=2025-11-20', '--filter', 'publishedAt<2026-02-03T09:00:00Z', '--sort', 'slug'],
      fixture.path,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('of 3 total');
    for (const slug of ['c', 'd', 'e']) expect(stdout).toContain(slug);
    for (const slug of ['a', 'b', 'f', 'g']) expect(stdout).not.toMatch(new RegExp(`^\\s*${slug},`, 'm'));
  });

  it('composes a pushed-down range with host-only clauses', async () => {
    const fixture = await seededPosts();
    const { stdout } = await runCli(
      ['query', 'posts', '--filter', 'publishedAt>2025-11-19', '--filter', 'kind=note'],
      fixture.path,
    );
    expect(stdout).toContain('of 2 total');
  });

  it('count and distinct honor the range with the full-sheet total', async () => {
    const fixture = await seededPosts();
    const count = await runCli(['count', 'posts', '--filter', 'publishedAt<2025-11-20T00:00:00Z'], fixture.path);
    expect(count.stdout).toMatch(/count: 2\b/);
    expect(count.stdout).toMatch(/of: 7\b/);
    const distinct = await runCli(['distinct', 'posts', 'kind', '--filter', 'publishedAt>=2026-01-01'], fixture.path);
    expect(distinct.stdout).toMatch(/note/);
    expect(distinct.stdout).toMatch(/post/);
  });
});
