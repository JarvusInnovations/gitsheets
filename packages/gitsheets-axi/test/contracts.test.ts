// `contracts list|verify|test` — the agent-facing surface for
// specs/behaviors/contracts.md's producer verify gate + consumer
// verification ladder. Fixture style mirrors packages/gitsheets/src/cli/
// cli-contracts.test.ts (the human CLI's own contracts test suite).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { stringifyRecord } from 'gitsheets';

import { testRepo, type TestRepoHandle } from './test-repo.js';
import { runCli } from './run-cli.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

const CONTRACT_NAME = 'test.local/meals/v1';
const CONTRACT_DOC = {
  $id: `https://${CONTRACT_NAME}`,
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string', minLength: 1 } },
};

function canonicalContractText(): string {
  return stringifyRecord(CONTRACT_DOC as Record<string, unknown>);
}

const MEALS_CONFIG = `[gitsheet]
root = 'meals'
path = '\${{ slug }}'
implements = ['${CONTRACT_NAME}']
`;

const MEALS_CONFIG_CLOSED = `[gitsheet]
root = 'meals'
path = '\${{ slug }}'
implements = ['${CONTRACT_NAME}']

[gitsheet.schema]
type = 'object'
additionalProperties = false

[gitsheet.schema.properties.name]
type = 'string'

[gitsheet.schema.properties.slug]
type = 'string'
`;

const MEALS_CONFIG_NO_CONTRACT = `[gitsheet]
root = 'meals'
path = '\${{ slug }}'
`;

async function vendorContract(fixture: TestRepoHandle): Promise<void> {
  await mkdir(join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'meals'), { recursive: true });
  await writeFile(
    join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'meals', 'v1.toml'),
    canonicalContractText(),
  );
}

/** A repo with a `meals` sheet declaring CONTRACT_NAME, the contract vendored, and one conforming record. */
async function seedConformingRepo(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG);
  await vendorContract(fixture);
  await fixture.git('add', '.gitsheets');
  await fixture.git('commit', '-m', 'seed meals sheet + contract');

  const { exitCode } = await runCli(
    ['upsert', 'meals', '--data', '{"slug":"soup","name":"Soup"}'],
    fixture.path,
  );
  expect(exitCode).toBe(0);
  await fixture.git('reset', '--hard', 'HEAD');
  return fixture;
}

