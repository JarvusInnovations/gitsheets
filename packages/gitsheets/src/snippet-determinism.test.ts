// The deterministic realm for definition snippets on the Node binding (#362):
// path-template expressions (the exported `Template`, `pathForRecord`) and
// raw-JS sort comparators (`normalizeRecord`) run host-side in `node:vm`, held
// to the core engine's contract — specs/rust-core.md "Determinism rule for
// definition snippets". Each behavior is checked against the core (the napi
// addon's boa engine) as well as on its own.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addon } from './core.js';
import { ConfigError, PathTemplateError } from './errors.js';
import { Template } from './path-template/index.js';
import { openRepo } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

// A host zone far from UTC: anything reading host local time shows it.
const savedTz = process.env['TZ'];
beforeEach(() => {
  process.env['TZ'] = 'America/New_York';
});
afterEach(() => {
  if (savedTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = savedTz;
  Template.clearCache();
});

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.cleanup();
});

const FORBIDDEN: Array<[string, string]> = [
  ['Date.now()', 'Date.now()'],
  ['Math.random()', 'Math.random()'],
  ['new Date().getUTCFullYear()', 'new Date() with no arguments'],
  ['Date()', 'Date()'],
  ['new Date(0).toLocaleString()', 'toLocaleString()'],
];

function renderError(template: string, record: Record<string, unknown>): PathTemplateError {
  try {
    Template.fromString(template).render(record);
  } catch (err) {
    return err as PathTemplateError;
  }
  throw new Error(`${template} rendered`);
}

describe('Template expressions run in the deterministic realm', () => {
  it('the host zone really is non-UTC (guards the tests below)', () => {
    expect(new Date('2026-03-04T02:06:07Z').getHours()).toBe(21);
  });

  it.each(FORBIDDEN)('%s fails the render with path_render_failed naming expression and call', (expr, named) => {
    const err = renderError(`\${{ ${expr} }}/\${{ slug }}`, { slug: 'x' });
    expect(err).toBeInstanceOf(PathTemplateError);
    expect(err.code).toBe('path_render_failed');
    expect(err.message).toContain(`\${{ ${expr} }}`);
    expect(err.message).toContain(named);
    expect(err.message).toContain('not available in a gitsheets snippet');
    // The core says the same thing.
    expect(() => addon.renderPathsBatch(`\${{ ${expr} }}/\${{ slug }}`, [{ slug: 'x' }])).toThrow(named);
  });

  it('local-time Date methods read UTC — and match the core', () => {
    const record = { at: new Date('2026-03-04T02:06:07Z'), slug: 'x' };
    const cases: Array<[string, string]> = [
      ['${{ at.getFullYear() }}/${{ at.getMonth() }}/${{ at.getDate() }}/${{ at.getHours() }}', '2026/2/4/2'],
      ['${{ at.getDay() }}-${{ at.getMinutes() }}-${{ at.getTimezoneOffset() }}', '3-6-0'],
      ['${{ at.toString().split(" ").join("_").split(":").join("-") }}', 'Wed_Mar_04_2026_02-06-07_GMT+0000'],
      ['${{ at.toDateString().split(" ").join("_") }}', 'Wed_Mar_04_2026'],
      ['${{ new Date(2026, 0, 1, 5).getTime() }}', '1767243600000'],
      ['${{ Date.parse("2026-01-01T05:00") }}', '1767243600000'],
      ['${{ new Date("2026-01-01T05:00").getHours() }}', '5'],
      // Argument-taking forms keep working.
      ['${{ new Date(at.getTime() + 86400000).getUTCDate() }}', '5'],
      ['${{ Date.UTC(2026, 0, 1) }}', '1767225600000'],
      ['${{ Date.parse("2026-01-01T00:00:00Z") }}', '1767225600000'],
      ['${{ Date.parse("Wed Mar 04 2026 02:06:07 GMT+0000") }}', '1772589967000'],
      ['${{ String(at instanceof Date) }}', 'true'],
    ];
    for (const [template, expected] of cases) {
      expect(Template.fromString(template).render(record), template).toBe(expected);
      expect(addon.renderPathsBatch(template, [record]), `core: ${template}`).toEqual([expected]);
    }
  });

  it('an expression cannot reach a record value through the host realm', () => {
    // The record's Date is rebuilt in the realm, so its prototype is the
    // patched one even though the caller handed in a host Date.
    const t = Template.fromString('${{ at.getHours() }}');
    expect(t.render({ at: new Date('2026-03-04T23:00:00Z') })).toBe('23');
  });
});

describe('raw-JS comparators run in the deterministic realm', () => {
  async function sheetWithSort(rule: string) {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(
      join(fixture.path, '.gitsheets', 'events.toml'),
      `[gitsheet]\nroot = 'events'\npath = '\${{ slug }}'\n\n[gitsheet.fields.times]\nsort = ${JSON.stringify(rule)}\n`,
    );
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'add events sheet');
    const repo = await openRepo({ gitDir: fixture.gitDir });
    return { repo, fixture, sheet: await repo.openSheet('events') };
  }

  it('a local-hour comparator sorts by UTC hour in normalizeRecord and on write alike', async () => {
    const { repo, sheet, fixture } = await sheetWithSort('return a.getHours() - b.getHours();');
    // UTC hours 23 and 1 → the 01:00 entry first. New York hours (18, 20)
    // would keep the input order.
    const late = new Date('2026-03-04T23:00:00Z');
    const early = new Date('2026-03-05T01:00:00Z');
    const normalized = await sheet.normalizeRecord({ slug: 'x', times: [late, early] });
    expect((normalized['times'] as Date[]).map((d) => d.toISOString())).toEqual([
      early.toISOString(),
      late.toISOString(),
    ]);

    await repo.transact({ message: 'write' }, async (tx) => {
      await tx.sheet('events').upsert({ slug: 'x', times: [late, early] });
    });
    const { stdout } = await fixture.git('show', 'main:events/x.toml');
    expect(stdout.indexOf('2026-03-05T01:00:00')).toBeLessThan(stdout.indexOf('2026-03-04T23:00:00'));
    expect(addon.runComparator('return a.getHours() - b.getHours();', late, early)).toBe(22);
  });

  it.each([
    ['return Math.random() - 0.5;', 'Math.random()'],
    ['return Date.now() - a;', 'Date.now()'],
    ['return new Date() - a;', 'new Date() with no arguments'],
  ])('%s is ConfigError config_invalid naming the field and the call', async (rule, named) => {
    const { repo, sheet } = await sheetWithSort(rule);
    const record = { slug: 'x', times: [2, 1] };

    const viaVm = await sheet.normalizeRecord(record).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(viaVm).toBeInstanceOf(ConfigError);
    expect((viaVm as ConfigError).code).toBe('config_invalid');
    expect((viaVm as Error).message).toContain('"times"');
    expect((viaVm as Error).message).toContain(named);

    const viaCore = await repo
      .transact({ message: 'write' }, async (tx) => {
        await tx.sheet('events').upsert(record);
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(viaCore).toBeInstanceOf(ConfigError);
    expect((viaCore as ConfigError).code).toBe('config_invalid');
    expect((viaCore as Error).message).toContain('"times"');
    expect((viaCore as Error).message).toContain(named);
  });
});
