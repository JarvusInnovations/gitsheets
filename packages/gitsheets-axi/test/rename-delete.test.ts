// rename (single-field re-key) and bulk delete (--filter / --dry-run). (#223 Medium.)

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

const TEAMS_TOML = `[gitsheet]
root = 'teams'
path = '\${{ slug }}'
`;

async function seedTeams(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'teams.toml'), TEAMS_TOML);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add teams');
  await runCli(
    ['upsert', 'teams', '--data', JSON.stringify([
      { slug: 'kevin-clough', kind: 'client', members: 1 },
      { slug: 'sencha', kind: 'functional', members: 3 },
    ])],
    fixture.path,
  );
  return fixture;
}

async function commitCount(fixture: TestRepoHandle): Promise<number> {
  const { stdout } = await fixture.git('rev-list', '--count', 'HEAD');
  return parseInt(stdout.trim(), 10);
}

describe('rename', () => {
  it('re-keys a record, preserving other fields, in one commit', async () => {
    const fixture = await seedTeams();
    const before = await commitCount(fixture);
    const { stdout, exitCode } = await runCli(['rename', 'teams', 'kevin-clough', 'kingofthepark'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: renamed');
    expect(stdout).toContain('from: kevin-clough');
    expect(stdout).toContain('to: kingofthepark');
    expect(await commitCount(fixture)).toBe(before + 1);

    const { exitCode: oldGone } = await runCli(['read', 'teams', 'kevin-clough'], fixture.path);
    expect(oldGone).not.toBe(0);
    const { stdout: neu } = await runCli(['read', 'teams', 'kingofthepark'], fixture.path);
    expect(neu).toContain('kind: client');
    expect(neu).toContain('members: 1');
  });

  it('refuses to overwrite an existing target', async () => {
    const fixture = await seedTeams();
    const { stdout, exitCode } = await runCli(['rename', 'teams', 'kevin-clough', 'sencha'], fixture.path);
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/already exists/);
  });

  it('errors on a missing source record', async () => {
    const fixture = await seedTeams();
    const { stdout, exitCode } = await runCli(['rename', 'teams', 'ghost', 'x'], fixture.path);
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/no record at ghost|NOT_FOUND/);
  });

  it('rejects a multi-field path template', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'pairs.toml'), "[gitsheet]\nroot = 'pairs'\npath = '${{ a }}/${{ b }}'\n");
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'add pairs');
    const { stdout, exitCode } = await runCli(['rename', 'pairs', 'x/y', 'x/z'], fixture.path);
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/single-field path template/);
  });
});

const REPOS_TOML = `[gitsheet]
root = 'repos'
path = '\${{ name }}'
`;

async function seedRepos(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'repos.toml'), REPOS_TOML);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add repos');
  await runCli(
    ['upsert', 'repos', '--data', JSON.stringify([
      { name: 'a', disposition: 'keep' },
      { name: 'b', disposition: 'delete-candidate' },
      { name: 'c', disposition: 'delete-candidate' },
      { name: 'd', disposition: 'keep' },
    ])],
    fixture.path,
  );
  return fixture;
}

describe('bulk delete', () => {
  it('deletes every record matching a filter in one commit', async () => {
    const fixture = await seedRepos();
    const before = await commitCount(fixture);
    const { stdout, exitCode } = await runCli(
      ['delete', 'repos', '--filter', 'disposition=delete-candidate'],
      fixture.path,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/deleted: 2\b/);
    expect(await commitCount(fixture)).toBe(before + 1);
    const { stdout: count } = await runCli(['count', 'repos'], fixture.path);
    expect(count).toMatch(/count: 2\b/);
  });

  it('--dry-run reports the count without committing', async () => {
    const fixture = await seedRepos();
    const before = await commitCount(fixture);
    const { stdout } = await runCli(
      ['delete', 'repos', '--filter', 'disposition=delete-candidate', '--dry-run'],
      fixture.path,
    );
    expect(stdout).toContain('result: dry-run');
    expect(stdout).toMatch(/willDelete: 2\b/);
    expect(await commitCount(fixture)).toBe(before);
  });

  it('is a no-op when nothing matches', async () => {
    const fixture = await seedRepos();
    const { stdout } = await runCli(['delete', 'repos', '--filter', 'disposition=nope'], fixture.path);
    expect(stdout).toMatch(/result: no-op/);
  });

  it('still deletes a single record by path', async () => {
    const fixture = await seedRepos();
    const { stdout, exitCode } = await runCli(['delete', 'repos', 'a'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: committed');
    expect(stdout).toContain('path: a');
  });
});
