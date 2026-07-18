// CLI `contracts` command group — adopt, verify, test, sync, export, prune.
// See specs/api/cli.md ("git sheet contracts") and specs/behaviors/contracts.md.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from './index.js';
import { stringifyRecord } from '../toml.js';
import { testRepo, type TestRepoHandle } from '../test-helpers/test-repo.js';

const exec = promisify(execFile);

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
  vi.unstubAllGlobals();
});

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

/** Feed `text` to `process.stdin` for the duration of `fn`, then restore. */
async function withStdin<T>(text: string, fn: () => Promise<T>): Promise<T> {
  const original = process.stdin;
  const fake = Readable.from([Buffer.from(text, 'utf8')]);
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'stdin', { value: original, configurable: true });
  }
}

async function blobAt(fixture: TestRepoHandle, ref: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd: fixture.path });
    return stdout;
  } catch {
    return null;
  }
}

async function headHash(fixture: TestRepoHandle): Promise<string> {
  const { stdout } = await fixture.git('rev-parse', 'HEAD');
  return stdout.trim();
}

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

const MEALS_CONFIG_NO_CONTRACT = `[gitsheet]
root = 'meals'
path = '\${{ slug }}'
`;

/** A repo with a `meals` sheet declaring CONTRACT_NAME, the contract already vendored, and one conforming record. */
async function seedConformingRepo(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'meals'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG);
  await writeFile(
    join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'meals', 'v1.toml'),
    canonicalContractText(),
  );
  await fixture.git('add', '.gitsheets');
  await fixture.git('commit', '-m', 'seed meals sheet + contract');

  const cap = captureStreams();
  const code = await main(['--git-dir', fixture.gitDir, 'upsert', 'meals', '{"slug":"soup","name":"Soup"}']);
  cap.restore();
  expect(code).toBe(0);
  // `upsert` commits via direct git-object writes (`repo.transact`), bypassing
  // the working tree/index entirely. Sync both to the new HEAD so a caller's
  // subsequent manual `git add` + commit doesn't silently drop the upserted
  // record from history (it would otherwise stage the STALE pre-upsert tree).
  await fixture.git('reset', '--hard', 'HEAD');
  return fixture;
}

describe('CLI contracts adopt', () => {
  it('adopts a JSON local file, vendors it canonically, records provenance, and prints the implements hint', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);

    const docPath = join(fixture.path, 'meals-v1.schema.json');
    await writeFile(docPath, JSON.stringify(CONTRACT_DOC));

    const cap = captureStreams();
    const code = await main(['--git-dir', fixture.gitDir, 'contracts', 'adopt', docPath]);
    const { stdout } = cap.restore();
    expect(code).toBe(0);
    expect(stdout).toContain(`adopted ${CONTRACT_NAME}`);
    expect(stdout).toContain(`implements = ['${CONTRACT_NAME}']`);

    const vendored = await blobAt(
      fixture,
      'HEAD',
      '.gitsheets/contracts/test.local/meals/v1.toml',
    );
    expect(vendored).toBe(canonicalContractText());

    const sources = await blobAt(fixture, 'HEAD', '.gitsheets/contracts/sources.toml');
    expect(sources).toContain(docPath);
  });

  it('adopting the same document from a local TOML file produces byte-identical vendored bytes', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);

    const docPath = join(fixture.path, 'meals-v1.schema.toml');
    await writeFile(docPath, canonicalContractText());

    const code = await main(['--git-dir', fixture.gitDir, 'contracts', 'adopt', docPath]);
    expect(code).toBe(0);

    const vendored = await blobAt(fixture, 'HEAD', '.gitsheets/contracts/test.local/meals/v1.toml');
    expect(vendored).toBe(canonicalContractText());
  });

  it('adopts over HTTPS (fetch mocked — see plan Risks: no real network in unit tests)', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);

    const url = 'https://contracts.example.com/meals/v1.schema.json';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(CONTRACT_DOC),
      })),
    );

    const code = await main(['--git-dir', fixture.gitDir, 'contracts', 'adopt', url]);
    expect(code).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    const vendored = await blobAt(fixture, 'HEAD', '.gitsheets/contracts/test.local/meals/v1.toml');
    expect(vendored).toBe(canonicalContractText());
    const sources = await blobAt(fixture, 'HEAD', '.gitsheets/contracts/sources.toml');
    expect(sources).toContain(url);
  });

  it('--sheet refuses adoption when an existing record fails the new effective schema, leaving the tree untouched', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG_NO_CONTRACT);
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'seed meals sheet');

    // Existing record has no `name` — the candidate contract requires it.
    let code = await main([
      '--git-dir',
      fixture.gitDir,
      'upsert',
      'meals',
      '{"slug":"soup"}',
    ]);
    expect(code).toBe(0);

    const before = await headHash(fixture);
    const docPath = join(fixture.path, 'meals-v1.schema.json');
    await writeFile(docPath, JSON.stringify(CONTRACT_DOC));

    const cap = captureStreams();
    code = await main([
      '--git-dir',
      fixture.gitDir,
      'contracts',
      'adopt',
      docPath,
      '--sheet',
      'meals',
    ]);
    const { stderr } = cap.restore();
    expect(code).toBe(67);
    expect(stderr).toContain('soup');
    expect(stderr).toContain('name');

    const after = await headHash(fixture);
    expect(after).toBe(before); // tree untouched
    const vendored = await blobAt(fixture, 'HEAD', '.gitsheets/contracts/test.local/meals/v1.toml');
    expect(vendored).toBeNull();
  });
});

