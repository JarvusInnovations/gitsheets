// AXI check command — post-edit hook for agents that wrote a record directly.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

const USERS_TOML = `[gitsheet]
root = 'users'
path = '\${{ slug }}'

[gitsheet.schema]
type = 'object'
required = ['slug', 'email']

[gitsheet.schema.properties.slug]
type = 'string'
pattern = '^[a-z0-9-]+$'

[gitsheet.schema.properties.email]
type = 'string'

[gitsheet.schema.properties.name]
type = 'string'
`;

async function seedRepo(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS_TOML);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users sheet');
  await mkdir(join(fixture.path, 'users'), { recursive: true });
  return fixture;
}

describe('check', () => {
  it('reports canonical=true when the file is already in canonical form', async () => {
    const fixture = await seedRepo();
    // Canonical TOML: keys sorted alphabetically, double-quoted strings.
    const canonical = `email = "jane@x.org"\nslug = "jane"\n`;
    const target = join(fixture.path, 'users', 'jane.toml');
    await writeFile(target, canonical, 'utf-8');

    const { stdout, exitCode } = await runCli(
      ['check', 'users', 'users/jane.toml'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: ok');
    expect(stdout).toContain('canonical: true');
  });

  it('reports error on non-canonical file without --fix', async () => {
    const fixture = await seedRepo();
    // Non-canonical: keys reversed (slug should come after email alphabetically).
    const messy = `slug = "jane"\nemail = "jane@x.org"\n`;
    const target = join(fixture.path, 'users', 'jane.toml');
    await writeFile(target, messy, 'utf-8');

    const { stdout, exitCode } = await runCli(
      ['check', 'users', 'users/jane.toml'],
      fixture.path,
    );

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('error:');
    expect(stdout).toContain('NOT_CANONICAL');
    expect(stdout).toContain('--fix');
  });

  it('rewrites the file in canonical form when --fix is passed', async () => {
    const fixture = await seedRepo();
    const messy = `slug = "jane"\nemail = "jane@x.org"\n`;
    const target = join(fixture.path, 'users', 'jane.toml');
    await writeFile(target, messy, 'utf-8');

    const { stdout, exitCode } = await runCli(
      ['check', 'users', 'users/jane.toml', '--fix'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: fixed');
    expect(stdout).toContain('canonical: true');

    const after = await readFile(target, 'utf-8');
    // Canonical: alphabetically sorted keys.
    expect(after.indexOf('email')).toBeLessThan(after.indexOf('slug'));
  });

  it('returns ok (not fixed) when --fix on already-canonical file', async () => {
    const fixture = await seedRepo();
    const canonical = `email = "jane@x.org"\nslug = "jane"\n`;
    const target = join(fixture.path, 'users', 'jane.toml');
    await writeFile(target, canonical, 'utf-8');

    const { stdout, exitCode } = await runCli(
      ['check', 'users', 'users/jane.toml', '--fix'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: ok');
  });

  it('reports ValidationError code for invalid records', async () => {
    const fixture = await seedRepo();
    const invalid = `email = "jane@x.org"\nslug = "INVALID UPPERCASE"\n`;
    const target = join(fixture.path, 'users', 'jane.toml');
    await writeFile(target, invalid, 'utf-8');

    const { stdout, exitCode } = await runCli(
      ['check', 'users', 'users/jane.toml'],
      fixture.path,
    );

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('error:');
    expect(stdout).toContain('VALIDATION');
  });

  it('reports CONFIG_INVALID for unparseable files', async () => {
    const fixture = await seedRepo();
    const garbage = `this is not !!! valid TOML at all\n[ [ broken\n`;
    const target = join(fixture.path, 'users', 'jane.toml');
    await writeFile(target, garbage, 'utf-8');

    const { stdout, exitCode } = await runCli(
      ['check', 'users', 'users/jane.toml'],
      fixture.path,
    );

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('error:');
    expect(stdout).toContain('CONFIG_INVALID');
  });

  it('reports NOT_FOUND when the target file is missing', async () => {
    const fixture = await seedRepo();
    const { stdout, exitCode } = await runCli(
      ['check', 'users', 'users/never-existed.toml'],
      fixture.path,
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('error:');
    expect(stdout).toContain('NOT_FOUND');
  });
});
