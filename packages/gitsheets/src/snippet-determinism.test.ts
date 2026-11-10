// Definition snippets on the Node binding — path-template expressions (the
// exported `Template`, `pathForRecord`, `queryTree`) and raw-JS sort
// comparators (`normalizeRecord`) — run in the core's engine, the same one
// the write path uses (#373). There is no host realm to compare against:
// these tests pin the single engine's behavior through the public API, hold
// it to the determinism rule (specs/rust-core.md "Determinism rule for
// definition snippets"), and assert that what `pathForRecord` /
// `normalizeRecord` compute is exactly what a write commits.

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, PathTemplateError, ValidationError } from './errors.js';
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

async function sheetWithConfig(config: string) {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'events.toml'), config);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add events sheet');
  const repo = await openRepo({ gitDir: fixture.gitDir });
  return { repo, fixture, sheet: await repo.openSheet('events') };
}

function sheetWithSort(rule: string) {
  return sheetWithConfig(
    `[gitsheet]\nroot = 'events'\npath = '\${{ slug }}'\n\n[gitsheet.fields.times]\nsort = ${JSON.stringify(rule)}\n`,
  );
}

// --- No host realm ------------------------------------------------------------

describe('no definition snippet runs in the host runtime', () => {
  const srcDir = dirname(fileURLToPath(import.meta.url));

  it('the node:vm shim is gone', () => {
    expect(existsSync(join(srcDir, 'sandbox.ts'))).toBe(false);
  });

  it('no non-test source under packages/gitsheets/src imports node:vm', async () => {
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (/\.[cm]?[jt]s$/.test(entry.name) && !/\.test\.[cm]?[jt]s$/.test(entry.name)) {
          const text = await readFile(full, 'utf8');
          if (/['"](node:)?vm['"]/.test(text)) offenders.push(full.slice(srcDir.length + 1));
        }
      }
    };
    await walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

// --- Template expressions -----------------------------------------------------

describe('Template expressions run in the deterministic core realm', () => {
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
  });

  it('local-time Date methods read UTC', () => {
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
      // Locale methods are locale-free.
      ['${{ "a".localeCompare("B") }}', '1'],
      ['${{ (1234.5).toLocaleString() }}', '1234.5'],
      ['${{ typeof Intl }}-${{ typeof console }}-${{ typeof WebAssembly }}', 'undefined-undefined-undefined'],
    ];
    for (const [template, expected] of cases) {
      expect(Template.fromString(template).render(record), template).toBe(expected);
    }
  });

  it('a bare datetime field is un-renderable (no host Date#toString)', () => {
    const err = renderError('${{ at }}', { at: new Date('2026-03-04T02:06:07Z') });
    expect(err).toBeInstanceOf(PathTemplateError);
    expect(err.code).toBe('path_render_failed');
  });

  it('a record value the core cannot marshal fails the render, even off-template', () => {
    for (const record of [
      { slug: 'x', f: () => 1 },
      { slug: 'x', s: Symbol('s') },
      { slug: 'x', list: [null] },
    ]) {
      const err = renderError('${{ slug }}', record);
      expect(err).toBeInstanceOf(PathTemplateError);
      expect(err.code).toBe('path_render_failed');
    }
  });

  it('field stringification is the core\'s', () => {
    const t = Template.fromString('${{ x }}');
    expect(t.render({ x: 1.5 })).toBe('1.5');
    expect(t.render({ x: 2026 })).toBe('2026');
    expect(t.render({ x: 5n })).toBe('5');
    expect(t.render({ x: true })).toBe('true');
    expect(t.render({ x: 1e21 })).toBe('1000000000000000000000');
    expect(t.render({ x: Infinity })).toBe('inf');
  });
});

// --- Hard cases: one engine, the same answer under every host zone -----------

const ZONES = ['America/New_York', 'Asia/Kolkata', 'UTC'];

class Holder {
  readonly d: Date;
  constructor(d: Date) {
    this.d = d;
  }
}

const HARD_RECORD = {
  at: new Date('2026-03-04T02:06:07.089Z'),
  // 02:30 on the US spring-forward day: a wall time New York skips.
  dst: new Date('2026-03-08T07:30:05.123Z'),
  k: new Holder(new Date('2026-03-04T02:06:07Z')),
  slug: 'x',
};

/** Render `String(expr)` through the public Template. */
function renderExpr(expr: string, record: Record<string, unknown>): { ok: string } | { err: string } {
  try {
    return { ok: Template.fromString(`\${{ encodeURIComponent(String(${expr})) }}`).render(record) };
  } catch (err) {
    return { err: (err as Error).message };
  }
}

const HARD_EXPRESSIONS = [
  // setters, incl. Annex B setYear
  '(() => { const x = new Date(dst.getTime()); x.setYear(99); return x.getTime(); })()',
  '(() => { const x = new Date(dst.getTime()); x.setYear(2026); return x.getTime(); })()',
  '(() => { const x = new Date(dst.getTime()); x.setHours(2, 30); return x.getTime(); })()',
  '(() => { const x = new Date(dst.getTime()); x.setFullYear(2025, 10, 2); return x.getTime(); })()',
  '(() => { const x = new Date(dst.getTime()); x.setMinutes(61); x.setSeconds(-1); x.setMilliseconds(5); return x.getTime(); })()',
  // two-digit years and the local-time constructor
  'new Date(99, 0).getTime()',
  'new Date(2026, 2, 8, 2, 30).getTime()',
  // DST-boundary instant
  'dst.getHours() + ":" + dst.getMinutes() + ":" + dst.getDate() + ":" + dst.getDay() + ":" + dst.getYear()',
  'dst.toString()',
  'dst.toDateString() + "|" + dst.toTimeString()',
  'dst.getTimezoneOffset()',
  'Date.parse("2026-03-08T02:30")',
  'dst.toJSON() + dst.toISOString() + dst.toUTCString() + JSON.stringify(dst)',
  // class-instance records: their Dates are marshalled in too
  'k.d.getHours()',
  'k.d.toString()',
  // locale-sensitive methods
  '"\\u00e9".localeCompare("f") + ":" + "e\\u0301".localeCompare("\\u00e9")',
  '"i".toLocaleUpperCase("tr") + "\\u0130".toLocaleLowerCase()',
  '[1234.5, "x", null, undefined, [1, 2]].toLocaleString()',
  // string → time
  ...['2026-03-04T05:06', '2026-03-04T05:06:07.1Z', 'Wed Mar 04 2026 05:06:07 GMT+0000', 'Jan 1 2026 05:00', '2026/03/04'].map(
    (str) => `Date.parse(${JSON.stringify(str)}) + ":" + new Date(${JSON.stringify(str)}).getTime()`,
  ),
];

describe('the core realm gives one answer under every host zone', () => {
  it('hard Date / locale cases render identically under New York, Kolkata, and UTC', () => {
    const byZone = ZONES.map((tz) => {
      process.env['TZ'] = tz;
      Template.clearCache();
      return HARD_EXPRESSIONS.map((expr) => renderExpr(expr, HARD_RECORD));
    });
    for (const outcomes of byZone) {
      expect(outcomes).toEqual(byZone[0]);
    }
    for (const [i, outcome] of byZone[0]!.entries()) {
      expect('ok' in outcome, HARD_EXPRESSIONS[i]).toBe(true);
    }
    // Spot-check values: UTC readings, legacy formats are NaN.
    expect(renderExpr('dst.getHours()', HARD_RECORD)).toEqual({ ok: '7' });
    expect(renderExpr('Date.parse("Jan 1 2026 05:00")', HARD_RECORD)).toEqual({ ok: 'NaN' });
  });

  it.each(ZONES)('forbidden and locale-formatting calls fail [TZ=%s]', (tz) => {
    process.env['TZ'] = tz;
    for (const [expr, named] of [
      ...FORBIDDEN,
      ['dst.toLocaleDateString()', 'toLocaleDateString()'],
      ['dst.toLocaleTimeString()', 'toLocaleTimeString()'],
      ['[dst].toLocaleString()', 'toLocaleString()'],
    ] as Array<[string, string]>) {
      const outcome = renderExpr(expr, HARD_RECORD);
      expect('err' in outcome && outcome.err.includes(named), expr).toBe(true);
    }
  });
});

// --- Comparators --------------------------------------------------------------

describe('raw-JS comparators run in the deterministic core realm', () => {
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
  });

  it.each([
    ['return Math.random() - 0.5;', 'Math.random()'],
    ['return Date.now() - a;', 'Date.now()'],
    ['return new Date() - a;', 'new Date() with no arguments'],
  ])('%s is ConfigError config_invalid naming the field and the call', async (rule, named) => {
    const { repo, sheet } = await sheetWithSort(rule);
    const record = { slug: 'x', times: [2, 1] };

    for (const attempt of [
      () => sheet.normalizeRecord(record),
      () =>
        repo.transact({ message: 'write' }, async (tx) => {
          await tx.sheet('events').upsert(record);
        }),
    ]) {
      const err = await attempt().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('config_invalid');
      expect((err as Error).message).toContain('"times"');
      expect((err as Error).message).toContain(named);
    }
  });

  it('a localeCompare comparator is code-unit order in normalizeRecord and on write', async () => {
    const { repo, sheet, fixture } = await sheetWithSort('return a.localeCompare(b);');
    const input = { slug: 'x', times: ['b', 'B', 'a', 'A', 'é', 'f'] };
    const normalized = await sheet.normalizeRecord(input);
    expect(normalized['times']).toEqual(['A', 'B', 'a', 'b', 'f', 'é']);
    await repo.transact({ message: 'write' }, async (tx) => {
      await tx.sheet('events').upsert(input);
    });
    const { stdout } = await fixture.git('show', 'main:events/x.toml');
    expect(stdout).toContain('times = ["A", "B", "a", "b", "f", "é"]');
  });

  it('a comparator receives copies: mutating its arguments changes nothing outside', async () => {
    const { sheet } = await sheetWithSort('a.x = 1; a.d.setTime(5); return 0;');
    const input = { slug: 'x', times: [{ x: 0, d: new Date(0) }, { x: 0, d: new Date(0) }] };
    const normalized = await sheet.normalizeRecord(input);
    expect(input.times).toEqual([{ x: 0, d: new Date(0) }, { x: 0, d: new Date(0) }]);
    expect(normalized['times']).toEqual([{ d: new Date(0), x: 0 }, { d: new Date(0), x: 0 }]);
  });

  it('a comparator that does not compile fails the sheet open with ConfigError naming the field', async () => {
    const err = await sheetWithSort('return a - ;').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe('config_invalid');
    expect((err as Error).message).toContain('"times"');
    expect((err as Error).message).toContain('SyntaxError');
  });
});

