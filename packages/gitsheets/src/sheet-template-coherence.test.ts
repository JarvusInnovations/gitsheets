// Template coherence at sheet open (#304):
// specs/behaviors/path-templates.md "Template fields must be schema-required".

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError } from './errors.js';
import { openRepo } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

async function seed(config: string, name = 'roles'): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', `${name}.toml`), config);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', `add ${name}`);
  return fixture;
}

const ROLES = `[gitsheet]
root = 'roles'
path = '\${{ projectSlug }}/\${{ slug }}'

[gitsheet.schema]
type = 'object'
required = ['slug']

[gitsheet.schema.properties.slug]
type = 'string'

[gitsheet.schema.properties.projectSlug]
type = 'string'
`;

describe('template coherence at sheet open', () => {
  it('rejects a template field the schema does not require with ConfigError(config_invalid)', async () => {
    const fixture = await seed(ROLES);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const err = await repo.openSheet('roles').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe('config_invalid');
    expect((err as ConfigError).message).toContain('"projectSlug"');
    expect((err as ConfigError).message).toContain('injectedFields');
  });

  it('opens when the field is required, or declared in injectedFields', async () => {
    const required = await seed(ROLES.replace("required = ['slug']", "required = ['slug', 'projectSlug']"));
    const repoA = await openRepo({ gitDir: required.gitDir });
    await expect(repoA.openSheet('roles')).resolves.toBeDefined();

    const injected = await seed(ROLES.replace("root = 'roles'", "root = 'roles'\ninjectedFields = ['projectSlug']"));
    const repoB = await openRepo({ gitDir: injected.gitDir });
    const roles = await repoB.openSheet('roles');
    // The writer injects the field before upsert; the schema never requires it.
    await repoB.transact({ message: 'add role' }, async (tx) => {
      await tx.sheet('roles').upsert({ projectSlug: 'acme', slug: 'maintainer' });
    });
    expect(await roles.get('acme/maintainer')).toMatchObject({ slug: 'maintainer' });
  });

  it('does not check a sheet without a persisted schema', async () => {
    const fixture = await seed(`[gitsheet]\nroot = 'roles'\npath = '\${{ projectSlug }}/\${{ slug }}'\n`);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await expect(repo.openSheet('roles')).resolves.toBeDefined();
  });

  it('rejects a non-array injectedFields', async () => {
    const fixture = await seed(ROLES.replace("root = 'roles'", "root = 'roles'\ninjectedFields = 'projectSlug'"));
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const err = await repo.openSheet('roles').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain('injectedFields must be an array');
  });
});
