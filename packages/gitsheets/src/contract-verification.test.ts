// Consumer-side contract verification — the two-rung ladder in
// `openSheet(name, { contract })`. See specs/behaviors/contracts.md "Consumer
// verification" and specs/api/repository.md `opts.contract`.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContractError } from './errors.js';
import { openRepo } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';
import { stringifyRecord } from './toml.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

async function makeRepo(): Promise<TestRepoHandle> {
  const h = await testRepo({ withInitialCommit: true });
  handles.push(h);
  return h;
}

const AUTHOR = { name: 'Test', email: 'test@gitsheets.local' };

/** A minimal contract requiring `required` string fields, keyed by `$id = https://<name>`. */
function contractDoc(name: string, required: string[] = ['name']): Record<string, unknown> {
  return {
    $id: `https://${name}`,
    type: 'object',
    required,
    properties: Object.fromEntries(required.map((f) => [f, { type: 'string' }])),
  };
}

/** Vendor `doc` at its derived path (`.gitsheets/contracts/<name>.toml`), staged but not committed. */
async function stageVendoredContract(
  fixture: TestRepoHandle,
  name: string,
  doc: Record<string, unknown>,
): Promise<void> {
  const segments = name.split('/');
  const dir = join(fixture.path, '.gitsheets/contracts', ...segments.slice(0, -1));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${segments.at(-1)}.toml`), stringifyRecord(doc));
  await fixture.git('add', '.gitsheets/contracts');
}

/** Seed `.gitsheets/meals.toml` declaring `implementsNames`, staged but not committed. */
async function stageMealsConfig(
  fixture: TestRepoHandle,
  implementsNames: string[] = [],
): Promise<void> {
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  const implementsLine =
    implementsNames.length > 0
      ? `implements = [${implementsNames.map((n) => `'${n}'`).join(', ')}]\n`
      : '';
  await writeFile(
    join(fixture.path, '.gitsheets/meals.toml'),
    `[gitsheet]\nroot = 'meals'\npath = '\${{ slug }}'\n${implementsLine}`,
  );
  await fixture.git('add', '.gitsheets/meals.toml');
}

const MEALS_V1 = 'example.com/meals/v1';
const MEALS_V1_1 = 'example.com/meals/v1.1';

describe('openSheet contract verification — rung 1 (declared identity)', () => {
  it('passes with zero record reads when the sheet declares the byte-identical contract', async () => {
    const fixture = await makeRepo();
    const doc = contractDoc(MEALS_V1);
    await stageMealsConfig(fixture, [MEALS_V1]);
    await stageVendoredContract(fixture, MEALS_V1, doc);
    // A garbage record file that would blow up record parsing if rung 1 ever
    // fell through to reading records — proves the zero-record-read claim.
    await mkdir(join(fixture.path, 'meals'), { recursive: true });
    await writeFile(join(fixture.path, 'meals/garbage.toml'), 'not [ valid toml');
    await fixture.git('add', '.');
    await fixture.git('commit', '-m', 'seed meals');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    const meals = await repo.openSheet('meals', { contract: { schema: doc } });

    expect(meals.contractVerification).toMatchObject({
      name: MEALS_V1,
      rung: 'declared',
      conforming: true,
    });
    expect(meals.contractVerification?.issues).toEqual([]);
  });

  it('falls through to rung 2 (structural) when the producer implements a newer, data-compatible version', async () => {
    const fixture = await makeRepo();
    const docV1_1 = contractDoc(MEALS_V1_1, ['name']);
    await stageMealsConfig(fixture, [MEALS_V1_1]);
    await stageVendoredContract(fixture, MEALS_V1_1, docV1_1);
    await fixture.git('commit', '-m', 'seed meals');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'add a meal', author: AUTHOR }, async (tx) =>
      tx.sheet('meals').upsert({ slug: 'chili', name: 'Chili' }),
    );

    // The consumer still holds v1 — rung 1 misses (v1 isn't declared), but
    // the producer's data satisfies v1's requirements too.
    const docV1 = contractDoc(MEALS_V1, ['name']);
    const meals = await repo.openSheet('meals', { contract: { schema: docV1 } });
    expect(meals.contractVerification).toMatchObject({
      name: MEALS_V1,
      rung: 'structural',
      conforming: true,
    });
  });
});

describe('openSheet contract verification — rung 2 (structural) failures', () => {
  it('reports a per-record, per-field conformance report naming the contract', async () => {
    const fixture = await makeRepo();
    await stageMealsConfig(fixture); // contract-unaware sheet
    await fixture.git('commit', '-m', 'seed meals');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'add meals', author: AUTHOR }, async (tx) => {
      await tx.sheet('meals').upsert({ slug: 'chili', name: 'Chili' });
      await tx.sheet('meals').upsert({ slug: 'soup' }); // missing `name`
    });

    const doc = contractDoc(MEALS_V1, ['name']);
    await expect(repo.openSheet('meals', { contract: { schema: doc } })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(ContractError);
        const ce = err as ContractError;
        expect(ce.code).toBe('contract_unsatisfied');
        expect(ce.contract).toBe(MEALS_V1);
        const issue = ce.issues?.find((i) => i.record === 'soup');
        expect(issue).toBeDefined();
        expect(issue?.contract).toBe(MEALS_V1);
        expect(issue?.code).toBe('required');
        expect(ce.issues?.some((i) => i.record === 'chili')).toBe(false);
        return true;
      },
    );
  });
});

describe('openSheet contract verification — modes', () => {
  it('declared mode refuses without reading records, never falling back to structural', async () => {
    const fixture = await makeRepo();
    await stageMealsConfig(fixture); // not declared at all
    await mkdir(join(fixture.path, 'meals'), { recursive: true });
    await writeFile(join(fixture.path, 'meals/garbage.toml'), 'not [ valid toml');
    await fixture.git('add', '.');
    await fixture.git('commit', '-m', 'seed meals');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    const doc = contractDoc(MEALS_V1);
    await expect(
      repo.openSheet('meals', { contract: { schema: doc, mode: 'declared' } }),
    ).rejects.toThrow(ContractError);
  });

  it('structural mode duck-types a contract-unaware sheet, ignoring declarations', async () => {
    const fixture = await makeRepo();
    await stageMealsConfig(fixture); // no implements
    await fixture.git('commit', '-m', 'seed meals');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'add a meal', author: AUTHOR }, async (tx) =>
      tx.sheet('meals').upsert({ slug: 'chili', name: 'Chili' }),
    );

    const doc = contractDoc(MEALS_V1);
    const meals = await repo.openSheet('meals', {
      contract: { schema: doc, mode: 'structural' },
    });
    expect(meals.contractVerification).toMatchObject({ rung: 'structural', conforming: true });
  });
});

describe('openSheet contract verification — advisory drift', () => {
  it('fires onDrift after a non-conforming commit while reads still succeed', async () => {
    const fixture = await makeRepo();
    await stageMealsConfig(fixture); // contract-unaware — rung 2 duck typing
    await fixture.git('commit', '-m', 'seed meals');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'add a conforming meal', author: AUTHOR }, async (tx) =>
      tx.sheet('meals').upsert({ slug: 'chili', name: 'Chili' }),
    );

    const doc = contractDoc(MEALS_V1);
    const onDrift = vi.fn();
    const meals = await repo.openSheet('meals', {
      contract: { schema: doc, mode: 'structural', onDrift },
    });
    expect(meals.contractVerification?.conforming).toBe(true);

    // A producer commit that regresses conformance (no `name`) — the sheet's
    // own schema doesn't require it, only the consumer's contract does.
    await repo.transact({ message: 'add a non-conforming meal', author: AUTHOR }, async (tx) =>
      tx.sheet('meals').upsert({ slug: 'mystery' }),
    );

    // The drift re-check is lazy/async (fire-and-forget) — flush microtasks.
    await new Promise((resolve) => setImmediate(resolve));

    expect(onDrift).toHaveBeenCalledTimes(1);
    const report = onDrift.mock.calls[0]?.[0];
    expect(report).toMatchObject({ name: MEALS_V1, conforming: false });
    expect(report.issues.some((i: { record?: string }) => i.record === 'mystery')).toBe(true);

    // Reads are never gated on drift.
    const all: unknown[] = [];
    for await (const record of meals.query({})) all.push(record);
    expect(all).toHaveLength(2);
  });
});

describe('openSheet contract verification — end to end', () => {
  it('a consumer holding a contract wires to a fixture meal-bank sheet in another repo', async () => {
    const producer = await makeRepo();
    const doc = contractDoc(MEALS_V1, ['name', 'servings']);
    await stageMealsConfig(producer, [MEALS_V1]);
    await stageVendoredContract(producer, MEALS_V1, doc);
    await producer.git('commit', '-m', 'seed meal-bank');

    const producerRepo = await openRepo({ gitDir: producer.gitDir });
    await producerRepo.transact({ message: 'stock the meal bank', author: AUTHOR }, async (tx) => {
      await tx.sheet('meals').upsert({ slug: 'chili', name: 'Chili', servings: '4' });
      await tx.sheet('meals').upsert({ slug: 'soup', name: 'Soup', servings: '2' });
    });

    // The consumer holds its own copy of the contract document (e.g. vendored
    // in ITS repo, or embedded in code) — a separate repo entirely.
    const mealBank = await producerRepo.openSheet('meals', { contract: { schema: doc } });
    expect(mealBank.contractVerification).toMatchObject({ name: MEALS_V1, rung: 'declared' });

    const meals: Array<{ slug: string; name: string; servings: string }> = [];
    for await (const record of mealBank.query({})) {
      meals.push(record as { slug: string; name: string; servings: string });
    }
    expect(meals.map((m) => m.slug).sort()).toEqual(['chili', 'soup']);
  });
});