// --- pathForRecord / normalizeRecord ≡ the write path ------------------------

const WRITE_PATH_CONFIG = `[gitsheet]
root = 'events'
path = '\${{ at.getUTCFullYear() }}/\${{ kind.toUpperCase() }}-\${{ slug }}'

[gitsheet.fields.tags]
sort = true

[gitsheet.fields.roles]
sort = { rank = 'DESC', name = 'ASC' }

[gitsheet.fields.people]
sort = ['last', 'first']

[gitsheet.fields.nums]
sort = '''
  if ((a % 2) !== (b % 2)) return (a % 2) - (b % 2);
  return b - a;
'''
`;

describe('pathForRecord and normalizeRecord compute exactly what a write commits', () => {
  it('expression path, sort = true, directives, field lists, and raw JS', async () => {
    const { repo, sheet, fixture } = await sheetWithConfig(WRITE_PATH_CONFIG);
    const record = {
      slug: 'launch',
      kind: 'talk',
      at: new Date('2026-12-31T23:30:00-05:00'),
      tags: ['b', 'B', 'a10', 'a9', 'É', 'e', 'Zed', 'apple'],
      roles: [
        { rank: 1, name: 'z' },
        { rank: 2, name: 'b' },
        { rank: 2, name: 'a' },
      ],
      people: [
        { last: 'Lovelace', first: 'Ada' },
        { last: 'Hopper', first: 'Grace' },
        { last: 'Hopper', first: 'Alan' },
      ],
      nums: [3, 8, 1, 6, 5, 2],
      zeta: { b: 1, a: 2 },
    };

    const path = await sheet.pathForRecord(record);
    expect(path).toBe('2027/TALK-launch');
    const normalized = await sheet.normalizeRecord(record);

    await repo.transact({ message: 'write' }, async (tx) => {
      await tx.sheet('events').upsert(record);
    });
    const { stdout: files } = await fixture.git('ls-tree', '-r', '--name-only', 'main', 'events');
    expect(files.trim().split('\n')).toEqual([`events/${path}.toml`]);

    const fresh = await repo.openSheet('events');
    const stored = await fresh.queryFirst({ slug: 'launch' });
    for (const field of ['tags', 'roles', 'people', 'nums', 'zeta'] as const) {
      expect(normalized[field], field).toEqual(stored?.[field]);
    }
    expect(normalized['tags']).toEqual(['a9', 'a10', 'apple', 'b', 'B', 'É', 'e', 'Zed']);
    expect(normalized['nums']).toEqual([8, 6, 2, 5, 3, 1]);
    expect(Object.keys(normalized)).toEqual(Object.keys(stored ?? {}));
  });

  it('normalizeRecord returns the core value: nulls dropped, keys sorted, unrepresentable values rejected', async () => {
    const { sheet } = await sheetWithSort('return a - b;');
    const normalized = await sheet.normalizeRecord({
      slug: 'x',
      z: null,
      times: [3, 1, 2],
      nest: { z: 1, gone: undefined, a: 2 },
      n: 5n,
    } as Record<string, unknown>);
    expect(normalized).toEqual({ n: 5, nest: { a: 2, z: 1 }, slug: 'x', times: [1, 2, 3] });
    expect(Object.keys(normalized)).toEqual(['n', 'nest', 'slug', 'times']);
    expect(Object.keys(normalized['nest'] as object)).toEqual(['a', 'z']);

    for (const bad of [{ slug: 'x', f: () => 1 }, { slug: 'x', times: [1, null] }]) {
      const err = await sheet.normalizeRecord(bad as Record<string, unknown>).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('validation_failed');
    }
  });
});

// --- Threads ------------------------------------------------------------------

describe('compiled templates are per thread', () => {
  it('a worker thread compiles and renders its own template in the core', async () => {
    const addonPath = createRequire(import.meta.url).resolve('@gitsheets/core-napi/index.js');
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const addon = require(workerData.addonPath);
       const def = new addon.CompiledDefinition('\${{ at.getHours() }}/\${{ slug.toUpperCase() }}');
       const out = [];
       for (const slug of ['a', 'b']) out.push(def.renderPath({ at: new Date('2026-03-04T23:00:00Z'), slug }));
       try { def.renderPath({ slug: 'x', at: new Date(0), f: Date.now }); } catch (e) { out.push(e.message); }
       parentPort.postMessage(out);`,
      { eval: true, workerData: { addonPath } },
    );
    // The main thread keeps rendering while the worker runs.
    expect(Template.fromString('${{ at.getHours() }}/${{ slug }}').render({ at: new Date('2026-03-04T23:00:00Z'), slug: 'm' })).toBe('23/m');
    const result = await new Promise<unknown>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    await worker.terminate();
    expect((result as string[]).slice(0, 2)).toEqual(['23/A', '23/B']);
    expect((result as string[])[2]).toContain('Function');
  });
});
