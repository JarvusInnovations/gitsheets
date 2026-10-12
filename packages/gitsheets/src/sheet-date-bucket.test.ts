// End-to-end date-bucket path keys: a sheet whose path template uses the
// declarative bucket form writes records into date-partitioned trees and
// prunes queries by the bucketed field.
// See specs/behaviors/path-templates.md § "Date-bucket references".

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError } from './errors.js';
import { openRepo } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

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

async function seedConfig(fixture: TestRepoHandle, name: string, toml: string): Promise<void> {
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', `${name}.toml`), toml);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', `add ${name} sheet`);
}

const POSTS_CONFIG = `[gitsheet]
root = 'posts'
path = '\${{ publishedAt: YYYY/MM/DD }}/\${{ slug }}'
`;

describe('date-bucket path keys end to end', () => {
  it('writes records into UTC date-partitioned paths and reads them back', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'posts', POSTS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed posts' }, async (tx) => {
      await tx.sheet('posts').upsert({
        slug: 'hello',
        publishedAt: new Date('2026-03-09T12:00:00Z'),
      });
      // 23:30-05:00 is 04:30 the NEXT day in UTC — the partition must be
      // the UTC date on every host.
      await tx.sheet('posts').upsert({
        slug: 'offset',
        publishedAt: new Date('2025-12-31T23:30:00-05:00'),
      });
    });

    const { stdout } = await fixture.git('ls-tree', '-r', '--name-only', 'main', 'posts/');
    const paths = stdout.trim().split('\n').sort();
    expect(paths).toEqual(['posts/2026/01/01/offset.toml', 'posts/2026/03/09/hello.toml']);
  });

  it('prunes a query by the bucketed field and wildcards without it', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'posts', POSTS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed posts' }, async (tx) => {
      await tx.sheet('posts').upsert({ slug: 'a', publishedAt: new Date('2026-03-09T12:00:00Z') });
      await tx.sheet('posts').upsert({ slug: 'b', publishedAt: new Date('2026-04-01T00:00:00Z') });
      await tx.sheet('posts').upsert({ slug: 'c', publishedAt: new Date('2025-12-31T09:00:00Z') });
    });

    const posts = await repo.openSheet('posts');

    // Bucketed field supplied → the walk descends the exact bucket path.
    const march = await posts.queryAll({ publishedAt: new Date('2026-03-09T12:00:00Z') });
    expect(march.map((r) => r['slug'])).toEqual(['a']);

    // Without it, every partition is walked.
    const all = await posts.queryAll({});
    expect(all.map((r) => r['slug']).sort()).toEqual(['a', 'b', 'c']);

    // Non-bucket filters still apply record-level across partitions.
    const bySlug = await posts.queryAll({ slug: 'c' });
    expect(bySlug).toHaveLength(1);
    expect(bySlug[0]?.['publishedAt']).toBeInstanceOf(Date);
  });

  it('pathForRecord renders the bucketed path host-side identically', async () => {
    const fixture = await makeRepo();
    await seedConfig(fixture, 'posts', POSTS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const posts = await repo.openSheet('posts');

    expect(
      await posts.pathForRecord({ slug: 'hello', publishedAt: new Date('2026-03-09T12:00:00Z') }),
    ).toBe('2026/03/09/hello');
  });

  it('supports the bucket as the entire path (daily-rollup identity)', async () => {
    const fixture = await makeRepo();
    await seedConfig(
      fixture,
      'rollups',
      `[gitsheet]
root = 'rollups'
path = '\${{ day: YYYY/MM/DD }}'
`,
    );
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed rollups' }, async (tx) => {
      await tx.sheet('rollups').upsert({ day: new Date('2026-03-09T00:00:00Z'), total: 5 });
    });

    const { stdout } = await fixture.git('ls-tree', '-r', '--name-only', 'main', 'rollups/');
    expect(stdout.trim()).toBe('rollups/2026/03/09.toml');
  });

  it('rejects an unknown bucket format with ConfigError at sheet-open', async () => {
    const fixture = await makeRepo();
    await seedConfig(
      fixture,
      'bad',
      `[gitsheet]
root = 'bad'
path = '\${{ publishedAt: YYYY-MM }}/\${{ slug }}'
`,
    );
    const repo = await openRepo({ gitDir: fixture.gitDir });

    try {
      const sheet = await repo.openSheet('bad');
      // Config parse is lazy in some paths — force it.
      await sheet.queryAll({});
      expect.unreachable('sheet-open should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('config_invalid');
    }
  });

  // ── range-pruned traversal (specs/behaviors/path-templates.md § "Range-pruned
  // traversal"; specs/api/sheet.md § "Range filter entries") ─────────────────

  const DAILY: Array<[string, string]> = [
    ['a', '2025-10-05T10:00:00Z'],
    ['b', '2025-11-19T23:59:59Z'],
    ['c', '2025-11-20T00:00:00Z'],
    ['d', '2025-11-25T12:00:00Z'],
    ['e', '2025-12-31T23:00:00Z'],
    ['f', '2026-01-15T08:00:00Z'],
    ['g', '2026-02-03T00:00:00Z'],
    ['h', '2026-02-03T09:00:00Z'],
    ['i', '2026-02-04T00:00:00Z'],
    ['j', '2026-06-01T00:00:00Z'],
  ];

  async function seedDaily(fixture: TestRepoHandle, name: string, extra = '') {
    await seedConfig(
      fixture,
      name,
      `[gitsheet]
root = '${name}'
path = '\${{ publishedAt: YYYY/MM/DD }}/\${{ slug }}'
${extra}`,
    );
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: `seed ${name}` }, async (tx) => {
      for (const [slug, when] of DAILY) {
        await tx.sheet(name).upsert({ slug, publishedAt: new Date(when), body: `# ${slug}\n` });
      }
    });
    return repo;
  }

  it('range-filters a bucketed TOML sheet with the exact cutoff (year-spanning)', async () => {
    const fixture = await makeRepo();
    const repo = await seedDaily(fixture, 'posts');
    const posts = await repo.openSheet('posts');

    const slugs = async (filter: Parameters<typeof posts.queryAll>[0]) =>
      (await posts.queryAll(filter)).map((r) => r['slug']);

    // Mixed bound kinds: ISO-string lower, Date upper; `$lt` midnight excludes
    // that day's records even though the walk visits the partition.
    expect(await slugs({ publishedAt: { $gte: '2025-11-20', $lt: new Date('2026-02-03T00:00:00Z') } }))
      .toEqual(['c', 'd', 'e', 'f']);
    expect(await slugs({ publishedAt: { $gt: new Date('2026-02-03T09:00:00Z') } })).toEqual(['i', 'j']);
    expect(await slugs({ publishedAt: { $lte: '2025-11-19T23:59:59Z' } })).toEqual(['a', 'b']);
    // Composes with other clauses, including a predicate.
    expect(await slugs({ publishedAt: { $gte: '2026-01-01' }, slug: (v: unknown) => v !== 'i' })).toEqual(['f', 'g', 'h', 'j']);
    // count() honors the range.
    expect(await posts.count({ publishedAt: { $gte: '2026-01-01' } })).toBe(5);
    // A non-date bound widens (no error) and matches nothing at the record level.
    expect(await slugs({ publishedAt: { $gte: 2025 } })).toEqual([]);
  });

  it('range-filters a bucketed markdown sheet through the candidates path', async () => {
    const fixture = await makeRepo();
    const repo = await seedDaily(
      fixture,
      'notes',
      `
[gitsheet.format]
type = 'markdown'
body = 'body'
`,
    );
    const notes = await repo.openSheet('notes');
    const inRange = await notes.queryAll(
      { publishedAt: { $gte: '2025-11-20', $lt: '2026-02-03' } },
      { withBody: false },
    );
    expect(inRange.map((r) => r['slug'])).toEqual(['c', 'd', 'e', 'f']);
    expect(inRange[0]?.['body']).toBeUndefined();
    const withBodies = await notes.queryAll({ publishedAt: { $gt: '2026-02-03T09:00:00Z' } });
    expect(withBodies.map((r) => [r['slug'], r['body']])).toEqual([['i', '# i'], ['j', '# j']]);
  });

  it('applies ranges host-side on a transaction-bound sheet', async () => {
    const fixture = await makeRepo();
    const repo = await seedDaily(fixture, 'posts');
    await repo.transact({ message: 'add k' }, async (tx) => {
      await tx.sheet('posts').upsert({ slug: 'k', publishedAt: new Date('2026-03-01T00:00:00Z') });
      const seen = await tx.sheet('posts').queryAll({ publishedAt: { $gte: '2026-02-04' } });
      expect(seen.map((r) => r['slug']).sort()).toEqual(['i', 'j', 'k']);
    });
  });

  it('rejects malformed $-keyed filter objects with TypeError at query start', async () => {
    const fixture = await makeRepo();
    const repo = await seedDaily(fixture, 'posts');
    const posts = await repo.openSheet('posts');
    for (const bad of [{ $in: ['a'] }, { $gte: '2026-01-01', foo: 1 }, { $gt: '2026-01-01', $gte: '2026-01-02' }]) {
      await expect(posts.queryAll({ publishedAt: bad } as never)).rejects.toThrow(TypeError);
    }
  });
});
