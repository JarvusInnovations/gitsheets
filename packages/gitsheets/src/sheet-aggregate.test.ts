// Sheet.aggregate() — ad-hoc aggregation (specs/behaviors/aggregation.md,
// specs/api/sheet.md § sheet.aggregate). The fold runs in the core; these
// tests pin the Node surface: every form + modifier, the omission rules,
// pruning, function-predicate filters, tx-bound reads, the TypeError /
// AggregationError split, body-less reads, and opts.signal.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AggregationError } from './errors.js';
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

const POSTS_CONFIG = `[gitsheet]
root = 'posts'
path = '\${{ slug }}'

[gitsheet.format]
type = 'markdown'
body = 'body'
`;

const LEDGER = [
  { id: 'a', postedAt: new Date('2026-01-05T00:00:00Z'), status: 'posted', amountCents: 1000, rate: 0.5 },
  { id: 'b', postedAt: new Date('2026-01-20T00:00:00Z'), status: 'posted', amountCents: 2500, rate: 0.25 },
  { id: 'c', postedAt: new Date('2026-02-10T00:00:00Z'), status: 'pending', amountCents: -500 },
  { id: 'z', postedAt: new Date('2025-12-31T00:00:00Z'), status: 'posted', amountCents: 99, note: 'old' },
];

async function seeded(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'transactions.toml'), TX_CONFIG);
  await writeFile(join(fixture.path, '.gitsheets', 'posts.toml'), POSTS_CONFIG);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add sheets');
  const repo = await openRepo({ gitDir: fixture.gitDir });
  await repo.transact({ message: 'seed' }, async (tx) => {
    for (const r of LEDGER) await tx.sheet('transactions').upsert(r);
    await tx.sheet('posts').upsert({ slug: 'one', words: 3, body: '# One\n\nHello.\n' });
    await tx.sheet('posts').upsert({ slug: 'two', words: 5, body: '# Two\n\nWorld.\n' });
  });
  return fixture;
}

async function sheetOf(name: string) {
  const fixture = await seeded();
  const repo = await openRepo({ gitDir: fixture.gitDir });
  return { repo, sheet: await repo.openSheet(name) };
}

