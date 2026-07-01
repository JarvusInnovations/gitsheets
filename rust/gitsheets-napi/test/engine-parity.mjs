// Embedded-engine parity: the boa engine in the Rust core must produce the same
// results as today's `node:vm` path for the same definition snippets. This is
// THE gate for the engine choice (specs/rust-core.md "Embedded code execution").
//
//   1. Raw-JS sort comparators (the snippets gitsheets actually runs through
//      node:vm in buildSorter) — strict parity, asserted.
//   2. CompiledDefinition: compile-once-on-open / reuse-across-operations — the
//      snippet count stays constant across many renderPath/compare calls.
//   3. An Intl/locale PROBE (localeCompare) — characterizes boa's documented
//      divergence boundary; reported, not asserted. gitsheets' declarative
//      `sort = true` locale sort is native (the ICU collator in the core, NOT an
//      embedded snippet) — its parity gate is `test/collator-parity.mjs`.
//
// Requires the addon built first (`npm run build:debug`). Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { runComparator, CompiledDefinition } = require('../binding.cjs');

// The node:vm baseline: buildSorter compiles a raw rule as `(a, b) => { rule }`.
function vmComparator(rule) {
  return runInNewContext(`(a, b) => { ${rule} }`);
}

// Realistic raw-JS sort comparators (the escape-hatch snippets gitsheets runs).
const COMPARATORS = [
  { rule: 'return a - b;', pairs: [[1, 2], [5, 3], [0, 0], [-4, 4], [2.5, 2.4]] },
  { rule: 'return b - a;', pairs: [[1, 2], [5, 3], [10, 10]] },
  { rule: 'return a < b ? -1 : a > b ? 1 : 0;', pairs: [['a', 'b'], ['z', 'a'], ['m', 'm'], [3, 30]] },
  { rule: 'return a.length - b.length;', pairs: [['aa', 'bbb'], ['x', 'x'], ['hello', 'hi']] },
  { rule: 'return Math.sign(a - b);', pairs: [[7, 2], [2, 7], [4, 4]] },
  // Multi-key directive comparator over object records (what the {field:dir}
  // sort lowering produces) — exercises object marshalling into the engine.
  {
    rule: "if ((a[\"rank\"]) < (b[\"rank\"])) return -1; if ((a[\"rank\"]) > (b[\"rank\"])) return 1; return 0;",
    pairs: [
      [{ rank: 1 }, { rank: 2 }],
      [{ rank: 5 }, { rank: 5 }],
      [{ rank: 9 }, { rank: 3 }],
    ],
  },
];

test('raw-JS sort comparators match node:vm exactly', () => {
  let checked = 0;
  for (const { rule, pairs } of COMPARATORS) {
    const vm = vmComparator(rule);
    for (const [a, b] of pairs) {
      const expected = vm(a, b);
      const actual = runComparator(rule, a, b);
      assert.equal(actual, expected, `rule ${JSON.stringify(rule)} on ${JSON.stringify([a, b])}`);
      checked++;
    }
  }
  console.log(`\n  comparator parity (boa === node:vm): ${checked} (rule,input) pairs OK`);
});

test('compiled definition reuses snippets across operations (compile once)', () => {
  const def = new CompiledDefinition('${{ slug.toUpperCase() }}', 'return a - b;');
  // One path-expression snippet + one comparator snippet.
  assert.equal(def.snippetCount(), 2, 'two snippets compiled at construction');

  const vmRender = vmComparator; // not used here; render compares to node:vm below
  const vmExpr = runInNewContext('(record) => { with (record) { return (slug.toUpperCase()) } }');
  const vmCmp = vmComparator('return a - b;');

  for (let i = 0; i < 100; i++) {
    const record = { slug: `item-${i}` };
    assert.equal(def.renderPath(record), vmExpr(record));
    assert.equal(def.compare(i, i + 1), vmCmp(i, i + 1));
  }
  // The decisive check: NO recompilation happened across 200 operations.
  assert.equal(def.snippetCount(), 2, 'snippet count constant — compiled once, not per call');
  console.log('\n  CompiledDefinition: 200 operations, snippetCount stayed 2 (compiled once on open)');
  void vmRender;
});

test('separate definitions hold independent persistent engines', () => {
  const a = new CompiledDefinition('${{ id }}');
  const b = new CompiledDefinition('${{ slug }}/${{ id }}');
  assert.equal(a.renderPath({ id: 1 }), '1');
  assert.equal(b.renderPath({ slug: 'x', id: 2 }), 'x/2');
  assert.equal(a.snippetCount(), 0); // pure field template, no engine snippets
  assert.equal(b.snippetCount(), 0);
});

// PROBE (reported, not asserted): localeCompare is Intl-adjacent — exactly the
// boa-vs-node:vm divergence boundary the spec flags. gitsheets' locale-aware
// sort is the declarative `sort = true` path, evaluated NATIVELY by the core's
// ICU collator (see test/collator-parity.mjs), not an embedded snippet — so a
// divergence here is not a gate failure. We surface it so the boundary is
// documented honestly (and motivates why locale sort does not use the engine).
test('PROBE: localeCompare boundary (Intl) — reported, not gating', () => {
  const rule = 'return String(a).localeCompare(String(b));';
  const vm = vmComparator(rule);
  const pairs = [['a', 'b'], ['B', 'a'], ['10', '9'], ['é', 'e']];
  const rows = [];
  let diverged = 0;
  for (const [a, b] of pairs) {
    const expected = Math.sign(vm(a, b));
    let actual;
    try {
      actual = Math.sign(runComparator(rule, a, b));
    } catch (err) {
      actual = `ERR(${err.message})`;
    }
    const same = actual === expected;
    if (!same) diverged++;
    rows.push({ pair: [a, b], vm: expected, boa: actual, same });
  }
  console.log('\n  PROBE localeCompare (boa vs node:vm sign):');
  for (const r of rows) {
    console.log(`    ${r.same ? 'match' : 'DIVERGE'}  ${JSON.stringify(r.pair)}  vm=${r.vm} boa=${r.boa}`);
  }
  console.log(`  -> ${diverged}/${pairs.length} diverged (informational; not a gate)`);
});
