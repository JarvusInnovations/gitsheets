// `git sheet rollup` — specs/api/cli.md § `git sheet rollup <sheet>`,
// specs/behaviors/rollups.md "Materializing explicitly".

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { main } from './index.js';
import { testRepo, type TestRepoHandle } from '../test-helpers/test-repo.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

const TX_CONFIG = `[gitsheet]\nroot = 'transactions'\npath = '\${{ postedAt: YYYY/MM }}/\${{ id }}'\n`;
const MONTHLY = `[gitsheet]\nroot = 'transactions-monthly'\npath = '\${{ postedAt: YYYY/MM }}'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n\n[gitsheet.rollup.aggregates]\ncount = { count = true }\ntotal = { sum = 'amountCents' }\n`;

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
  const err = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  let code = -1;
  let out = '';
  try {
    code = await main(args);
  } finally {
    out = cap.restore();
    process.stderr.write = err;
  }
  return { code, out };
}

/** Records committed by plain git, before the rollup config existed. */
async function seeded(): Promise<TestRepoHandle> {
  const h = await testRepo({ withInitialCommit: true });
  handles.push(h);
  await mkdir(join(h.path, '.gitsheets'), { recursive: true });
  await writeFile(join(h.path, '.gitsheets', 'transactions.toml'), TX_CONFIG);
  for (const [id, month, cents] of [['a', '01', 10], ['b', '03', 20], ['c', '03', 30]] as const) {
    await mkdir(join(h.path, 'transactions', '2026', month), { recursive: true });
    await writeFile(
      join(h.path, 'transactions', '2026', month, `${id}.toml`),
      `amountCents = ${cents}\nid = "${id}"\npostedAt = 2026-${month}-05T00:00:00Z\n`,
    );
  }
  await writeFile(join(h.path, '.gitsheets', 'transactions-monthly.toml'), MONTHLY);
  await h.git('add', '.');
  await h.git('commit', '-m', 'records + rollup config by plain git');
  return h;
}

describe('CLI: rollup', () => {
  it('--check lists missing partitions, writes nothing, and exits 1; rollup backfills; --check then exits 0', async () => {
    const h = await seeded();
    const before = (await h.git('rev-parse', 'HEAD')).stdout.trim();
    let r = await run(['--git-dir', h.gitDir, 'rollup', 'transactions-monthly', '--check']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('missing 2026/01\nmissing 2026/03\n');
    expect((await h.git('rev-parse', 'HEAD')).stdout.trim()).toBe(before);

    r = await run(['--git-dir', h.gitDir, '--message', 'backfill', 'rollup', 'transactions-monthly']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('recomputed 2026/01\nrecomputed 2026/03\n');
    expect((await h.git('log', '-1', '--format=%s')).stdout.trim()).toBe('backfill');
    expect((await h.git('show', 'HEAD:transactions-monthly/2026/03.toml')).stdout).toContain('total = 50\n');

    r = await run(['--git-dir', h.gitDir, 'rollup', 'transactions-monthly', '--check']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');

    // Fresh: no commit.
    const tip = (await h.git('rev-parse', 'HEAD')).stdout.trim();
    r = await run(['--git-dir', h.gitDir, 'rollup', 'transactions-monthly']);
    expect(r.code).toBe(0);
    expect((await h.git('rev-parse', 'HEAD')).stdout.trim()).toBe(tip);
  });

  it('reports orphaned and stale partitions', async () => {
    const h = await seeded();
    await run(['--git-dir', h.gitDir, 'rollup', 'transactions-monthly']);
    await h.git('reset', '-q', '--hard');
    await h.git('rm', '-q', 'transactions/2026/01/a.toml');
    await writeFile(join(h.path, 'transactions', '2026', '03', 'd.toml'), 'amountCents = 1\nid = "d"\npostedAt = 2026-03-09T00:00:00Z\n');
    await h.git('add', '.');
    await h.git('commit', '-m', 'raw');
    const r = await run(['--git-dir', h.gitDir, 'rollup', 'transactions-monthly', '--check']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('orphaned 2026/01\nstale 2026/03\n');
    const m = await run(['--git-dir', h.gitDir, 'rollup', 'transactions-monthly']);
    expect(m.out).toBe('recomputed 2026/03\ndeleted 2026/01\n');
  });

  it('honors --branch: --check and materialize operate on the bound branch, not HEAD\'s', async () => {
    const h = await seeded();
    // Move the records to `data`; the checked-out branch keeps no sheets.
    await h.git('branch', 'data');
    await h.git('rm', '-rq', '.');
    await h.git('commit', '-qm', 'empty code branch');
    const head0 = (await h.git('rev-parse', 'HEAD')).stdout.trim();

    let r = await run(['--git-dir', h.gitDir, '--branch', 'data', 'rollup', 'transactions-monthly', '--check']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('missing 2026/01\nmissing 2026/03\n');
    r = await run(['--git-dir', h.gitDir, '--branch', 'data', 'rollup', 'transactions-monthly']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('recomputed 2026/01\nrecomputed 2026/03\n');
    expect((await h.git('show', 'data:transactions-monthly/2026/03.toml')).stdout).toContain('total = 50\n');
    expect((await h.git('rev-parse', 'HEAD')).stdout.trim()).toBe(head0);
    r = await run(['--git-dir', h.gitDir, '--branch', 'data', 'rollup', 'transactions-monthly', '--check']);
    expect(r.code).toBe(0);
  });

  it('refuses a non-rollup sheet', async () => {
    const h = await seeded();
    const r = await run(['--git-dir', h.gitDir, 'rollup', 'transactions']);
    expect(r.code).toBe(1);
  });

  it('refuses an upsert into a rollup sheet with the TransactionError exit code', async () => {
    const h = await seeded();
    const r = await run(['--git-dir', h.gitDir, 'upsert', 'transactions-monthly', '{"postedAt":"2026-03-01","count":1}']);
    expect(r.code).toBe(69);
  });
});