describe('Sheet.aggregate', () => {
  it('answers the spec example shape', async () => {
    const { sheet } = await sheetOf('transactions');
    const r = await sheet.aggregate(
      { postedAt: { $gte: '2026-01-01' } },
      {
        count: { count: true },
        total: { sum: 'amountCents' },
        byStatus: { count: true, groupBy: 'status' },
      },
    );
    expect(r).toEqual({ count: 3, total: 3000, byStatus: { posted: 2, pending: 1 } });
  });

  it('covers every form and modifier', async () => {
    const { sheet } = await sheetOf('transactions');
    const r = await sheet.aggregate(undefined, {
      rate: { sum: 'rate' },
      mean: { avg: 'amountCents' },
      lo: { min: 'amountCents' },
      first: { min: 'postedAt' },
      statuses: { distinct: 'status' },
      postedTotal: { sum: 'amountCents', where: { status: 'posted' } },
      maxByStatus: { max: 'amountCents', groupBy: 'status' },
      ids: { reduce: 'return acc.concat([record.id]);', initial: [] },
      span: {
        reduce: 'acc.n++; acc.cents += record.amountCents; return acc;',
        initial: { n: 0, cents: 0 },
        finalize: 'return `${acc.n} for ${acc.cents}`;',
      },
    });
    expect(r).toEqual({
      rate: 0.75,
      mean: 774.75,
      lo: -500,
      first: new Date('2025-12-31T00:00:00Z'),
      statuses: ['pending', 'posted'],
      postedTotal: 3599,
      maxByStatus: { pending: -500, posted: 2500 },
      // canonical path order: 2025/12/z, 2026/01/a, 2026/01/b, 2026/02/c
      ids: ['z', 'a', 'b', 'c'],
      span: '4 for 3099',
    });
  });

  it('applies the omission rules', async () => {
    const { sheet } = await sheetOf('transactions');
    const r = await sheet.aggregate({ status: 'void' }, {
      n: { count: true },
      total: { sum: 'amountCents' },
      lo: { min: 'amountCents' },
      ids: { reduce: 'return acc;', initial: 0 },
      byStatus: { count: true, groupBy: 'status' },
    });
    expect(r).toEqual({ n: 0, total: 0, byStatus: {} });
  });

  it('accepts function predicates in the filter, folding over exactly the admitted records', async () => {
    const { sheet } = await sheetOf('transactions');
    const r = await sheet.aggregate(
      { amountCents: (v: unknown) => typeof v === 'number' && v > 500 },
      { ids: { reduce: 'return acc + record.id;', initial: '' }, total: { sum: 'amountCents' } },
    );
    expect(r).toEqual({ ids: 'ab', total: 3500 });
  });

  it('works on a tx-bound sheet over the private tree', async () => {
    const { repo } = await sheetOf('transactions');
    await repo.transact({ message: 'more' }, async (tx) => {
      const s = tx.sheet('transactions');
      await s.upsert({ id: 'd', postedAt: new Date('2026-02-11T00:00:00Z'), status: 'pending', amountCents: 7 });
      expect(await s.aggregate({}, { byStatus: { count: true, groupBy: 'status' } })).toEqual({
        byStatus: { pending: 2, posted: 3 },
      });
      expect(
        await s.aggregate({ id: (v: unknown) => v === 'd' }, { total: { sum: 'amountCents' } }),
      ).toEqual({ total: 7 });
    });
  });

  it('throws TypeError for a malformed spec', async () => {
    const { sheet } = await sheetOf('transactions');
    for (const aggs of [
      { x: { count: false } },
      { x: { sum: 'a', max: 'b' } },
      { x: { reduce: 'return acc;' } },
      { x: { reduce: 'return (', initial: 0 } },
      { x: { count: true, where: { status: { $nope: 1 } } } },
    ]) {
      await expect(sheet.aggregate({}, aggs as never)).rejects.toBeInstanceOf(TypeError);
    }
    await expect(sheet.aggregate({}, null as never)).rejects.toBeInstanceOf(TypeError);
    await expect(sheet.aggregate({ a: { $in: [1] } } as never, { n: { count: true } })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('throws AggregationError for a data-dependent failure', async () => {
    const { sheet } = await sheetOf('transactions');
    const err = await sheet
      .aggregate({}, { bad: { reduce: 'throw new Error("boom");', initial: 0 } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregationError);
    expect(err).toMatchObject({ code: 'aggregation_failed', status: 422, sheet: 'transactions', aggregate: 'bad' });
    expect((err as AggregationError).partition).toBeUndefined();

    // A non-TOML reduce result.
    await expect(
      sheet.aggregate({}, { bad: { reduce: 'return Symbol("x");', initial: 0 } }),
    ).rejects.toBeInstanceOf(AggregationError);
  });

  it('throws AggregationError for mixed kinds under min/max/distinct', async () => {
    const { repo } = await sheetOf('transactions');
    await repo.transact({ message: 'mixed' }, async (tx) => {
      // z carries note = 'old' (a string); d carries a number.
      await tx
        .sheet('transactions')
        .upsert({ id: 'd', postedAt: new Date('2026-03-01T00:00:00Z'), status: 'posted', amountCents: 1, note: 5 });
    });
    const sheet = await repo.openSheet('transactions');
    for (const form of ['min', 'max', 'distinct'] as const) {
      const err = await sheet.aggregate({}, { mix: { [form]: 'note' } as never }).catch((e: unknown) => e);
      expect(err, form).toBeInstanceOf(AggregationError);
      expect(err).toMatchObject({ sheet: 'transactions', aggregate: 'mix' });
    }
  });

  it('reads content-typed sheets body-less and rejects body references', async () => {
    const { repo } = await sheetOf('transactions');
    const posts = await repo.openSheet('posts');
    expect(
      await posts.aggregate({}, {
        words: { sum: 'words' },
        sawBody: { reduce: "return acc || 'body' in record;", initial: false },
      }),
    ).toEqual({ words: 8, sawBody: false });
    await expect(posts.aggregate({}, { b: { distinct: 'body' } })).rejects.toBeInstanceOf(TypeError);
    await expect(posts.aggregate({ body: 'x' }, { n: { count: true } })).rejects.toBeInstanceOf(TypeError);
  });

  it('honors opts.signal', async () => {
    const { sheet } = await sheetOf('transactions');
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(sheet.aggregate({}, { n: { count: true } }, { signal: ac.signal })).rejects.toThrow('stop');
  });
});
