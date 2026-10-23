// `git sheet aggregate` — specs/api/cli.md § `git sheet aggregate <sheet>`.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { main, parseAggClause } from './index.js';
import { parseToml } from '../toml.js';
import { testRepo, type TestRepoHandle } from '../test-helpers/test-repo.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

const TRANSACTIONS = [
  { id: 'a', postedAt: '2026-01-05', status: 'posted', amountCents: 1000, team: 'eng' },
  { id: 'b', postedAt: '2026-01-20', status: 'posted', amountCents: 2500, team: 'ops' },
  { id: 'c', postedAt: '2026-02-10', status: 'pending', amountCents: -500, team: 'eng' },
  { id: 'z', postedAt: '2025-12-31', status: 'posted', amountCents: 99 },
];

async function seeded(): Promise<TestRepoHandle> {
  const h = await testRepo({ withInitialCommit: true });
  handles.push(h);
  await mkdir(join(h.path, '.gitsheets'), { recursive: true });
  await writeFile(
    join(h.path, '.gitsheets', 'transactions.toml'),
    `[gitsheet]\nroot = 'transactions'\npath = '\${{ id }}'\n`,
  );
  await h.git('add', '.gitsheets/');
  await h.git('commit', '-m', 'add transactions sheet');
  const cap = capture();
  try {
    await main(['--git-dir', h.gitDir, '--message', 'seed', 'upsert', 'transactions', JSON.stringify(TRANSACTIONS)]);
  } finally {
    cap.restore();
  }
  return h;
}

function capture(): { restore: () => string } {
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

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const cap = capture();
  let code = -1;
  let out = '';
  try {
    code = await main(args);
  } finally {
    out = cap.restore();
  }
  return { code, out };
}

describe('CLI: aggregate', () => {
  it('emits one JSON object with a key per --agg', async () => {
    const h = await seeded();
    const { code, out } = await run([
      '--git-dir', h.gitDir, 'aggregate', 'transactions',
      '--agg', 'count=count', '--agg', 'total=sum:amountCents', '--agg', 'teams=distinct:team',
      '--agg', 'lo=min:amountCents', '--agg', 'mean=avg:amountCents',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ count: 4, total: 3099, teams: ['eng', 'ops'], lo: -500, mean: 774.75 });
  });

  it('honors --filter (as on query) and --group-by on every aggregate', async () => {
    const h = await seeded();
    const { code, out } = await run([
      '--git-dir', h.gitDir, 'aggregate', 'transactions',
      '--filter', 'postedAt>=2026-01-01',
      '--agg', 'n=count', '--agg', 'total=sum:amountCents',
      '--group-by', 'status',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      n: { pending: 1, posted: 2 },
      total: { pending: -500, posted: 3500 },
    });
  });

  it('accepts aggregate names that shadow Object.prototype members', async () => {
    const h = await seeded();
    const { code, out } = await run([
      '--git-dir', h.gitDir, 'aggregate', 'transactions', '--agg', 'toString=count', '--agg', 'hasOwnProperty=sum:amountCents',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ toString: 4, hasOwnProperty: 3099 });
  });

  it('emits TOML with --format toml', async () => {
    const h = await seeded();
    const { code, out } = await run([
      '--git-dir', h.gitDir, 'aggregate', 'transactions',
      '--filter', 'status=posted', '--agg', 'n=count', '--agg', 'byTeam=count', '--group-by', 'team',
      '--format', 'toml',
    ]);
    expect(code).toBe(0);
    expect(parseToml(out)).toEqual({ n: { eng: 1, ops: 1 }, byTeam: { eng: 1, ops: 1 } });
  });
});

describe('parseAggClause', () => {
  it('parses count and field forms', () => {
    expect(parseAggClause('n=count')).toEqual(['n', { count: true }]);
    expect(parseAggClause('total=sum:amountCents')).toEqual(['total', { sum: 'amountCents' }]);
    expect(parseAggClause('d=distinct:a:b')).toEqual(['d', { distinct: 'a:b' }]);
  });

  it('rejects malformed clauses', () => {
    for (const bad of ['count', '=count', 'n=sum', 'n=sum:', 'n=count:x', 'n=reduce:x', 'n=median:x']) {
      expect(() => parseAggClause(bad), bad).toThrow(/--agg/);
    }
  });
});
