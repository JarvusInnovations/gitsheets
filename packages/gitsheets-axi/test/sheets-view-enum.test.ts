// sheets view surfaces enum options + [required] so an agent sees allowed
// values before writing, not from a rejected upsert. (#223 Lower.)

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

[gitsheet.schema]
type = 'object'
required = ['slug', 'kind']

[gitsheet.schema.properties.slug]
type = 'string'

[gitsheet.schema.properties.kind]
type = 'string'
enum = ['functional', 'client', 'archive']
`;

describe('sheets view enum surfacing', () => {
  it('shows enum options and required markers', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'teams.toml'), TEAMS_TOML);
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'add teams');

    const { stdout, exitCode } = await runCli(['sheets', 'view', 'teams'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('enum: functional|client|archive');
    expect(stdout).toContain('[required]');
  });
});
