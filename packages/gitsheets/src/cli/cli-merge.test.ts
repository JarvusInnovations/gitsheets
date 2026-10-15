// CLI `merge` + `merge-driver` (specs/api/cli.md, specs/behaviors/merge.md, #307).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { main } from './index.js';
import { openRepo } from '../repository.js';
import { testRepo, type TestRepoHandle } from '../test-helpers/test-repo.js';

const handles: TestRepoHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

function capture(): { restore: () => { stdout: string; stderr: string } } {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const o: string[] = [];
  const e: string[] = [];
  process.stdout.write = ((c: string | Uint8Array): boolean => { o.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => { e.push(String(c)); return true; }) as typeof process.stderr.write;
  return { restore: () => { process.stdout.write = out; process.stderr.write = err; return { stdout: o.join(''), stderr: e.join('') }; } };
}

async function seed(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), `[gitsheet]\nroot = 'users'\npath = '\${{ slug }}'\n`);
  await mkdir(join(fixture.path, 'users'), { recursive: true });
  await writeFile(join(fixture.path, 'users', 'jane.toml'), 'email = "jane@x.org"\nname = "Jane"\nslug = "jane"\n');
  await fixture.git('add', '.');
  await fixture.git('commit', '-m', 'users + jane');
  await fixture.git('branch', 'import');
  return fixture;
}

async function commitOn(fixture: TestRepoHandle, branch: string, text: string, message: string): Promise<void> {
  await fixture.git('checkout', '-q', branch);
  await writeFile(join(fixture.path, 'users', 'jane.toml'), text);
  await fixture.git('commit', '-q', '-am', message);
  await fixture.git('checkout', '-q', 'main');
}

describe('git sheet merge', () => {
  it('merges disjoint field changes canonically; --dry-run moves nothing', async () => {
    const fixture = await seed();
    await commitOn(fixture, 'main', 'email = "jane@new.org"\nname = "Jane"\nslug = "jane"\n', 'ours');
    await commitOn(fixture, 'import', 'slug = "jane"\nname = "Jane"\nemail = "jane@x.org"\ngithubUserId = 458_494\n', 'theirs');
    const before = (await fixture.git('rev-parse', 'main')).stdout.trim();

    let cap = capture();
    let code = await main(['--git-dir', fixture.gitDir, 'merge', 'import', '--dry-run']);
    let io = cap.restore();
    expect(code).toBe(0);
    expect(io.stdout).toMatch(/^dry-run: merged tree [0-9a-f]{40} \(1 record\(s\) field-merged\)/);
    expect((await fixture.git('rev-parse', 'main')).stdout.trim()).toBe(before);

    cap = capture();
    code = await main(['--git-dir', fixture.gitDir, 'merge', 'import']);
    io = cap.restore();
    expect(code).toBe(0);
    expect(io.stdout).toMatch(/^merged: [0-9a-f]{40}/);
    const { stdout: blob } = await fixture.git('show', 'main:users/jane.toml');
    expect(blob).toBe('email = "jane@new.org"\ngithubUserId = 458494\nname = "Jane"\nslug = "jane"\n');
  });

  it('lists conflicts and exits 1 with nothing written; --prefer theirs resolves', async () => {
    const fixture = await seed();
    await commitOn(fixture, 'main', 'email = "ours@x.org"\nname = "Jane"\nslug = "jane"\n', 'ours');
    await commitOn(fixture, 'import', 'email = "theirs@x.org"\nname = "Jane"\nslug = "jane"\n', 'theirs');
    const before = (await fixture.git('rev-parse', 'main')).stdout.trim();

    let cap = capture();
    let code = await main(['--git-dir', fixture.gitDir, 'merge', 'import']);
    let io = cap.restore();
    expect(code).toBe(1);
    expect(io.stderr).toContain('merge conflict: users/jane.toml (field email)');
    expect((await fixture.git('rev-parse', 'main')).stdout.trim()).toBe(before);

    cap = capture();
    code = await main(['--git-dir', fixture.gitDir, 'merge', 'import', '--prefer', 'theirs']);
    io = cap.restore();
    expect(code).toBe(0);
    const { stdout: blob } = await fixture.git('show', 'main:users/jane.toml');
    expect(blob).toBe('email = "theirs@x.org"\nname = "Jane"\nslug = "jane"\n');
  });
});

