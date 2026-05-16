import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { testRepo, type TestRepoHandle } from './test-repo.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

async function makeRepo(opts?: Parameters<typeof testRepo>[0]): Promise<TestRepoHandle> {
  const h = await testRepo(opts);
  handles.push(h);
  return h;
}

describe('testRepo()', () => {
  it('creates a fresh git repo with no commits by default (#19)', async () => {
    const repo = await makeRepo();
    expect(existsSync(repo.gitDir)).toBe(true);

    // No HEAD commit yet — `git rev-parse --verify HEAD` exits non-zero.
    await expect(repo.git('rev-parse', '--verify', 'HEAD')).rejects.toThrow();
  });

  it('honors withInitialCommit: true', async () => {
    const repo = await makeRepo({ withInitialCommit: true });
    const { stdout } = await repo.git('rev-parse', '--verify', 'HEAD');
    expect(stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('honors a custom initial branch name', async () => {
    const repo = await makeRepo({ initialBranch: 'develop' });
    const { stdout } = await repo.git('symbolic-ref', '--short', 'HEAD');
    expect(stdout.trim()).toBe('develop');
  });

  it('configures hermetic identity (no signing, no hooks)', async () => {
    const repo = await makeRepo();
    const email = (await repo.git('config', 'user.email')).stdout.trim();
    expect(email).toBe('test@gitsheets.local');
    const sign = (await repo.git('config', 'commit.gpgsign')).stdout.trim();
    expect(sign).toBe('false');
  });

  it('cleanup() removes the tmpdir and is idempotent', async () => {
    const repo = await makeRepo();
    const path = repo.path;
    await stat(path);
    await repo.cleanup();
    expect(existsSync(path)).toBe(false);
    // second call is a no-op
    await repo.cleanup();
  });

  it('exec helper returns stdout from git', async () => {
    const repo = await makeRepo();
    const { stdout } = await repo.git('rev-parse', '--is-inside-work-tree');
    expect(stdout.trim()).toBe('true');
  });

  it('uses join() correctly for gitDir', async () => {
    const repo = await makeRepo();
    expect(repo.gitDir).toBe(join(repo.path, '.git'));
  });
});