describe('CLI contracts verify', () => {
  it('passes on a conforming fixture repo', async () => {
    const fixture = await seedConformingRepo();
    const cap = captureStreams();
    const code = await main(['--git-dir', fixture.gitDir, 'contracts', 'verify']);
    const { stdout } = cap.restore();
    expect(code).toBe(0);
    expect(stdout).toContain('ok');
  });

  it('fails (exit 67) when a declared contract has no vendored document (contract_missing)', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG);
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'declares a contract with nothing vendored');

    const cap = captureStreams();
    const code = await main(['--git-dir', fixture.gitDir, 'contracts', 'verify']);
    const { stderr } = cap.restore();
    expect(code).toBe(67);
    expect(stderr).toContain(CONTRACT_NAME);
  });

  it('fails (exit 67) when the vendored document is not canonical (contract_invalid)', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'meals'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG);
    // Deliberately non-canonical: keys out of sorted order.
    await writeFile(
      join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'meals', 'v1.toml'),
      `type = 'object'\n'$id' = 'https://${CONTRACT_NAME}'\nrequired = ['name']\n`,
    );
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'non-canonical vendored contract');

    const cap = captureStreams();
    const code = await main(['--git-dir', fixture.gitDir, 'contracts', 'verify']);
    const { stderr } = cap.restore();
    expect(code).toBe(67);
    expect(stderr).toContain('canonical');
  });

  it('fails (exit 67) when an existing record violates the effective schema', async () => {
    // Contract enforcement composes into every WRITE, so a non-conforming
    // record can never be upserted once a sheet declares the contract — the
    // scenario `verify` exists to catch is a sheet config hand-edited to add
    // `implements` (a plain author edit, never tooling-managed) AFTER
    // records were written under a laxer (or absent) local schema.
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG_NO_CONTRACT);
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'seed meals sheet, no contract yet');
    let code = await main(['--git-dir', fixture.gitDir, 'upsert', 'meals', '{"slug":"bad","name":""}']);
    expect(code).toBe(0);
    // See seedConformingRepo's comment: sync the working tree/index to HEAD
    // before manually staging further changes, or this upsert's record would
    // be silently dropped from the next hand-built commit.
    await fixture.git('reset', '--hard', 'HEAD');

    // Now the author hand-edits the config to declare the contract, and the
    // contract gets vendored — without ever running `adopt --sheet`.
    await mkdir(join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'meals'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG);
    await writeFile(
      join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'meals', 'v1.toml'),
      canonicalContractText(),
    );
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'declare the contract after the fact');

    const cap = captureStreams();
    code = await main(['--git-dir', fixture.gitDir, 'contracts', 'verify']);
    const { stderr } = cap.restore();
    expect(code).toBe(67);
    expect(stderr).toContain('bad');
  });

  it('warns (stderr, exit 0) when a declaring sheet closes its local schema with additionalProperties: false', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'meals'), { recursive: true });
    await writeFile(
      join(fixture.path, '.gitsheets', 'meals.toml'),
      `[gitsheet]
root = 'meals'
path = '\${{ slug }}'
implements = ['${CONTRACT_NAME}']

[gitsheet.schema]
type = 'object'
additionalProperties = false

[gitsheet.schema.properties.slug]
type = 'string'

[gitsheet.schema.properties.name]
type = 'string'
`,
    );
    await writeFile(
      join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'meals', 'v1.toml'),
      canonicalContractText(),
    );
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'closed local schema');
    let code = await main(['--git-dir', fixture.gitDir, 'upsert', 'meals', '{"slug":"soup","name":"Soup"}']);
    expect(code).toBe(0);

    const cap = captureStreams();
    code = await main(['--git-dir', fixture.gitDir, 'contracts', 'verify']);
    const { stdout, stderr } = cap.restore();
    expect(code).toBe(0);
    expect(stderr).toContain('additionalProperties');
    expect(stdout).toContain('ok');
  });
});

