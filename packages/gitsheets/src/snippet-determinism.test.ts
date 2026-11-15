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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    expect(t.render({ x: 1e21 })).toBe('1e+21');
    expect(t.render({ x: 1e20 })).toBe('100000000000000000000');
    expect(t.render({ x: 1e-7 })).toBe('1e-7');
    expect(t.render({ x: Infinity })).toBe('Infinity');
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

// The pre-#373 parity corpus (vm shim vs core, under three host zones),
// kept as direct assertions: each expression's String() through the public
// Template, with the value the core — the specified behavior — produces.
// Setters incl. Annex B setYear, two-digit years and the local-time
// constructor, a DST-boundary instant, UTC forms, ToPrimitive in the
// constructor, class-instance records, the locale-free methods, and the
// three accepted date-string forms (anything else is NaN).
const HARD_CASES: Array<[string, string]> = [
  ["(() => { const x = new Date(dst.getTime()); x.setYear(99); return x.getTime(); })()", "920878205123"],
  ["(() => { const x = new Date(dst.getTime()); x.setYear(2026); return x.getTime(); })()", "1772955005123"],
  ["(() => { const x = new Date(dst.getTime()); x.setYear(-5); return x.getTime(); })()", "-62319256194877"],
  ["(() => { const x = new Date(NaN); x.setYear(99); return x.getTime(); })()", "915148800000"],
  ["(() => { const x = new Date(dst.getTime()); x.setYear(NaN); return x.getTime(); })()", "NaN"],
  ["(() => { const x = new Date(dst.getTime()); x.setHours(2, 30); return x.getTime(); })()", "1772937005123"],
  ["(() => { const x = new Date(dst.getTime()); x.setFullYear(2025, 10, 2); return x.getTime(); })()", "1762068605123"],
  ["(() => { const x = new Date(dst.getTime()); x.setMonth(5); x.setDate(31); return x.getTime(); })()", "1782891005123"],
  ["(() => { const x = new Date(dst.getTime()); x.setMinutes(61); x.setSeconds(-1); x.setMilliseconds(5); return x.getTime(); })()", "1772956859005"],
  ["new Date(99, 0).getTime()", "915148800000"],
  ["new Date(5, 1, 3, 4, 5, 6, 7).getTime()", "-2048356493993"],
  ["Date.UTC(99, 0)", "915148800000"],
  ["new Date(2026, 2, 8, 2, 30).getTime()", "1772937000000"],
  ["dst.getHours() + \":\" + dst.getMinutes() + \":\" + dst.getDate() + \":\" + dst.getDay() + \":\" + dst.getYear()", "7:30:8:0:126"],
  ["dst.toString()", "Sun Mar 08 2026 07:30:05 GMT+0000"],
  ["dst.toDateString() + \"|\" + dst.toTimeString()", "Sun Mar 08 2026|07:30:05 GMT+0000"],
  ["dst.getTimezoneOffset()", "0"],
  ["Date.parse(\"2026-03-08T02:30\")", "1772937000000"],
  ["dst.toJSON() + dst.toISOString() + dst.toUTCString() + JSON.stringify(dst)", "2026-03-08T07:30:05.123Z2026-03-08T07:30:05.123ZSun, 08 Mar 2026 07:30:05 GMT\"2026-03-08T07:30:05.123Z\""],
  ["new Date(new String(\"2026-03-04T05:06\")).getTime()", "1772600760000"],
  ["new Date({ toString() { return \"2026-03-04T05:06\"; }, valueOf: undefined }).getTime()", "1772600760000"],
  ["new Date({ valueOf() { return 5; } }).getTime()", "5"],
  ["new Date({ [Symbol.toPrimitive]() { return \"2026-01-01T05:00\"; } }).getTime()", "1767243600000"],
  ["new Date(true).getTime() + \":\" + new Date(null).getTime() + \":\" + new Date(undefined).getTime()", "1:0:NaN"],
  ["new Date(at).getTime()", "1772589967089"],
  ["k.d.getHours()", "2"],
  ["k.d.toString()", "Wed Mar 04 2026 02:06:07 GMT+0000"],
  ["typeof Intl + typeof WebAssembly + typeof console + typeof SharedArrayBuffer + typeof Atomics", "undefinedundefinedundefinedundefinedundefined"],
  ["\"a\".localeCompare(\"B\")", "1"],
  ["\"\\u00e9\".localeCompare(\"f\") + \":\" + \"e\\u0301\".localeCompare(\"\\u00e9\") + \":\" + \"ab\".localeCompare()", "1:-1:-1"],
  ["\"i\".toLocaleUpperCase(\"tr\") + \"\\u0130\".toLocaleLowerCase() + \"\\u00df\".toLocaleUpperCase()", "Ii̇SS"],
  ["(1234.5).toLocaleString() + \"|\" + (1234.5).toLocaleString(\"de\") + \"|\" + (-0).toLocaleString() + \"|\" + (1e21).toLocaleString()", "1234.5|1234.5|0|1e+21"],
  ["(12345n).toLocaleString()", "12345"],
  ["[1234.5, \"x\", null, undefined, [1, 2]].toLocaleString()", "1234.5, x, , , 1, 2"],
  ["[ , 1].toLocaleString()", ", 1"],
  ["Date.parse(\"2026\") + \":\" + new Date(\"2026\").getTime()", "1767225600000:1767225600000"],
  ["Date.parse(\"2026-03\") + \":\" + new Date(\"2026-03\").getTime()", "1772323200000:1772323200000"],
  ["Date.parse(\"2026-03-04\") + \":\" + new Date(\"2026-03-04\").getTime()", "1772582400000:1772582400000"],
  ["Date.parse(\"2026T05:06Z\") + \":\" + new Date(\"2026T05:06Z\").getTime()", "1767243960000:1767243960000"],
  ["Date.parse(\"2026-03T05:06\") + \":\" + new Date(\"2026-03T05:06\").getTime()", "1772341560000:1772341560000"],
  ["Date.parse(\"2026-03-04T05:06\") + \":\" + new Date(\"2026-03-04T05:06\").getTime()", "1772600760000:1772600760000"],
  ["Date.parse(\"2026-03-04T05:06:07\") + \":\" + new Date(\"2026-03-04T05:06:07\").getTime()", "1772600767000:1772600767000"],
  ["Date.parse(\"2026-03-04T05:06:07.123\") + \":\" + new Date(\"2026-03-04T05:06:07.123\").getTime()", "1772600767123:1772600767123"],
  ["Date.parse(\"2026-03-04T05:06:07.1Z\") + \":\" + new Date(\"2026-03-04T05:06:07.1Z\").getTime()", "NaN:NaN"],
  ["Date.parse(\"2026-03-04T05:06:07.12Z\") + \":\" + new Date(\"2026-03-04T05:06:07.12Z\").getTime()", "NaN:NaN"],
  ["Date.parse(\"2026-03-04T05:06:07.1234Z\") + \":\" + new Date(\"2026-03-04T05:06:07.1234Z\").getTime()", "NaN:NaN"],
  ["Date.parse(\"2026-03-04T05:06:07+05:30\") + \":\" + new Date(\"2026-03-04T05:06:07+05:30\").getTime()", "1772580967000:1772580967000"],
  ["Date.parse(\"2026-01-01T05:06+23:59\") + \":\" + new Date(\"2026-01-01T05:06+23:59\").getTime()", "1767157620000:1767157620000"],
  ["Date.parse(\"2026-01-01T05:06+24:00\") + \":\" + new Date(\"2026-01-01T05:06+24:00\").getTime()", "NaN:NaN"],
  ["Date.parse(\"2026-01-01T05:06+05:60\") + \":\" + new Date(\"2026-01-01T05:06+05:60\").getTime()", "NaN:NaN"],
  ["Date.parse(\"2026-01-01T05:06+0530\") + \":\" + new Date(\"2026-01-01T05:06+0530\").getTime()", "NaN:NaN"],
  ["Date.parse(\"2026-03-04T05:06:61Z\") + \":\" + new Date(\"2026-03-04T05:06:61Z\").getTime()", "NaN:NaN"],
  ["Date.parse(\"2026-03-04T05:60Z\") + \":\" + new Date(\"2026-03-04T05:60Z\").getTime()", "NaN:NaN"],
  ["Date.parse(\"2026-03-04t05:06Z\") + \":\" + new Date(\"2026-03-04t05:06Z\").getTime()", "NaN:NaN"],
  ["Date.parse(\"2026-01-01T24:00Z\") + \":\" + new Date(\"2026-01-01T24:00Z\").getTime()", "1767312000000:1767312000000"],
  ["Date.parse(\"2026-02-30\") + \":\" + new Date(\"2026-02-30\").getTime()", "1772409600000:1772409600000"],
  ["Date.parse(\"2026-04-31\") + \":\" + new Date(\"2026-04-31\").getTime()", "1777593600000:1777593600000"],
  ["Date.parse(\"2026-01-32\") + \":\" + new Date(\"2026-01-32\").getTime()", "NaN:NaN"],
  ["Date.parse(\"2026-13-01\") + \":\" + new Date(\"2026-13-01\").getTime()", "NaN:NaN"],
  ["Date.parse(\"+002026-03-04\") + \":\" + new Date(\"+002026-03-04\").getTime()", "1772582400000:1772582400000"],
  ["Date.parse(\"-000000-01-01\") + \":\" + new Date(\"-000000-01-01\").getTime()", "NaN:NaN"],
  ["Date.parse(\"+000000-01-01\") + \":\" + new Date(\"+000000-01-01\").getTime()", "-62167219200000:-62167219200000"],
  ["Date.parse(\"+275760-09-13T00:00:00Z\") + \":\" + new Date(\"+275760-09-13T00:00:00Z\").getTime()", "8640000000000000:8640000000000000"],
  ["Date.parse(\"-271821-04-20\") + \":\" + new Date(\"-271821-04-20\").getTime()", "-8640000000000000:-8640000000000000"],
  ["Date.parse(\"-271821-04-19\") + \":\" + new Date(\"-271821-04-19\").getTime()", "NaN:NaN"],
  ["Date.parse(\" 2026-03-04\") + \":\" + new Date(\" 2026-03-04\").getTime()", "NaN:NaN"],
  ["Date.parse(\"Wed Mar 04 2026 05:06:07 GMT+0000\") + \":\" + new Date(\"Wed Mar 04 2026 05:06:07 GMT+0000\").getTime()", "1772600767000:1772600767000"],
  ["Date.parse(\"Mon Mar 04 2026 05:06:07 GMT-0130\") + \":\" + new Date(\"Mon Mar 04 2026 05:06:07 GMT-0130\").getTime()", "1772606167000:1772606167000"],
  ["Date.parse(\"Wed Mar 04 2026 05:06:61 GMT+0000\") + \":\" + new Date(\"Wed Mar 04 2026 05:06:61 GMT+0000\").getTime()", "NaN:NaN"],
  ["Date.parse(\"Wed Mar 04 2026 05:06:07 GMT+9999\") + \":\" + new Date(\"Wed Mar 04 2026 05:06:07 GMT+9999\").getTime()", "NaN:NaN"],
  ["Date.parse(\"Wed Mar 04 2026 05:06:07 GMT+2500\") + \":\" + new Date(\"Wed Mar 04 2026 05:06:07 GMT+2500\").getTime()", "1772510767000:1772510767000"],
  ["Date.parse(\"Xyz Mar 04 2026 05:06:07 GMT+0000\") + \":\" + new Date(\"Xyz Mar 04 2026 05:06:07 GMT+0000\").getTime()", "NaN:NaN"],
  ["Date.parse(\"Wed Feb 29 2026 05:06:07 GMT+0000\") + \":\" + new Date(\"Wed Feb 29 2026 05:06:07 GMT+0000\").getTime()", "NaN:NaN"],
  ["Date.parse(\"Wed Feb 29 2028 05:06:07 GMT+0000\") + \":\" + new Date(\"Wed Feb 29 2028 05:06:07 GMT+0000\").getTime()", "1835413567000:1835413567000"],
  ["Date.parse(\"Wed Mar 04 -12026 05:06:07 GMT+0000\") + \":\" + new Date(\"Wed Mar 04 -12026 05:06:07 GMT+0000\").getTime()", "-441665722433000:-441665722433000"],
  ["Date.parse(\"Wed Mar 04 12026 05:06:07 GMT+0000\") + \":\" + new Date(\"Wed Mar 04 12026 05:06:07 GMT+0000\").getTime()", "NaN:NaN"],
  ["Date.parse(\"Wed Mar 4 2026 05:06:07 GMT+0000\") + \":\" + new Date(\"Wed Mar 4 2026 05:06:07 GMT+0000\").getTime()", "NaN:NaN"],
  ["Date.parse(\"Wed Mar 04 2026 05:06:07 GMT+0000 (Coordinated Universal Time)\") + \":\" + new Date(\"Wed Mar 04 2026 05:06:07 GMT+0000 (Coordinated Universal Time)\").getTime()", "NaN:NaN"],
  ["Date.parse(\"Wed, 04 Mar 2026 05:06:07 GMT\") + \":\" + new Date(\"Wed, 04 Mar 2026 05:06:07 GMT\").getTime()", "1772600767000:1772600767000"],
  ["Date.parse(\"Wed, 04 Mar -0001 05:06:07 GMT\") + \":\" + new Date(\"Wed, 04 Mar -0001 05:06:07 GMT\").getTime()", "-62193380033000:-62193380033000"],
  ["Date.parse(\"Wed, 31 Feb 2026 05:06:07 GMT\") + \":\" + new Date(\"Wed, 31 Feb 2026 05:06:07 GMT\").getTime()", "NaN:NaN"],
  ["Date.parse(\"Wed, 04 Mar 2026 24:00:00 GMT\") + \":\" + new Date(\"Wed, 04 Mar 2026 24:00:00 GMT\").getTime()", "NaN:NaN"],
  ["Date.parse(\"Jan 1 2026 05:00\") + \":\" + new Date(\"Jan 1 2026 05:00\").getTime()", "NaN:NaN"],
  ["Date.parse(\"2026-03-04 05:06\") + \":\" + new Date(\"2026-03-04 05:06\").getTime()", "NaN:NaN"],
  ["Date.parse(\"Wed Mar 04 2026\") + \":\" + new Date(\"Wed Mar 04 2026\").getTime()", "NaN:NaN"],
  ["Date.parse(\"2026/03/04\") + \":\" + new Date(\"2026/03/04\").getTime()", "NaN:NaN"],
  ["Date.parse(\"March 4, 2026\") + \":\" + new Date(\"March 4, 2026\").getTime()", "NaN:NaN"],
  ["Date.parse(String(new Date(-1e14))) + \":\" + Date.parse(new Date(-1e14).toUTCString())", "-100000000000000:-100000000000000"],
  ["String(new Date(Date.UTC(-1, 0, 1))) + \"|\" + String(new Date(-1e14))", "Fri Jan 01 -0001 00:00:00 GMT+0000|Thu Feb 15 -1199 14:13:20 GMT+0000"],
];

