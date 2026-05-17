// CLI `--no-body` flag on `gitsheets query` (#158).

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

async function makeRepoWithMarkdownPosts(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(
    join(fixture.path, '.gitsheets', 'posts.toml'),
    `[gitsheet]
root = 'posts'
path = '\${{ slug }}'

[gitsheet.format]
type = 'markdown'
body = 'body'
`,
  );
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add posts (markdown)');
  return fixture;
}

function captureStdout(): { restore: () => string } {
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

describe('CLI query --no-body', () => {
  it('includes the body in JSON output by default', async () => {
    const fixture = await makeRepoWithMarkdownPosts();
    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'seed',
      'upsert',
      'posts',
      '{"slug":"hi","title":"Hi","body":"hello body"}',
    ]);

    const cap = captureStdout();
    try {
      await main(['--git-dir', fixture.gitDir, 'query', 'posts']);
    } finally {
      const out = cap.restore();
      expect(out).toContain('"body":"hello body"');
    }
  });

  it('omits the body when --no-body is set', async () => {
    const fixture = await makeRepoWithMarkdownPosts();
    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'seed',
      'upsert',
      'posts',
      '{"slug":"hi","title":"Hi","body":"HUGE BODY"}',
    ]);

    const cap = captureStdout();
    try {
      await main(['--git-dir', fixture.gitDir, 'query', 'posts', '--no-body']);
    } finally {
      const out = cap.restore();
      expect(out).toContain('"title":"Hi"');
      expect(out).not.toContain('HUGE BODY');
      expect(out).not.toContain('"body":');
    }
  });
});