describe('CLI contracts test', () => {
  it('passes against a contract-unaware sheet whose records conform', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG_NO_CONTRACT);
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'seed meals sheet, no contracts');
    let code = await main(['--git-dir', fixture.gitDir, 'upsert', 'meals', '{"slug":"soup","name":"Soup"}']);
    expect(code).toBe(0);

    const docPath = join(fixture.path, 'meals-v1.schema.json');
    await writeFile(docPath, JSON.stringify(CONTRACT_DOC));

    const cap = captureStreams();
    code = await main(['--git-dir', fixture.gitDir, 'contracts', 'test', 'meals', '--against', docPath]);
    const { stdout } = cap.restore();
    expect(code).toBe(0);
    expect(stdout).toContain('ok soup');
  });

  it('reports per-record issues (exit 67) against a sheet whose records do not conform', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(join(fixture.path, '.gitsheets', 'meals.toml'), MEALS_CONFIG_NO_CONTRACT);
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'seed meals sheet, no contracts');
    let code = await main(['--git-dir', fixture.gitDir, 'upsert', 'meals', '{"slug":"soup"}']); // no name
    expect(code).toBe(0);

    const docPath = join(fixture.path, 'meals-v1.schema.json');
    await writeFile(docPath, JSON.stringify(CONTRACT_DOC));

    const cap = captureStreams();
    code = await main(['--git-dir', fixture.gitDir, 'contracts', 'test', 'meals', '--against', docPath]);
    const { stderr } = cap.restore();
    expect(code).toBe(67);
    expect(stderr).toContain('soup');
  });
});

describe('CLI contracts sync', () => {
  it('reports drift when the upstream fixture changes, and never modifies the vendored file', async () => {
    const fixture = await seedConformingRepo();
    const url = 'https://contracts.example.com/meals/v1.schema.json';

    // Record provenance manually (this fixture's contract was vendored by
    // hand in seedConformingRepo, not via `adopt`, so it has no sources.toml
    // entry yet) — mirrors what a prior real `adopt <url>` would have left.
    await writeFile(
      join(fixture.path, '.gitsheets', 'contracts', 'sources.toml'),
      `['${CONTRACT_NAME}']\nsource = '${url}'\nadopted = 2026-01-01T00:00:00Z\n`,
    );
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'record provenance');

    const before = await blobAt(fixture, 'HEAD', '.gitsheets/contracts/test.local/meals/v1.toml');

    // First sync: upstream matches vendored bytes exactly.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(CONTRACT_DOC) })),
    );
    let cap = captureStreams();
    let code = await main(['--git-dir', fixture.gitDir, 'contracts', 'sync']);
    let out = cap.restore();
    expect(code).toBe(0);
    expect(out.stdout).toContain(`match ${CONTRACT_NAME}`);
    vi.unstubAllGlobals();

    // Upstream has since changed — sync must report drift, not rewrite.
    const drifted = { ...CONTRACT_DOC, required: ['name', 'servedAt'] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(drifted) })),
    );
    cap = captureStreams();
    code = await main(['--git-dir', fixture.gitDir, 'contracts', 'sync']);
    out = cap.restore();
    expect(code).toBe(0);
    expect(out.stdout).toContain(`drift ${CONTRACT_NAME}`);

    const after = await blobAt(fixture, 'HEAD', '.gitsheets/contracts/test.local/meals/v1.toml');
    expect(after).toBe(before); // never rewritten
  });

  it('lists an entry with no recorded source as unsyncable (an adopt-from-stdin has none)', async () => {
    const fixture = await seedConformingRepo();
    // A contract adopted from stdin ('-') never gets a sources.toml entry
    // (readContractsAdopt's documented no-loss-of-function case) — simulate
    // the sidecar entry an operator might still hand-add without a source.
    await writeFile(
      join(fixture.path, '.gitsheets', 'contracts', 'sources.toml'),
      `['${CONTRACT_NAME}']\nadopted = 2026-01-01T00:00:00Z\n`,
    );
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'sidecar entry with no source');

    const cap = captureStreams();
    const code = await main(['--git-dir', fixture.gitDir, 'contracts', 'sync']);
    const { stdout } = cap.restore();
    expect(code).toBe(0);
    expect(stdout).toContain(`unsyncable ${CONTRACT_NAME}`);
  });
});

