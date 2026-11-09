// Rollup sheets (specs/behaviors/rollups.md, specs/api/sheet.md § Rollup
// sheets). The pass, the canonical record, and the read-through live in the
// core; these tests pin the Node surface: commit-time maintenance through
// repo.transact and permissive writes, stamped read-through on query / get /
// count / indexes, opts.stale, read-only enforcement, materialize(), merge
// and sync, and the open-time config check.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AggregationError, ConfigError, TransactionError } from './errors.js';
import { openRepo } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

const TX_CONFIG = `[gitsheet]
root = 'transactions'
path = '\${{ postedAt: YYYY/MM }}/\${{ id }}'
`;

const MONTHLY_CONFIG = `[gitsheet]
root = 'transactions-monthly'
path = '\${{ postedAt: YYYY/MM }}'

[gitsheet.rollup]
from = 'transactions'

[gitsheet.rollup.aggregates]
count      = { count = true }
total      = { sum = 'amountCents' }
largest    = { max = 'amountCents' }
posted     = { sum = 'amountCents', where = { status = 'posted' } }
byCategory = { sum = 'amountCents', groupBy = 'category' }
`;

const LEDGER = [
  { id: 'a', postedAt: new Date('2026-01-10T12:00:00Z'), amountCents: 1000, status: 'posted', category: 'rent' },
  { id: 'b', postedAt: new Date('2026-02-11T12:00:00Z'), amountCents: 2000, status: 'pending', category: 'groceries' },
  { id: 'c', postedAt: new Date('2026-03-05T09:00:00Z'), amountCents: 1200, status: 'posted', category: 'groceries' },
  { id: 'd', postedAt: new Date('2026-03-20T09:00:00Z'), amountCents: 240000, status: 'posted', category: 'rent' },
];

async function fixtureWith(configs: Record<string, string>): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  for (const [name, text] of Object.entries(configs)) {
    await writeFile(join(fixture.path, '.gitsheets', `${name}.toml`), text);
  }
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add sheets');
  return fixture;
}

async function seeded(): Promise<TestRepoHandle> {
  const fixture = await fixtureWith({ transactions: TX_CONFIG, 'transactions-monthly': MONTHLY_CONFIG });
  const repo = await openRepo({ gitDir: fixture.gitDir });
  await repo.transact({ message: 'seed' }, async (tx) => {
    for (const r of LEDGER) await tx.sheet('transactions').upsert(r);
  });
  return fixture;
}

async function show(fixture: TestRepoHandle, spec: string): Promise<string> {
  return (await fixture.git('show', spec)).stdout;
}

async function revParse(fixture: TestRepoHandle, spec: string): Promise<string> {
  return (await fixture.git('rev-parse', spec)).stdout.trim();
}

