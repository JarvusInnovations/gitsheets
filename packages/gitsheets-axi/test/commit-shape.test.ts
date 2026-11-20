// Commit-shape flags, `commit`, `head`, and `push --to` (specs/api/axi.md
// "Commit-shape flags", "commit", "head", "push"), on a headless branch.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { testRepo, type TestRepoHandle } from './test-repo.js';
import { runCli } from './run-cli.js';

const handles: TestRepoHandle[] = [];
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env['GITSHEETS_BRANCH'];
  delete process.env['GITSHEETS_BRANCH'];
});
afterEach(async () => {
  if (savedEnv === undefined) delete process.env['GITSHEETS_BRANCH'];
  else process.env['GITSHEETS_BRANCH'] = savedEnv;
  while (handles.length > 0) await handles.pop()?.cleanup();
});

async function git(h: TestRepoHandle, ...args: string[]): Promise<string> {
  return (await h.git(...args)).stdout.trim();
}

/** main checked out (one commit); `log` holds the users sheet and jane, built through axi. */
async function logRepo(): Promise<TestRepoHandle> {
  const h = await testRepo({ withInitialCommit: true });
  handles.push(h);
  expect((await runCli(['init', 'users', '--path', '${{ slug }}', '--branch', 'log'], h.path)).exitCode).toBe(0);
  expect(
    (await runCli(['upsert', 'users', '--data', '{"slug":"jane","email":"jane@x.org"}', '--branch', 'log'], h.path)).exitCode,
  ).toBe(0);
  return h;
}

const line = (stdout: string, key: string): string | undefined =>
  stdout.split('\n').find((l) => l.startsWith(`${key}: `))?.slice(key.length + 2);

describe('commit-shape flags', () => {
  it('every committing command takes --trailer / --also-parent / --replace; a read command refuses them', async () => {
    const h = await logRepo();
    const up = await runCli(
      ['upsert', 'users', '--data', '{"slug":"bob","email":"b@x.org"}', '--trailer', 'Cycle-Id: 7', '--trailer=Actor=loop', '--branch', 'log'],
      h.path,
    );
    expect(up.exitCode).toBe(0);
    const msg = await git(h, 'log', '-1', '--format=%B', 'log');
    expect(msg).toContain('Cycle-Id: 7');
    expect(msg).toContain('Actor: loop');
    const q = await runCli(['query', 'users', '--trailer', 'A: b', '--branch', 'log'], h.path);
    expect(q.exitCode).toBe(2);
    expect(q.stdout).toContain('VALIDATION_ERROR');
    const ae = await runCli(['upsert', 'users', '--data', '{"slug":"x","email":"x"}', '--allow-empty', '--branch', 'log'], h.path);
    expect(ae.exitCode).toBe(2);
    expect(ae.stdout).toContain('VALIDATION_ERROR');
  });

  it('a malformed, badly keyed, or repeated trailer is TRAILER_INVALID and commits nothing', async () => {
    const h = await logRepo();
    const tip = await git(h, 'rev-parse', 'log');
    for (const t of [['NoSeparator'], ['bad key: v'], ['A: 1', '--trailer', 'A: 2']]) {
      const r = await runCli(['commit', '--allow-empty', '--message', 'x', '--trailer', ...t, '--branch', 'log'], h.path);
      expect(r.stdout, t.join(' ')).toContain('TRAILER_INVALID');
      expect(r.exitCode).not.toBe(0);
    }
    expect(await git(h, 'rev-parse', 'log')).toBe(tip);
  });

  it('an unknown --also-parent is PARENT_NOT_FOUND', async () => {
    const h = await logRepo();
    const r = await runCli(
      ['commit', '--allow-empty', '--message', 'x', '--also-parent', '1234567890123456789012345678901234567890', '--branch', 'log'],
      h.path,
    );
    expect(r.stdout).toContain('PARENT_NOT_FOUND');
    expect(r.exitCode).toBe(1);
  });

  it('upsert --replace replaces the tip; a wrong tip is TIP_MISMATCH and nothing moves', async () => {
    const h = await logRepo();
    const tip = await git(h, 'rev-parse', 'log');
    const parent = await git(h, 'rev-parse', 'log~1');
    const wrong = await runCli(['upsert', 'users', '--data', '{"slug":"bob","email":"b@x.org"}', '--replace', parent, '--branch', 'log'], h.path);
    expect(wrong.stdout).toContain('TIP_MISMATCH');
    expect(wrong.exitCode).toBe(1);
    expect(await git(h, 'rev-parse', 'log')).toBe(tip);
    const ok = await runCli(['upsert', 'users', '--data', '{"slug":"bob","email":"b@x.org"}', '--replace', tip, '--branch', 'log'], h.path);
    expect(ok.exitCode).toBe(0);
    expect(line(ok.stdout, 'replaced')).toBe(tip);
    expect(await git(h, 'rev-parse', 'log~1')).toBe(parent);
    expect(await git(h, 'show', 'log:users/jane.toml')).toContain('jane@x.org');
    expect(await git(h, 'show', 'log:users/bob.toml')).toContain('b@x.org');
  });

  it('upsert --also-parent of an unchanged record is a no-op with no commit', async () => {
    const h = await logRepo();
    const tip = await git(h, 'rev-parse', 'log');
    const r = await runCli(['upsert', 'users', '--data', '{"slug":"jane","email":"jane@x.org"}', '--also-parent', 'main', '--branch', 'log'], h.path);
    expect(r.stdout).toContain('result: no-op');
    expect(await git(h, 'rev-parse', 'log')).toBe(tip);
  });
});