describe('CLI contracts export', () => {
  it('round-trips through `adopt -` to identical vendored bytes', async () => {
    const fixture = await seedConformingRepo();

    const cap = captureStreams();
    const code = await main(['--git-dir', fixture.gitDir, 'contracts', 'export', CONTRACT_NAME]);
    const { stdout } = cap.restore();
    expect(code).toBe(0);

    const before = await blobAt(fixture, 'HEAD', '.gitsheets/contracts/test.local/meals/v1.toml');

    // A second, throwaway repo re-adopts the exported JSON via stdin.
    const fixture2 = await testRepo({ withInitialCommit: true });
    handles.push(fixture2);
    const code2 = await withStdin(stdout, () =>
      main(['--git-dir', fixture2.gitDir, 'contracts', 'adopt', '-']),
    );
    expect(code2).toBe(0);

    const after = await blobAt(fixture2, 'HEAD', '.gitsheets/contracts/test.local/meals/v1.toml');
    expect(after).toBe(before);
  });
});

describe('CLI contracts prune', () => {
  it('--dry-run lists exactly the undeclared vendored documents and removes nothing', async () => {
    const fixture = await seedConformingRepo();
    // An orphan: vendored, but no sheet declares it.
    await mkdir(join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'orphans'), { recursive: true });
    await writeFile(
      join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'orphans', 'v1.toml'),
      stringifyRecord({ $id: 'https://test.local/orphans/v1', type: 'object' }),
    );
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'add an orphan contract');

    const cap = captureStreams();
    const code = await main(['--git-dir', fixture.gitDir, 'contracts', 'prune', '--dry-run']);
    const { stdout } = cap.restore();
    expect(code).toBe(0);
    expect(stdout).toContain('would remove test.local/orphans/v1');
    expect(stdout).not.toContain(CONTRACT_NAME); // the declared one is not listed

    const stillThere = await blobAt(fixture, 'HEAD', '.gitsheets/contracts/test.local/orphans/v1.toml');
    expect(stillThere).not.toBeNull();
  });

  it('removes orphans with --yes (bypassing the confirmation prompt)', async () => {
    const fixture = await seedConformingRepo();
    await mkdir(join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'orphans'), { recursive: true });
    await writeFile(
      join(fixture.path, '.gitsheets', 'contracts', 'test.local', 'orphans', 'v1.toml'),
      stringifyRecord({ $id: 'https://test.local/orphans/v1', type: 'object' }),
    );
    await fixture.git('add', '.gitsheets');
    await fixture.git('commit', '-m', 'add an orphan contract');

    const code = await main(['--git-dir', fixture.gitDir, 'contracts', 'prune', '--yes']);
    expect(code).toBe(0);

    const gone = await blobAt(fixture, 'HEAD', '.gitsheets/contracts/test.local/orphans/v1.toml');
    expect(gone).toBeNull();
    const stillDeclared = await blobAt(fixture, 'HEAD', '.gitsheets/contracts/test.local/meals/v1.toml');
    expect(stillDeclared).not.toBeNull();
  });

  it('nothing to prune when every vendored document is declared', async () => {
    const fixture = await seedConformingRepo();
    const cap = captureStreams();
    const code = await main(['--git-dir', fixture.gitDir, 'contracts', 'prune', '--dry-run']);
    const { stdout } = cap.restore();
    expect(code).toBe(0);
    expect(stdout).toContain('nothing to prune');
  });
});
