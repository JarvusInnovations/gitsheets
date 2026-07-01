// CLI `check` command — validate + (optionally) normalize a record file in
// the working tree without committing.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

const USERS_CONFIG_WITH_SCHEMA = `[gitsheet]
root = 'users'
path = '\${{ slug }}'

[gitsheet.schema]
type = 'object'
required = ['slug', 'email']

[gitsheet.schema.properties.slug]
type = 'string'
minLength = 1

[gitsheet.schema.properties.email]
type = 'string'
format = 'email'
`;

async function seedRepo(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS_CONFIG_WITH_SCHEMA);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users sheet');
  return fixture;
}

function captureStreams(): { restore: () => { stdout: string; stderr: string } } {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    outChunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    errChunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      return { stdout: outChunks.join(''), stderr: errChunks.join('') };
    },
  };
}

describe('CLI check', () => {
  it('exits 0 with `ok` when the file is already canonical', async () => {
    const fixture = await seedRepo();
    const recordPath = join(fixture.path, 'users', 'jane.toml');
    await mkdir(join(fixture.path, 'users'), { recursive: true });
    // Deep-sorted, two-spaces-after-marker normalized form
    await writeFile(recordPath, 'email = "jane@x.org"\nslug = "jane"\n');

    const cap = captureStreams();
    const code = await main(['--git-dir', fixture.gitDir, 'check', 'users', recordPath]);
    const { stdout } = cap.restore();
    expect(code).toBe(0);
    expect(stdout).toContain('ok');
  });

  it('exits 1 when the file is parseable + valid but not canonical', async () => {
    const fixture = await seedRepo();
    const recordPath = join(fixture.path, 'users', 'jane.toml');
    await mkdir(join(fixture.path, 'users'), { recursive: true });
    // Keys are not deep-sorted (slug before email) → not canonical
    await writeFile(recordPath, 'slug = "jane"\nemail = "jane@x.org"\n');

    const cap = captureStreams();
    const code = await main(['--git-dir', fixture.gitDir, 'check', 'users', recordPath]);
    const { stderr } = cap.restore();
    expect(code).toBe(1);
    expect(stderr).toContain('not in canonical form');
  });

  it('--fix rewrites the file to canonical form and exits 0', async () => {
    const fixture = await seedRepo();
    const recordPath = join(fixture.path, 'users', 'jane.toml');
    await mkdir(join(fixture.path, 'users'), { recursive: true });
    await writeFile(recordPath, 'slug = "jane"\nemail = "jane@x.org"\n');

    const cap = captureStreams();
    const code = await main([
      '--git-dir',
      fixture.gitDir,
      'check',
      'users',
      recordPath,
      '--fix',
    ]);
    const { stdout } = cap.restore();
    expect(code).toBe(0);
    expect(stdout).toContain('fixed');

    const after = await readFile(recordPath, 'utf8');
    // Canonical = deep-sorted keys (alphabetical: email before slug)
    expect(after).toBe('email = "jane@x.org"\nslug = "jane"\n');
  });

  it('exits 22 (ValidationError) on schema failure', async () => {
    const fixture = await seedRepo();
    const recordPath = join(fixture.path, 'users', 'jane.toml');
    await mkdir(join(fixture.path, 'users'), { recursive: true });
    await writeFile(recordPath, 'slug = "jane"\nemail = "not-an-email"\n');

    const cap = captureStreams();
    let code: number;
    try {
      code = await main(['--git-dir', fixture.gitDir, 'check', 'users', recordPath]);
    } catch {
      code = 99;
    }
    cap.restore();
    expect(code).toBe(22);
  });

  it('exits 64 (ConfigError) when the file fails to parse as TOML', async () => {
    const fixture = await seedRepo();
    const recordPath = join(fixture.path, 'users', 'jane.toml');
    await mkdir(join(fixture.path, 'users'), { recursive: true });
    await writeFile(recordPath, 'this is not valid toml = =');

    const cap = captureStreams();
    let code: number;
    try {
      code = await main(['--git-dir', fixture.gitDir, 'check', 'users', recordPath]);
    } catch {
      code = 99;
    }
    cap.restore();
    expect(code).toBe(64);
  });

  it('works on a markdown sheet (normalizes the body via markdownlint --fix)', async () => {
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
    await fixture.git('commit', '-m', 'add posts sheet');

    const recordPath = join(fixture.path, 'posts', 'hello.md');
    await mkdir(join(fixture.path, 'posts'), { recursive: true });
    // Two-space list marker — the native dprint formatter normalizes it on --fix
    await writeFile(
      recordPath,
      '+++\nslug = "hello"\n+++\n\n* item one\n*  item two\n',
    );

    const cap = captureStreams();
    const code = await main([
      '--git-dir',
      fixture.gitDir,
      'check',
      'posts',
      recordPath,
      '--fix',
    ]);
    cap.restore();
    expect(code).toBe(0);

    const after = await readFile(recordPath, 'utf8');
    expect(after).toContain('- item one\n- item two');
    expect(after).not.toContain('*  item two');
  });

  it('accepts a relative file path', async () => {
    const fixture = await seedRepo();
    await mkdir(join(fixture.path, 'users'), { recursive: true });
    await writeFile(
      join(fixture.path, 'users', 'jane.toml'),
      'email = "jane@x.org"\nslug = "jane"\n',
    );

    const cwd = process.cwd();
    process.chdir(fixture.path);
    try {
      const cap = captureStreams();
      const code = await main([
        '--git-dir',
        fixture.gitDir,
        'check',
        'users',
        'users/jane.toml',
      ]);
      cap.restore();
      expect(code).toBe(0);
    } finally {
      process.chdir(cwd);
    }
  });
});