describe('commit + head', () => {
  it('commit needs --message and one of --allow-empty / --replace', async () => {
    const h = await logRepo();
    expect((await runCli(['commit', '--allow-empty', '--branch', 'log'], h.path)).exitCode).toBe(2);
    expect((await runCli(['commit', '--message', 'x', '--branch', 'log'], h.path)).exitCode).toBe(2);
  });

  it('an empty commit with trailers and an extra parent; head shows it and --json-out writes the shape', async () => {
    const h = await logRepo();
    const base = await git(h, 'rev-parse', 'log');
    const main = await git(h, 'rev-parse', 'main');
    const c = await runCli(
      ['commit', '--allow-empty', '--message', 'cycle 1: start', '--trailer', 'Cycle-Id: 1', '--also-parent', 'main', '--branch', 'log'],
      h.path,
    );
    expect(c.exitCode).toBe(0);
    expect(c.stdout).toContain('result: committed');
    expect(c.stdout).toContain('parents[2]: ');
    const commit = line(c.stdout, 'commit')!;
    expect(await git(h, 'rev-parse', 'log')).toBe(commit);

    const path = join(h.path, '..', `head-${Date.now()}.json`);
    const head = await runCli(['head', `--json-out=${path}`, '--branch', 'log'], h.path);
    expect(head.exitCode).toBe(0);
    expect(line(head.stdout, 'commit')).toBe(commit);
    expect(line(head.stdout, 'branch')).toBe('refs/heads/log');
    expect(head.stdout).toContain('trailers[1]{key,value}:\n  Cycle-Id,"1"');
    expect(line(head.stdout, 'wrote')).toBe(path);
    const json = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['author', 'body', 'branch', 'committer', 'hash', 'parents', 'subject', 'trailers', 'tree'].sort());
    expect(json).toMatchObject({
      hash: commit,
      branch: 'refs/heads/log',
      subject: 'cycle 1: start',
      body: '',
      trailers: [{ key: 'Cycle-Id', value: '1' }],
    });
    expect(json['parents']).toEqual([base, main]);
    expect(Object.keys(json['author'] as object).sort()).toEqual(['date', 'email', 'name']);
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600');
    // main and the working tree are untouched; no materialize hint.
    expect(await git(h, 'rev-list', '--count', 'main')).toBe('1');
    expect(await git(h, 'status', '--porcelain')).toBe('');
    expect(c.stdout).not.toContain('checkout HEAD');
  });

  it('head on an unborn branch prints commit: null and writes null', async () => {
    const h = await testRepo({ withInitialCommit: true });
    handles.push(h);
    const path = join(h.path, '..', `head-unborn-${Date.now()}.json`);
    const r = await runCli(['head', `--json-out=${path}`, '--branch', 'nothing-yet'], h.path);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('commit: null');
    expect(await readFile(path, 'utf8')).toBe('null\n');
    // ...and commit --allow-empty bootstraps it.
    const c = await runCli(['commit', '--allow-empty', '--message', 'first', '--branch', 'nothing-yet'], h.path);
    expect(c.exitCode).toBe(0);
    expect(await git(h, 'rev-list', '--count', 'nothing-yet')).toBe('1');
  });

  it('head <commit> reads that commit; an unknown one is REF_ERROR', async () => {
    const h = await logRepo();
    const first = await git(h, 'rev-parse', 'log~1');
    const r = await runCli(['head', first, '--branch', 'log'], h.path);
    expect(line(r.stdout, 'commit')).toBe(first);
    const bad = await runCli(['head', 'nope', '--branch', 'log'], h.path);
    expect(bad.stdout).toContain('REF_ERROR');
  });

  it('GITSHEETS_BRANCH and gitsheets.branch bind commit / head too', async () => {
    const h = await logRepo();
    process.env['GITSHEETS_BRANCH'] = 'log';
    const c = await runCli(['commit', '--allow-empty', '--message', 'via env'], h.path);
    expect(c.exitCode).toBe(0);
    delete process.env['GITSHEETS_BRANCH'];
    await h.git('config', 'gitsheets.branch', 'log');
    expect(line((await runCli(['head'], h.path)).stdout, 'subject')).toBe('via env');
    expect(await git(h, 'rev-list', '--count', 'main')).toBe('1');
  });
});

