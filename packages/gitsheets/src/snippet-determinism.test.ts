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
import { compileSnippet } from './sandbox.js';
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

// --- Hard cases: the vm realm vs the core, under several host zones ---------

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

type Outcome = { ok: string } | { err: string };
function attempt(f: () => string): Outcome {
  try {
    return { ok: f() };
  } catch (err) {
    return { err: (err as Error).message };
  }
}

/** Render `String(expr)` through the host Template and the core; return both. */
function renderBoth(expr: string, record: Record<string, unknown>): { host: Outcome; core: Outcome } {
  const template = `\${{ encodeURIComponent(String(${expr})) }}`;
  return {
    host: attempt(() => Template.fromString(template).render(record)),
    core: attempt(() => addon.renderPathsBatch(template, [record])[0]!),
  };
}

const PARITY_EXPRESSIONS = [
  // setters, incl. Annex B setYear
  '(() => { const x = new Date(dst.getTime()); x.setYear(99); return x.getTime(); })()',
  '(() => { const x = new Date(dst.getTime()); x.setYear(2026); return x.getTime(); })()',
  '(() => { const x = new Date(dst.getTime()); x.setYear(-5); return x.getTime(); })()',
  '(() => { const x = new Date(NaN); x.setYear(99); return x.getTime(); })()',
  '(() => { const x = new Date(dst.getTime()); x.setYear(NaN); return x.getTime(); })()',
  '(() => { const x = new Date(dst.getTime()); x.setHours(2, 30); return x.getTime(); })()',
  '(() => { const x = new Date(dst.getTime()); x.setFullYear(2025, 10, 2); return x.getTime(); })()',
  '(() => { const x = new Date(dst.getTime()); x.setMonth(5); x.setDate(31); return x.getTime(); })()',
  '(() => { const x = new Date(dst.getTime()); x.setMinutes(61); x.setSeconds(-1); x.setMilliseconds(5); return x.getTime(); })()',
  // two-digit years and the local-time constructor
  'new Date(99, 0).getTime()',
  'new Date(5, 1, 3, 4, 5, 6, 7).getTime()',
  'Date.UTC(99, 0)',
  'new Date(2026, 2, 8, 2, 30).getTime()',
  // DST-boundary instant
  'dst.getHours() + ":" + dst.getMinutes() + ":" + dst.getDate() + ":" + dst.getDay() + ":" + dst.getYear()',
  'dst.toString()',
  'dst.toDateString() + "|" + dst.toTimeString()',
  'dst.getTimezoneOffset()',
  'Date.parse("2026-03-08T02:30")',
  // UTC forms
  'dst.toJSON() + dst.toISOString() + dst.toUTCString() + JSON.stringify(dst)',
  // ToPrimitive in the constructor
  'new Date(new String("2026-03-04T05:06")).getTime()',
  'new Date({ toString() { return "2026-03-04T05:06"; }, valueOf: undefined }).getTime()',
  'new Date({ valueOf() { return 5; } }).getTime()',
  'new Date({ [Symbol.toPrimitive]() { return "2026-01-01T05:00"; } }).getTime()',
  'new Date(true).getTime() + ":" + new Date(null).getTime() + ":" + new Date(undefined).getTime()',
  'new Date(at).getTime()',
  // class-instance records: their Dates are copied in too
  'k.d.getHours()',
  'k.d.toString()',
  // Intl and the locale-sensitive methods
  'typeof Intl + typeof WebAssembly + typeof console + typeof SharedArrayBuffer + typeof Atomics',
  '"a".localeCompare("B")',
  '"\\u00e9".localeCompare("f") + ":" + "e\\u0301".localeCompare("\\u00e9") + ":" + "ab".localeCompare()',
  '"i".toLocaleUpperCase("tr") + "\\u0130".toLocaleLowerCase() + "\\u00df".toLocaleUpperCase()',
  '(1234.5).toLocaleString() + "|" + (1234.5).toLocaleString("de") + "|" + (-0).toLocaleString() + "|" + (1e21).toLocaleString()',
  '(12345n).toLocaleString()',
  '[1234.5, "x", null, undefined, [1, 2]].toLocaleString()',
  '[ , 1].toLocaleString()',
  // string → time
  ...[
    '2026',
    '2026-03',
    '2026-03-04',
    '2026T05:06Z',
    '2026-03T05:06',
    '2026-03-04T05:06',
    '2026-03-04T05:06:07',
    '2026-03-04T05:06:07.123',
    '2026-03-04T05:06:07.1Z',
    '2026-03-04T05:06:07.12Z',
    '2026-03-04T05:06:07.1234Z',
    '2026-03-04T05:06:07+05:30',
    '2026-01-01T05:06+23:59',
    '2026-01-01T05:06+24:00',
    '2026-01-01T05:06+05:60',
    '2026-01-01T05:06+0530',
    '2026-03-04T05:06:61Z',
    '2026-03-04T05:60Z',
    '2026-03-04t05:06Z',
    '2026-01-01T24:00Z',
    '2026-02-30',
    '2026-04-31',
    '2026-01-32',
    '2026-13-01',
    '+002026-03-04',
    '-000000-01-01',
    '+000000-01-01',
    '+275760-09-13T00:00:00Z',
    '-271821-04-20',
    '-271821-04-19',
    ' 2026-03-04',
    'Wed Mar 04 2026 05:06:07 GMT+0000',
    'Mon Mar 04 2026 05:06:07 GMT-0130',
    'Wed Mar 04 2026 05:06:61 GMT+0000',
    'Wed Mar 04 2026 05:06:07 GMT+9999',
    'Wed Mar 04 2026 05:06:07 GMT+2500',
    'Xyz Mar 04 2026 05:06:07 GMT+0000',
    'Wed Feb 29 2026 05:06:07 GMT+0000',
    'Wed Feb 29 2028 05:06:07 GMT+0000',
    'Wed Mar 04 -12026 05:06:07 GMT+0000',
    'Wed Mar 04 12026 05:06:07 GMT+0000',
    'Wed Mar 4 2026 05:06:07 GMT+0000',
    'Wed Mar 04 2026 05:06:07 GMT+0000 (Coordinated Universal Time)',
    'Wed, 04 Mar 2026 05:06:07 GMT',
    'Wed, 04 Mar -0001 05:06:07 GMT',
    'Wed, 31 Feb 2026 05:06:07 GMT',
    'Wed, 04 Mar 2026 24:00:00 GMT',
    // legacy formats V8 would read in host local time
    'Jan 1 2026 05:00',
    '2026-03-04 05:06',
    'Wed Mar 04 2026',
    '2026/03/04',
    'March 4, 2026',
  ].map((str) => `Date.parse(${JSON.stringify(str)}) + ":" + new Date(${JSON.stringify(str)}).getTime()`),
  'Date.parse(String(new Date(-1e14))) + ":" + Date.parse(new Date(-1e14).toUTCString())',
  'String(new Date(Date.UTC(-1, 0, 1))) + "|" + String(new Date(-1e14))',
];