describe('git sheet merge-driver', () => {
  it('writes the canonical field merge over <ours> and exits 0; falls back to git markers on a conflict', async () => {
    const fixture = await seed();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    expect(repo).toBeDefined();
    const tmp = await mkdtemp(join(tmpdir(), 'gitsheets-driver-'));
    dirs.push(tmp);
    const base = join(tmp, 'base.toml');
    const ours = join(tmp, 'ours.toml');
    const theirs = join(tmp, 'theirs.toml');
    await writeFile(base, 'email = "jane@x.org"\nname = "Jane"\nslug = "jane"\n');
    await writeFile(ours, 'email = "jane@new.org"\nname = "Jane"\nslug = "jane"\n');
    await writeFile(theirs, 'slug = "jane"\nname = "Jane"\nemail = "jane@x.org"\ngithubUserId = 458_494\n');

    let cap = capture();
    let code = await main(['--git-dir', fixture.gitDir, 'merge-driver', base, ours, theirs, 'users/jane.toml']);
    cap.restore();
    expect(code).toBe(0);
    expect(await readFile(ours, 'utf8')).toBe('email = "jane@new.org"\ngithubUserId = 458494\nname = "Jane"\nslug = "jane"\n');

    await writeFile(ours, 'email = "a@x.org"\nname = "Jane"\nslug = "jane"\n');
    await writeFile(theirs, 'email = "b@x.org"\nname = "Jane"\nslug = "jane"\n');
    cap = capture();
    code = await main(['--git-dir', fixture.gitDir, 'merge-driver', base, ours, theirs, 'users/jane.toml']);
    const io = cap.restore();
    expect(code).toBe(1);
    expect(io.stderr).toContain('conflicting field(s) email');
    expect(await readFile(ours, 'utf8')).toContain('<<<<<<<');
  });
});

describe('git sheet merge --install-driver', () => {
  it('sets the git config keys and writes one .gitattributes line per sheet, idempotently', async () => {
    const fixture = await seed();
    await writeFile(join(fixture.path, '.gitsheets', 'posts.toml'), `[gitsheet]\nroot = 'posts'\npath = '\${{ slug }}'\n\n[gitsheet.format]\ntype = 'markdown'\nbody = 'body'\n`);
    await writeFile(join(fixture.path, '.gitattributes'), '*.png binary\n');
    await fixture.git('add', '.gitsheets', '.gitattributes');
    await fixture.git('commit', '-q', '-m', 'posts sheet + attributes');

    let cap = capture();
    let code = await main(['--git-dir', fixture.gitDir, 'merge', '--install-driver']);
    let io = cap.restore();
    expect(code).toBe(0);
    expect(io.stdout).toContain('added: posts/**/*.md merge=gitsheets');
    expect(io.stdout).toContain('added: users/**/*.toml merge=gitsheets');
    const { stdout: driver } = await fixture.git('config', 'merge.gitsheets.driver');
    expect(driver.trim()).toBe('git sheet merge-driver %O %A %B %P');
    const { stdout: name } = await fixture.git('config', 'merge.gitsheets.name');
    expect(name.trim()).toBe('gitsheets record merge');
    expect(await readFile(join(fixture.path, '.gitattributes'), 'utf8')).toBe(
      '*.png binary\nposts/**/*.md merge=gitsheets\nusers/**/*.toml merge=gitsheets\n',
    );

    cap = capture();
    code = await main(['--git-dir', fixture.gitDir, 'merge', '--install-driver']);
    io = cap.restore();
    expect(code).toBe(0);
    expect(io.stdout).toContain('kept: users/**/*.toml merge=gitsheets');
    expect(io.stdout).toContain('already up to date');
    expect(await readFile(join(fixture.path, '.gitattributes'), 'utf8')).toBe(
      '*.png binary\nposts/**/*.md merge=gitsheets\nusers/**/*.toml merge=gitsheets\n',
    );
  });

  it('refuses <theirs> together with --install-driver, and requires one of them', async () => {
    const fixture = await seed();
    // yargs' usage failure calls process.exit(2); under vitest that exit is
    // intercepted and surfaces as a non-zero code, so assert the message.
    let cap = capture();
    let code = await main(['--git-dir', fixture.gitDir, 'merge', 'import', '--install-driver']);
    let io = cap.restore();
    expect(code).not.toBe(0);
    expect(io.stderr).toContain('takes no <theirs>');
    cap = capture();
    code = await main(['--git-dir', fixture.gitDir, 'merge']);
    io = cap.restore();
    expect(code).not.toBe(0);
    expect(io.stderr).toContain('<theirs> is required');
  });
});