describe('rollup sheets', () => {
  it('commits each touched partition’s rollup in the same commit, stamped with the partition tree', async () => {
    const fixture = await seeded();
    const march = await show(fixture, 'HEAD:transactions-monthly/2026/03.toml');
    const stamp = await revParse(fixture, 'HEAD:transactions/2026/03');
    expect(march).toBe(
      `count = 2\nlargest = 240000\nposted = 241200\npostedAt = 2026-03-01\nsourceTree = "${stamp}"\ntotal = 241200\n\n[byCategory]\ngroceries = 1200\nrent = 240000\n`,
    );
    const files = (await fixture.git('show', '--name-only', '--format=', 'HEAD')).stdout.trim().split('\n');
    expect(files).toContain('transactions-monthly/2026/01.toml');
    expect(files).toContain('transactions/2026/03/d.toml');
  });

  it('a later transaction touching two months rewrites exactly those two rollups', async () => {
    const fixture = await seeded();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheet = await repo.openSheet('transactions');
    await repo.transact({ message: 'two months' }, async (tx) => {
      await tx.sheet('transactions').upsert({ id: 'e', postedAt: new Date('2026-02-20T00:00:00Z'), amountCents: 5, status: 'posted', category: 'fun' });
      await tx.sheet('transactions').upsert({ id: 'f', postedAt: new Date('2026-03-21T00:00:00Z'), amountCents: 7, status: 'posted', category: 'fun' });
    });
    void sheet;
    const changed = (await fixture.git('diff', '--name-only', 'HEAD~1', 'HEAD', '--', 'transactions-monthly')).stdout.trim().split('\n');
    expect(changed).toEqual(['transactions-monthly/2026/02.toml', 'transactions-monthly/2026/03.toml']);
  });

  it('a permissive delete of a month’s last record deletes its rollup', async () => {
    const fixture = await seeded();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await (await repo.openSheet('transactions')).delete('2026/01/a');
    const ls = (await fixture.git('ls-tree', '-r', '--name-only', 'HEAD', 'transactions-monthly')).stdout;
    expect(ls).not.toContain('2026/01.toml');
    expect(ls).toContain('2026/02.toml');
  });

  it('reads through the stamp: a raw git commit is recomputed on read, served as stored with stale: serve, and persisted by materialize', async () => {
    const fixture = await seeded();
    // A plain git write the pass never saw.
    await fixture.git('reset', '-q', '--hard');
    await mkdir(join(fixture.path, 'transactions', '2026', '03'), { recursive: true });
    await writeFile(
      join(fixture.path, 'transactions', '2026', '03', 'g.toml'),
      'amountCents = 5\ncategory = "fun"\nid = "g"\npostedAt = 2026-03-30T00:00:00Z\nstatus = "posted"\n',
    );
    await fixture.git('add', 'transactions/');
    await fixture.git('commit', '-m', 'raw');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    const monthly = await repo.openSheet('transactions-monthly');
    const fresh = await monthly.get('2026/03');
    expect(fresh?.['count']).toBe(3);
    expect(fresh?.['sourceTree']).toBe(await revParse(fixture, 'HEAD:transactions/2026/03'));
    expect((await monthly.get('2026/03', { stale: 'serve' }))?.['count']).toBe(2);
    const all = await monthly.queryAll();
    expect(all.map((r) => r['count'])).toEqual([1, 1, 3]);
    expect(await monthly.count()).toBe(3);
    expect((await monthly.queryAll({}, { stale: 'serve' })).map((r) => r['count'])).toEqual([1, 1, 2]);
    expect(await monthly.rollupStatus()).toEqual([{ path: '2026/03', status: 'stale' }]);

    // Indexes build through the read-through too.
    monthly.defineIndex('byCount', (r) => String(r['count']));
    expect(await monthly.findByIndex('byCount', '3')).toHaveLength(1);
    expect(await monthly.findByIndex('byCount', '1')).toHaveLength(2);

    const before = await revParse(fixture, 'HEAD');
    expect(await monthly.materialize()).toEqual({ recomputed: ['2026/03'], deleted: [] });
    expect(await revParse(fixture, 'HEAD~1')).toBe(before);
    expect(await monthly.rollupStatus()).toEqual([]);
    // Fresh: a no-op, no commit.
    const tip = await revParse(fixture, 'HEAD');
    expect(await monthly.materialize()).toEqual({ recomputed: [], deleted: [] });
    expect(await revParse(fixture, 'HEAD')).toBe(tip);
  });

  it('prunes a rollup query by bucket ranges and equality on the key field', async () => {
    const fixture = await seeded();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const monthly = await repo.openSheet('transactions-monthly');
    const feb = await monthly.queryAll({ postedAt: { $gte: '2026-02-01', $lt: '2026-03-01' } });
    expect(feb.map((r) => r['total'])).toEqual([2000]);
    const q1 = await monthly.queryAll({ postedAt: { $gte: '2026-01-01', $lte: '2026-03-31' }, count: 1 });
    expect(q1).toHaveLength(2);
  });

  it('a transaction-bound rollup sheet reads the transaction’s tree', async () => {
    const fixture = await seeded();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    let seen: unknown;
    await repo.transact({ message: 'peek' }, async (tx) => {
      await tx.sheet('transactions').upsert({ id: 'h', postedAt: new Date('2026-03-02T00:00:00Z'), amountCents: 1, status: 'posted', category: 'fun' });
      seen = (await tx.sheet('transactions-monthly').get('2026/03'))?.['count'];
    });
    expect(seen).toBe(3);
    expect(await show(fixture, 'HEAD:transactions-monthly/2026/03.toml')).toContain('count = 3\n');
  });

  it('refuses writes to a rollup sheet with TransactionError(sheet_derived)', async () => {
    const fixture = await seeded();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const monthly = await repo.openSheet('transactions-monthly');
    const rec = { postedAt: new Date('2026-03-01T00:00:00Z'), count: 1 };
    for (const attempt of [
      () => monthly.upsert(rec),
      () => monthly.delete('2026/03'),
      () => monthly.patch({ count: 1 }, { count: 2 }),
      () => monthly.clear(),
      () => monthly.setAttachment('2026/03', 'x.txt', 'x'),
      () => monthly.deleteAttachment('2026/03', 'x.txt'),
      () => monthly.deleteAttachments('2026/03'),
    ]) {
      const err = await attempt().then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe('sheet_derived');
      expect((err as Error).message).toContain('transactions');
    }
    await expect(
      repo.transact({ message: 'x' }, async (tx) => {
        await tx.sheet('transactions-monthly').upsert(rec);
      }),
    ).rejects.toMatchObject({ code: 'sheet_derived' });
  });

  it('materialize() is a TypeError on a non-rollup sheet', async () => {
    const fixture = await seeded();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await expect((await repo.openSheet('transactions')).materialize()).rejects.toBeInstanceOf(TypeError);
  });

  it('an AggregationError in the pass aborts the commit and names the partition', async () => {
    const fixture = await fixtureWith({
      transactions: TX_CONFIG,
      'transactions-monthly': MONTHLY_CONFIG.replace("largest    = { max = 'amountCents' }", "largest    = { max = 'note' }"),
    });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const before = await revParse(fixture, 'HEAD');
    const err = await repo
      .transact({ message: 'mixed' }, async (tx) => {
        await tx.sheet('transactions').upsert({ id: 'a', postedAt: new Date('2026-03-01T00:00:00Z'), amountCents: 1, note: 'x' });
        await tx.sheet('transactions').upsert({ id: 'b', postedAt: new Date('2026-03-02T00:00:00Z'), amountCents: 1, note: 5 });
      })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AggregationError);
    expect(err).toMatchObject({ sheet: 'transactions-monthly', aggregate: 'largest', partition: '2026/03' });
    expect(await revParse(fixture, 'HEAD')).toBe(before);
  });

  it('a malformed rollup config is a ConfigError at open', async () => {
    const fixture = await fixtureWith({
      transactions: TX_CONFIG,
      bad: `[gitsheet]\nroot = 'bad'\npath = '\${{ id }}'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n\n[gitsheet.rollup.aggregates]\nn = { count = true }\n`,
    });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await expect(repo.openSheet('bad')).rejects.toBeInstanceOf(ConfigError);
    await expect(repo.openSheet('bad')).rejects.toMatchObject({ code: 'config_invalid' });
  });

  it('prefix scopes both the source and the rollup roots', async () => {
    const fixture = await fixtureWith({ transactions: TX_CONFIG, 'transactions-monthly': MONTHLY_CONFIG });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'tenant' }, async (tx) => {
      await tx.sheet('transactions', { prefix: 'acme' }).upsert(LEDGER[2]!);
    });
    expect(await show(fixture, 'HEAD:transactions-monthly/acme/2026/03.toml')).toContain(
      await revParse(fixture, 'HEAD:transactions/acme/2026/03'),
    );
    const scoped = await repo.openSheet('transactions-monthly', { prefix: 'acme' });
    expect((await scoped.queryAll()).map((r) => r['count'])).toEqual([1]);
    expect(await (await repo.openSheet('transactions-monthly')).queryAll()).toEqual([]);
  });

  it('repo.merge regenerates rollups over both sides (dry-run included); a plain git merge is healed by materialize', async () => {
    const fixture = await seeded();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const main = (await fixture.git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
    await fixture.git('branch', 'import');
    await repo.transact({ message: 'ours' }, async (tx) => {
      await tx.sheet('transactions').upsert({ id: 'x', postedAt: new Date('2026-03-11T00:00:00Z'), amountCents: 1, status: 'posted', category: 'fun' });
    });
    await repo.transact({ message: 'theirs', parent: 'import' }, async (tx) => {
      await tx.sheet('transactions').upsert({ id: 'y', postedAt: new Date('2026-03-12T00:00:00Z'), amountCents: 2, status: 'posted', category: 'fun' });
    });

    const dry = await repo.merge({ theirs: 'import', commit: false });
    expect(dry.outcome).toBe('dry-run');
    expect(dry.conflicts).toEqual([]);
    expect(await show(fixture, `${dry.tree}:transactions-monthly/2026/03.toml`)).toContain('count = 4\n');

    const merged = await repo.merge({ theirs: 'import' });
    expect(merged.outcome).toBe('merged');
    expect(await show(fixture, 'HEAD:transactions-monthly/2026/03.toml')).toContain(
      await revParse(fixture, 'HEAD:transactions/2026/03'),
    );
    void main;
  });

  it('a plain git merge leaves a stale stamp that reads self-heal and materialize repairs', async () => {
    const fixture = await seeded();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await fixture.git('reset', '-q', '--hard');
    await fixture.git('checkout', '-q', '-b', 'side');
    await repo.transact({ message: 'side' }, async (tx) => {
      await tx.sheet('transactions').upsert({ id: 's', postedAt: new Date('2026-01-11T00:00:00Z'), amountCents: 1, status: 'posted', category: 'fun' });
    });
    await fixture.git('reset', '-q', '--hard');
    await fixture.git('checkout', '-q', '-');
    await repo.transact({ message: 'main' }, async (tx) => {
      await tx.sheet('transactions').upsert({ id: 'm', postedAt: new Date('2026-01-12T00:00:00Z'), amountCents: 1, status: 'posted', category: 'fun' });
    });
    await fixture.git('reset', '-q', '--hard');
    // git's own merge: both sides changed January's rollup → take ours.
    await fixture.git('merge', '-q', '-X', 'ours', '--no-edit', 'side');
    const monthly = await repo.openSheet('transactions-monthly');
    await monthly.refresh();
    expect((await monthly.get('2026/01'))?.['count']).toBe(3);
    expect(await monthly.rollupStatus()).toEqual([{ path: '2026/01', status: 'stale' }]);
    expect(await monthly.materialize()).toEqual({ recomputed: ['2026/01'], deleted: [] });
  });

  it('a reduce rollup cannot read the clock or entropy', async () => {
    const fixture = await fixtureWith({
      transactions: TX_CONFIG,
      r: `[gitsheet]\nroot = 'r'\npath = 'all'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n\n[gitsheet.rollup.aggregates]\nv = { reduce = 'return Math.random()', initial = 0 }\n`,
    });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await expect(
      repo.transact({ message: 'x' }, async (tx) => {
        await tx.sheet('transactions').upsert(LEDGER[0]!);
      }),
    ).rejects.toBeInstanceOf(AggregationError);
  });
});
