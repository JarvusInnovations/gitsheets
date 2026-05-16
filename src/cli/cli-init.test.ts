// CLI `init` (#139): scaffold .gitsheets/<sheet>.toml.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { main } from './index.js';
import { openRepo } from '../repository.js';
import { parseToml } from '../toml.js';
import { testRepo, type TestRepoHandle } from '../test-helpers/test-repo.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

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

async function readCommitted(fixture: TestRepoHandle, path: string): Promise<string> {
  const { stdout } = await fixture.git('cat-file', 'blob', `HEAD:${path}`);
  return stdout;
}

describe('CLI init', () => {
  it('scaffolds a minimal config with defaults', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);

    captureStdout().restore();
    const code = await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'init users',
      'init',
      'users',
    ]);
    expect(code).toBe(0);

    const text = await readCommitted(fixture, '.gitsheets/users.toml');
    const parsed = parseToml(text);
    const gs = parsed['gitsheet'] as Record<string, unknown>;
    expect(gs['root']).toBe('users');
    expect(gs['path']).toBe('${{ id }}');

    // The committed sheet opens cleanly through the library.
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheet = await repo.openSheet('users');
    const config = await sheet.readConfig();
    expect(config.root).toBe('users');
  });

  it('honors --path template override', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);

    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'init',
      'init',
      'users',
      '--path',
      '${{ slug }}',
    ]);

    const text = await readCommitted(fixture, '.gitsheets/users.toml');
    const parsed = parseToml(text);
    expect((parsed['gitsheet'] as Record<string, unknown>)['path']).toBe('${{ slug }}');
  });

  it('embeds a JSON Schema file under [gitsheet.schema]', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);

    const schemaPath = join(fixture.path, 'user.schema.json');
    await writeFile(
      schemaPath,
      JSON.stringify({
        type: 'object',
        properties: {
          id: { type: 'string' },
          email: { type: 'string', format: 'email' },
        },
        required: ['id', 'email'],
      }),
    );

    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'init with schema',
      'init',
      'users',
      '--schema',
      schemaPath,
    ]);

    const text = await readCommitted(fixture, '.gitsheets/users.toml');
    const parsed = parseToml(text);
    const schema = ((parsed['gitsheet'] as Record<string, unknown>)['schema'] as Record<
      string,
      unknown
    >);
    expect(schema['type']).toBe('object');
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['email']?.['format']).toBe('email');
  });

  it('refuses to overwrite an existing config without --force', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);

    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'init',
      'init',
      'users',
    ]);

    // Second init should fail (no --force)
    let code: number;
    const cap = captureStdout();
    try {
      code = await main([
        '--git-dir',
        fixture.gitDir,
        '--message',
        'second init',
        'init',
        'users',
      ]);
    } finally {
      cap.restore();
    }
    expect(code).not.toBe(0);
  });

  it('overwrites when --force is set', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);

    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'init v1',
      'init',
      'users',
    ]);

    captureStdout().restore();
    const code = await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'init v2',
      'init',
      'users',
      '--path',
      '${{ slug }}',
      '--force',
    ]);
    expect(code).toBe(0);

    const text = await readCommitted(fixture, '.gitsheets/users.toml');
    const parsed = parseToml(text);
    expect((parsed['gitsheet'] as Record<string, unknown>)['path']).toBe('${{ slug }}');
  });
});
