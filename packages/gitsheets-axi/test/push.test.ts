// AXI push command — one-shot push to a git remote.

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

async function repoWithBareRemote(): Promise<{
  repo: TestRepoHandle;
  remote: TestRepoHandle;
}> {
  // Bare "remote" repo.
  const remote = await testRepo();
  handles.push(remote);
  await remote.git('config', 'receive.denyCurrentBranch', 'updateInstead');

  // Working repo with origin → bare remote.
  const repo = await testRepo({ withInitialCommit: true });
  handles.push(repo);
  await repo.git('remote', 'add', 'origin', remote.path);
  return { repo, remote };
}

describe('push', () => {
  it('pushes commits to origin and reports success', async () => {
    const { repo } = await repoWithBareRemote();
    // Add a record-like change so HEAD moves.
    await mkdir(join(repo.path, '.gitsheets'), { recursive: true });
    await writeFile(
      join(repo.path, '.gitsheets', 'users.toml'),
      `[gitsheet]\nroot = 'users'\npath = '\${{ slug }}'\n`,
    );
    await repo.git('add', '.gitsheets/');
    await repo.git('commit', '-m', 'add users');

    const { stdout, exitCode } = await runCli(['push'], repo.path);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: pushed');
    expect(stdout).toContain('remote: origin');
  });

  it('no-op when remote is already up to date', async () => {
    const { repo } = await repoWithBareRemote();
    await mkdir(join(repo.path, '.gitsheets'), { recursive: true });
    await writeFile(
      join(repo.path, '.gitsheets', 'users.toml'),
      `[gitsheet]\nroot = 'users'\npath = '\${{ slug }}'\n`,
    );
    await repo.git('add', '.gitsheets/');
    await repo.git('commit', '-m', 'add users');
    await runCli(['push'], repo.path);

    const { stdout, exitCode } = await runCli(['push'], repo.path);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: no-op');
    expect(stdout).toContain('up-to-date');
  });

  it('errors with PUSH_FAILED when no remote exists', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);

    const { stdout, exitCode } = await runCli(['push'], fixture.path);

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('PUSH_FAILED');
  });
});