describe('contracts list', () => {
  it('lists vendored contracts + declaring sheets + every sheet\'s implements', async () => {
    const fixture = await seedConformingRepo();
    const { stdout, exitCode } = await runCli(['contracts', 'list'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(CONTRACT_NAME);
    expect(stdout).toContain('meals');
    expect(stdout).toMatch(/hash/);
  });

  it('bare `contracts` (no subcommand) defaults to list', async () => {
    const fixture = await seedConformingRepo();
    const { stdout, exitCode } = await runCli(['contracts'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(CONTRACT_NAME);
  });

  it('reports a helpful empty state with no sheets and no contracts', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    const { stdout, exitCode } = await runCli(['contracts', 'list'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('no vendored contracts');
    expect(stdout).toContain('no sheets configured');
  });
});

describe('contracts verify', () => {
  it('passes on a conforming fixture repo', async () => {
    const fixture = await seedConformingRepo();
    const { stdout, exitCode } = await runCli(['contracts', 'verify'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('meals');
    expect(stdout).toContain('ok');
  });

  it('reports CONTRACT_UNSATISFIED with per-record issue detail on a seeded defect', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG);
    await vendorContract(fixture);
    // `upsert` would refuse a record missing `name` (contracts are enforced
    // at write time, by construction — see specs/behaviors/contracts.md
    // "Composition and enforcement"). To exercise `verify`'s actual use case
    // (drift: existing records predating a contract, or written outside the
    // write path), commit a non-conforming record directly, bypassing the
    // library entirely.
    await mkdir(join(fixture.path, 'meals'), { recursive: true });
    await writeFile(join(fixture.path, 'meals', 'soup.toml'), `slug = "soup"\n`);
    await fixture.git('add', '.gitsheets', 'meals');
    await fixture.git('commit', '-m', 'seed meals sheet + contract + a pre-existing non-conforming record');

    const { stdout, exitCode } = await runCli(['contracts', 'verify'], fixture.path);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('error:');
    expect(stdout).toContain('CONTRACT_UNSATISFIED');
    expect(stdout).toContain('soup');
    expect(stdout).toContain(CONTRACT_NAME);
    expect(stdout).toMatch(/name/);
  });

  it('reports skipped for sheets that declare no contracts', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG_NO_CONTRACT);
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'meals sheet, no contract');

    const { stdout, exitCode } = await runCli(['contracts', 'verify'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('skipped');
  });

  it('warns (not fails) when a conforming sheet\'s local schema closes additionalProperties', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG_CLOSED);
    await vendorContract(fixture);
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'seed meals sheet + contract, closed local schema');

    const up = await runCli(['upsert', 'meals', '--data', '{"slug":"soup","name":"Soup"}'], fixture.path);
    expect(up.exitCode).toBe(0);
    await fixture.git('reset', '--hard', 'HEAD');

    const { stdout, exitCode } = await runCli(['contracts', 'verify'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('warning');
    expect(stdout).toContain('additionalProperties');
  });

  it('fails with CONTRACT_UNSATISFIED when a declared contract has no vendored document', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG);
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'declares a contract with nothing vendored');

    const { stdout, exitCode } = await runCli(['contracts', 'verify'], fixture.path);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('CONTRACT_UNSATISFIED');
    expect(stdout).toContain(CONTRACT_NAME);
  });

  it('fails with CONTRACT_UNSATISFIED when the vendored document is not canonical TOML', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG);
    // Hand-authored TOML: valid data, but NOT the canonical (deep-key-sorted)
    // encoding — re-encoding it produces different bytes.
    await mkdir(join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'meals'), { recursive: true });
    await writeFile(
      join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'meals', 'v1.toml'),
      `type = "object"\nrequired = ["name"]\n"$id" = "https://${CONTRACT_NAME}"\n\n[properties.name]\ntype = "string"\n`,
    );
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'vendors a non-canonical contract document');

    const { stdout, exitCode } = await runCli(['contracts', 'verify'], fixture.path);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('CONTRACT_UNSATISFIED');
    expect(stdout).toContain('not canonical');
  });
});

describe('contracts test', () => {
  it('duck-types a contract-unaware sheet against a vendored contract name', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    // Sheet declares NOTHING — pure duck typing.
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG_NO_CONTRACT);
    await vendorContract(fixture);
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'meals sheet, contract vendored but not declared');

    const up = await runCli(['upsert', 'meals', '--data', '{"slug":"soup","name":"Soup"}'], fixture.path);
    expect(up.exitCode).toBe(0);
    await fixture.git('reset', '--hard', 'HEAD');

    const { stdout, exitCode } = await runCli(
      ['contracts', 'test', 'meals', '--against', CONTRACT_NAME],
      fixture.path,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('conforms');
    expect(stdout).toContain('records_checked: 1');
  });

  it('duck-types against an arbitrary local file, and fails with per-record detail on non-conformance', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG_NO_CONTRACT);
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'meals sheet, no contract');

    // Record lacks `name`, which the ad-hoc file-based contract requires.
    const up = await runCli(['upsert', 'meals', '--data', '{"slug":"soup"}'], fixture.path);
    expect(up.exitCode).toBe(0);
    await fixture.git('reset', '--hard', 'HEAD');

    const docPath = join(fixture.path, 'meals-contract.json');
    await writeFile(docPath, JSON.stringify(CONTRACT_DOC));

    const { stdout, exitCode } = await runCli(
      ['contracts', 'test', 'meals', '--against', docPath],
      fixture.path,
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('CONTRACT_UNSATISFIED');
    expect(stdout).toContain('soup');
  });

  it('reports trivial conformance for a sheet with no records', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG_NO_CONTRACT);
    await vendorContract(fixture);
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'meals sheet, no records');

    const { stdout, exitCode } = await runCli(
      ['contracts', 'test', 'meals', '--against', CONTRACT_NAME],
      fixture.path,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('trivially conforms');
  });
});
