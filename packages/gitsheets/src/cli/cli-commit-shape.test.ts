// `git sheet commit` / `head` / `push` and the commit-shape flags —
// specs/api/cli.md "Commit-shape flags", `git sheet commit`, `git sheet head`,
// `git sheet push`.

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { main } from './index.js';
import { testRepo, type TestRepoHandle } from '../test-helpers/test-repo.js';

const exec = promisify(execFile);
const handles: TestRepoHandle[] = [];
const dirs: string[] = [];
const ENV = ['GITSHEETS_REPLACE', 'GITSHEETS_ALSO_PARENT', 'GITSHEETS_ALLOW_EMPTY'];
afterEach(async () => {
  for (const k of ENV) delete process.env[k];
  while (handles.length > 0) await handles.pop()?.cleanup();
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => (err.push(String(c)), true)) as typeof process.stderr.write;
  let code = -1;
  try {
    code = await main(args);
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return { code, out: out.join(''), err: err.join('') };
}

async function repo(): Promise<{ h: TestRepoHandle; g: string[]; rev: (r: string) => Promise<string> }> {
  const h = await testRepo({ withInitialCommit: true });
  handles.push(h);
  const rev = async (r: string) => (await h.git('rev-parse', r)).stdout.trim();
  return { h, g: ['--git-dir', h.gitDir], rev };
}

describe('git sheet commit', () => {
  it('needs --message and --allow-empty or --replace (exit 2)', async () => {
    const { g } = await repo();
    expect((await run([...g, 'commit', '--allow-empty'])).code).toBe(2);
    expect((await run([...g, 'commit', '--message', 'x'])).code).toBe(2);
  });

  it('commits empty with both trailer forms and an extra parent, prints the hash', async () => {
    const { h, g, rev } = await repo();
    const base = await rev('HEAD');
    const other = (await h.git('commit-tree', '-m', 'other', `${base}^{tree}`)).stdout.trim();
    const r = await run([
      ...g, 'commit', '--allow-empty', '--message', 'cycle 1',
      '--trailer', 'Cycle-Id: 1', '--trailer', 'Actor=loop', '--also-parent', other,
    ]);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toBe(await rev('HEAD'));
    expect((await h.git('log', '-1', '--format=%P')).stdout.trim()).toBe(`${base} ${other}`);
    const msg = (await h.git('log', '-1', '--format=%B')).stdout;
    expect(msg).toContain('Cycle-Id: 1');
    expect(msg).toContain('Actor: loop');
  });

  it('a bad trailer key exits 69; an unknown extra parent exits 65; a wrong --replace exits 69', async () => {
    const { g, rev } = await repo();
    const tip = await rev('HEAD');
    expect((await run([...g, 'commit', '--allow-empty', '--message', 'x', '--trailer', 'bad key: v'])).code).toBe(69);
    expect((await run([...g, 'commit', '--allow-empty', '--message', 'x', '--also-parent', '1234567890123456789012345678901234567890'])).code).toBe(65);
    const r = await run([...g, 'commit', '--replace', '1234567', '--message', 'x']);
    expect(r.code).toBe(69);
    expect(r.err).toContain('tip_mismatch');
    expect(await rev('HEAD')).toBe(tip);
  });

  it('--replace with a commit-hash --ref, or a different --commit-to, is exit 2', async () => {
    const { g, rev } = await repo();
    const tip = await rev('HEAD');
    expect((await run([...g, '--ref', tip, 'commit', '--replace', tip, '--message', 'x'])).code).toBe(2);
    expect((await run([...g, '--ref', 'main', '--commit-to', 'other', 'commit', '--replace', tip, '--message', 'x'])).code).toBe(2);
  });

  it('--replace rewrites the tip; GITSHEETS_REPLACE in the environment is ignored', async () => {
    const { g, rev } = await repo();
    await run([...g, 'commit', '--allow-empty', '--message', 'a']);
    const tip = await rev('HEAD');
    const parent = await rev('HEAD~1');
    process.env['GITSHEETS_REPLACE'] = tip;
    const plain = await run([...g, 'commit', '--allow-empty', '--message', 'b']);
    expect(plain.code, plain.err).toBe(0);
    expect(await rev('HEAD~1')).toBe(tip); // committed on top, not a replacement
    delete process.env['GITSHEETS_REPLACE'];
    const newTip = await rev('HEAD');
    const r = await run([...g, 'commit', '--allow-empty', '--replace', newTip, '--message', 'b reworded']);
    expect(r.code, r.err).toBe(0);
    expect(await rev('HEAD~1')).toBe(tip);
    void parent;
  });
});

describe('git sheet head', () => {
  it('prints CommitInfo JSON; null on an unborn branch', async () => {
    const { g, rev } = await repo();
    await run([...g, 'commit', '--allow-empty', '--message', 'S\n\nbody', '--trailer', 'K: v']);
    const r = await run([...g, 'head']);
    const info = JSON.parse(r.out) as Record<string, unknown>;
    expect(info).toMatchObject({ hash: await rev('HEAD'), subject: 'S', body: 'body', trailers: [{ key: 'K', value: 'v' }] });
    const unborn = await run([...g, '--branch', 'nope', 'head']);
    expect(unborn.code).toBe(0);
    expect(unborn.out.trim()).toBe('null');
  });
});

describe('git sheet push --to', () => {
  it('pushes up to a first-parent ancestor and prints the outcome', async () => {
    const { h, g, rev } = await repo();
    const remote = await mkdtemp(join(tmpdir(), 'gitsheets-cli-remote-'));
    dirs.push(remote);
    await exec('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await h.git('remote', 'add', 'origin', remote);
    await run([...g, 'commit', '--allow-empty', '--message', 'closed']);
    const closed = await rev('HEAD');
    await run([...g, 'commit', '--allow-empty', '--message', 'open']);
    const r = await run([...g, 'push', '--to', closed]);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toBe(`pushed ${closed}`);
    expect((await exec('git', ['rev-parse', 'main'], { cwd: remote })).stdout.trim()).toBe(closed);
    expect((await run([...g, 'push', '--to', 'nope'])).code).toBe(65);
  });
});