describe('the vm realm matches the core on hard cases, under several host zones', () => {
  it.each(ZONES)('TZ=%s', (tz) => {
    process.env['TZ'] = tz;
    for (const expr of PARITY_EXPRESSIONS) {
      const { host, core } = renderBoth(expr, HARD_RECORD);
      expect(host, `${expr} [TZ=${tz}]`).toEqual(core);
      expect('ok' in core, `${expr} rendered in the core [TZ=${tz}]`).toBe(true);
    }
  });

  it.each(ZONES)('forbidden and locale-formatting calls fail alike [TZ=%s]', (tz) => {
    process.env['TZ'] = tz;
    for (const [expr, named] of [
      ...FORBIDDEN,
      ['dst.toLocaleDateString()', 'toLocaleDateString()'],
      ['dst.toLocaleTimeString()', 'toLocaleTimeString()'],
      ['[dst].toLocaleString()', 'toLocaleString()'],
    ] as Array<[string, string]>) {
      const { host, core } = renderBoth(expr, HARD_RECORD);
      expect('err' in host && host.err.includes(named), `${expr} host`).toBe(true);
      expect('err' in core && core.err.includes(named), `${expr} core`).toBe(true);
    }
  });

  it('a 24:xx hour beyond end-of-day is NaN on the host (boa accepts it: known divergence)', () => {
    for (const str of ['2026-01-01T24:01Z', '2026-01-01T24:00:00.001Z']) {
      expect(Template.fromString(`\${{ String(Date.parse(${JSON.stringify(str)})) }}`).render({})).toBe('NaN');
    }
  });

  it.each(ZONES)('comparators: localeCompare is code-unit order, inputs are copies [TZ=%s]', (tz) => {
    process.env['TZ'] = tz;
    const pairs: Array<[string, unknown, unknown]> = [
      ['return a.localeCompare(b);', 'a', 'B'],
      ['return a.localeCompare(b);', 'é', 'f'],
      ['return a.s.localeCompare(b.s);', { s: 'Zed' }, { s: 'apple' }],
      ['return a.getHours() - b.getHours();', HARD_RECORD.dst, HARD_RECORD.at],
      ['return a.d.getHours() - b.getHours();', HARD_RECORD.k, HARD_RECORD.at],
    ];
    for (const [rule, a, b] of pairs) {
      const vm = compileSnippet(`(a, b) => { ${rule} }`)(a, b);
      expect(vm, `${rule} [TZ=${tz}]`).toBe(addon.runComparator(rule, a, b));
    }
    const input = { x: 0, d: new Date(0) };
    compileSnippet('(a, b) => { a.x = 1; a.d.setTime(5); return 0; }')(input, input);
    expect(input).toEqual({ x: 0, d: new Date(0) });
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
  it('a localeCompare comparator sorts the same in normalizeRecord and on write', async () => {
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

  it('a comparator that does not compile fails the sheet open with ConfigError naming the field', async () => {
    // The core compiles sort rules when the config is checked, so the sheet
    // never opens; the host normalizeRecord wraps a compile failure the same
    // way (ConfigError naming the field) should it be reached first.
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