describe('the main loop through the CLI', () => {
  it('replace an empty commit with an extra parent repeatedly, publish below it, keep the open tip replaceable', async () => {
    const h = await logRepo();
    const remote = await testRepo();
    handles.push(remote);
    await remote.git('config', 'receive.denyCurrentBranch', 'ignore');
    await h.git('remote', 'add', 'origin', remote.path);
    const main = await git(h, 'rev-parse', 'main');
    const base = await git(h, 'rev-parse', 'log');

    let c = await runCli(
      ['commit', '--allow-empty', '--message', 'cycle 1', '--also-parent', 'main', '--trailer', 'State: 0', '--branch', 'log'],
      h.path,
    );
    let tip = line(c.stdout, 'commit')!;
    for (let i = 1; i <= 3; i++) {
      c = await runCli(
        ['commit', '--allow-empty', '--replace', tip, '--message', 'cycle 1', '--trailer', `State: ${i}`, '--branch', 'log'],
        h.path,
      );
      expect(c.exitCode, c.stdout).toBe(0);
      expect(line(c.stdout, 'replaced')).toBe(tip);
      tip = line(c.stdout, 'commit')!;
      // The extra parent is kept without repeating --also-parent.
      expect((await git(h, 'log', '-1', '--format=%P', 'log')).split(' ')).toEqual([base, main]);
    }
    const head = await runCli(['head', '--branch', 'log'], h.path);
    expect(head.stdout).toContain('State,"3"');

    // Close cycle 1: open cycle 2 on top, publish everything below it.
    const closed = tip;
    c = await runCli(['commit', '--allow-empty', '--message', 'cycle 2', '--branch', 'log'], h.path);
    const open = line(c.stdout, 'commit')!;
    const p = await runCli(['push', '--to', closed, '--branch', 'log'], h.path);
    expect(p.exitCode, p.stdout).toBe(0);
    expect(line(p.stdout, 'result')).toBe('pushed');
    expect(await git(remote, 'rev-parse', 'refs/heads/log')).toBe(closed);

    // The open tip is still replaceable...
    const r = await runCli(['commit', '--allow-empty', '--replace', open, '--message', 'cycle 2', '--trailer', 'State: 1', '--branch', 'log'], h.path);
    expect(r.exitCode, r.stdout).toBe(0);
    // ...the published one is not.
    await h.git('update-ref', 'refs/heads/log', closed);
    const refused = await runCli(['commit', '--allow-empty', '--replace', closed, '--message', 'x', '--branch', 'log'], h.path);
    expect(refused.stdout).toContain('TIP_PUBLISHED');
    expect(await git(h, 'rev-parse', 'log')).toBe(closed);
  });

  it('push --to off the first-parent line is REF_ERROR', async () => {
    const h = await logRepo();
    const remote = await testRepo();
    handles.push(remote);
    await h.git('remote', 'add', 'origin', remote.path);
    await runCli(['commit', '--allow-empty', '--message', 'x', '--also-parent', 'main', '--branch', 'log'], h.path);
    const r = await runCli(['push', '--to', 'main', '--branch', 'log'], h.path);
    expect(r.stdout).toContain('REF_ERROR');
  });
});
