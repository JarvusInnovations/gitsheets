// AXI rollup command — the twin of `git sheet rollup` (specs/behaviors/rollups.md
// "Materializing explicitly").

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

const TX_CONFIG = `[gitsheet]\nroot = 'transactions'\npath = '\${{ postedAt: YYYY/MM }}/\${{ id }}'\n`;
const MONTHLY = `[gitsheet]\nroot = 'transactions-monthly'\npath = '\${{ postedAt: YYYY/MM }}'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n\n[gitsheet.rollup.aggregates]\ncount = { count = true }\n`;

async function seeded(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'transactions.toml'), TX_CONFIG);
  await writeFile(join(fixture.path, '.gitsheets', 'transactions-monthly.toml'), MONTHLY);
  await mkdir(join(fixture.path, 'transactions', '2026', '03'), { recursive: true });
  await writeFile(
    join(fixture.path, 'transactions', '2026', '03', 'a.toml'),
    'id = "a"\npostedAt = 2026-03-05T00:00:00Z\n',
  );
  await fixture.git('add', '.');
  await fixture.git('commit', '-m', 'plain git');
  return fixture;
}

describe('rollup', () => {
  it('--check reports missing partitions with ROLLUP_STALE and exit 1, writing nothing', async () => {
    const fixture = await seeded();
    const before = (await fixture.git('rev-parse', 'HEAD')).stdout.trim();
    const { stdout, exitCode } = await runCli(['rollup', 'transactions-monthly', '--check'], fixture.path);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('ROLLUP_STALE');
    expect(stdout).toContain('missing 2026/03');
    expect((await fixture.git('rev-parse', 'HEAD')).stdout.trim()).toBe(before);
  });

  it('materializes in one commit, then reports fresh and commits nothing', async () => {
    const fixture = await seeded();
    let r = await runCli(['rollup', 'transactions-monthly'], fixture.path);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('committed');
    expect(r.stdout).toContain('2026/03');
    expect((await fixture.git('show', 'HEAD:transactions-monthly/2026/03.toml')).stdout).toContain('count = 1\n');
    r = await runCli(['rollup', 'transactions-monthly', '--check'], fixture.path);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('fresh');
    r = await runCli(['rollup', 'transactions-monthly'], fixture.path);
    expect(r.stdout).toContain('no-op');
  });

  it('refuses a non-rollup sheet and writes to a rollup sheet', async () => {
    const fixture = await seeded();
    let r = await runCli(['rollup', 'transactions'], fixture.path);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain('VALIDATION_ERROR');
    r = await runCli(['upsert', 'transactions-monthly', '--data', '{"postedAt":"2026-03-01"}'], fixture.path);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain('SHEET_DERIVED');
  });
});