describe('the core realm gives one answer under every host zone', () => {
  it.each(ZONES)('the hard Date / locale corpus renders its pinned values [TZ=%s]', (tz) => {
    process.env['TZ'] = tz;
    Template.clearCache();
    for (const [expr, expected] of HARD_CASES) {
      const outcome = renderExpr(expr, HARD_RECORD);
      expect(outcome, expr).toEqual({ ok: encodeURIComponent(expected) });
    }
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

    for (const bad of [{ slug: 'x', f: () => 1 }, { slug: 'x', times: [1, null] }, null]) {
      const err = await sheet.normalizeRecord(bad as Record<string, unknown>).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('validation_failed');
    }
  });

  it('large integral floats get distinct paths, as Number#toString renders them', async () => {
    const { repo, sheet, fixture } = await sheetWithConfig(
      `[gitsheet]\nroot = 'events'\npath = '\${{ x }}'\n`,
    );
    const xs = [1e19, 1e20, 2 ** 63, -1e20];
    const paths = await Promise.all(xs.map((x) => sheet.pathForRecord({ x })));
    expect(paths).toEqual(['10000000000000000000', '100000000000000000000', '9223372036854776000', '-100000000000000000000']);
    expect(paths).toEqual(xs.map((x) => String(x)));
    await repo.transact({ message: 'write' }, async (tx) => {
      for (const x of xs) await tx.sheet('events').upsert({ x });
    });
    const { stdout } = await fixture.git('ls-tree', '-r', '--name-only', 'main', 'events');
    expect(stdout.trim().split('\n').sort()).toEqual(paths.map((p) => `events/${p}.toml`).sort());
  });

  it('a thrown value is reported on one line, without stack frames', () => {
    for (const [body, expected] of [
      ['throw "nope"', 'failed: "nope"'],
      ['throw new Error("boom")', 'failed: Error: boom'],
    ]) {
      const err = renderError(`\${{ (() => { ${body} })() }}`, {});
      expect(err.message).toContain(expected);
      expect(err.message).not.toContain('\n');
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

  // The public Template, loaded from the built package in a worker. CI builds
  // dist before testing, so the test only skips for a local run without one.
  const distEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
  it.skipIf(!existsSync(distEntry) && process.env['CI'] === undefined)(
    'a worker thread renders through the public Template (dist)',
    async () => {
      const worker = new Worker(
        `const { parentPort, workerData } = require('node:worker_threads');
         import(workerData.distUrl).then(({ Template, PathTemplateError }) => {
           const t = Template.fromString('\${{ at.getHours() }}/\${{ slug.toUpperCase() }}');
           const out = [t.render({ at: new Date('2026-03-04T23:00:00Z'), slug: 'w' }), t.componentCount];
           try { t.render({ at: new Date(0) }); } catch (e) { out.push(e instanceof PathTemplateError, e.code); }
           parentPort.postMessage(out);
         }, (err) => parentPort.postMessage(['import failed', String(err)]));`,
        { eval: true, workerData: { distUrl: pathToFileURL(distEntry).href } },
      );
      const result = await new Promise<unknown>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      await worker.terminate();
      expect(result).toEqual(['23/W', 2, true, 'path_render_failed']);
    },
  );
});
