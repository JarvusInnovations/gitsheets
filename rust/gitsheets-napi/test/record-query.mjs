// Query traversal + filtering + getFieldNames boundary suite for gitsheets-napi.
//
// Proves the Rust core's read-query parity from JS:
//   - recordQueryCandidates (the pruning walk) yields the SAME candidate set as
//     the host `Template.queryTree` on a fixture corpus.
//   - recordQuery (prune + native filter, incl. an embedded-engine $pred escape
//     hatch) matches the host `queryTree` + `queryMatches`.
//   - templateFieldNames matches the host `Template.getFieldNames`.
//
// Requires the addon built first (`npm run build:debug`). Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { refQuery, refCandidates } from './_ref-query.mjs';

const require = createRequire(import.meta.url);
const { recordWrite, recordQuery, recordQueryCandidates, templateFieldNames } =
  require('../binding.cjs');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gitsheets-napi-query-'));
  execFileSync('git', ['init', '-q', dir]);
  return { dir, gitDir: join(dir, '.git') };
}

// Write a corpus ([{path, record}]) under `base`, return the tree hash.
function seed(gitDir, base, corpus) {
  const out = recordWrite(
    gitDir,
    EMPTY_TREE,
    base,
    corpus.map((e) => e.path),
    corpus.map((e) => e.record),
  );
  return out.treeHash;
}

// The path-template-input subset of a filter (scalar equality literals only) —
// what the Rust core derives internally for pruning, and what the reference
// queryTree should render against.
function pruneQueryOf(filter) {
  const q = {};
  for (const [k, v] of Object.entries(filter)) {
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') q[k] = v;
  }
  return q;
}

// ── flat sheet: people, template ${{ slug }} ──────────────────────────────────

const PEOPLE = [
  { path: 'amy', record: { slug: 'amy', email: 'amy@z.org', team: 'design', age: 41 } },
  { path: 'bob', record: { slug: 'bob', email: 'bob@y.org', team: 'eng', age: 17 } },
  { path: 'jane', record: { slug: 'jane', email: 'jane@x.org', team: 'eng', age: 30 } },
  { path: 'zed', record: { slug: 'zed', email: 'zed@x.org', team: 'eng', age: 64 } },
];

// ── composite sheet: users, template ${{ domain }}/${{ username }} ─────────────

const USERS = [
  { path: 'af.mil/cobol', record: { domain: 'af.mil', username: 'cobol', active: true } },
  { path: 'af.mil/grandma', record: { domain: 'af.mil', username: 'grandma', active: false } },
  { path: 'navy.mil/sailor', record: { domain: 'navy.mil', username: 'sailor', active: true } },
];

test('recordQueryCandidates matches the host queryTree candidate set (pruning parity)', async () => {
  const { dir, gitDir } = freshRepo();
  try {
    const peopleTree = seed(gitDir, 'people', PEOPLE);
    const usersTree = seed(gitDir, 'users', USERS);

    const cases = [
      // [base, template, treeHash, query]
      ['people', '${{ slug }}', peopleTree, {}],
      ['people', '${{ slug }}', peopleTree, { slug: 'jane' }],
      ['people', '${{ slug }}', peopleTree, { slug: 'nobody' }],
      ['users', '${{ domain }}/${{ username }}', usersTree, {}],
      ['users', '${{ domain }}/${{ username }}', usersTree, { domain: 'af.mil' }],
      ['users', '${{ domain }}/${{ username }}', usersTree, { domain: 'af.mil', username: 'grandma' }],
      ['users', '${{ domain }}/${{ username }}', usersTree, { domain: 'navy.mil', username: 'missing' }],
      // partial composite — only the trailing field supplied: leading component
      // unrenderable → expand all subtrees, then list .toml leaves.
      ['users', '${{ domain }}/${{ username }}', usersTree, { username: 'grandma' }],
    ];

    const corpusFor = (base) => (base === 'people' ? PEOPLE : USERS);
    const log = [];
    for (const [base, template, treeHash, query] of cases) {
      const actual = recordQueryCandidates(gitDir, treeHash, base, template, query);
      const expected = await refCandidates(corpusFor(base), template, query);
      log.push({ template, query: JSON.stringify(query), actual });
      assert.deepEqual(actual, expected, `candidates for ${template} ${JSON.stringify(query)}`);
    }
    console.log('\n  prune candidate parity (rust === host queryTree):');
    for (const c of log) console.log(`    OK  ${c.template}  ${c.query}  ->  [${c.actual.join(', ')}]`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordQuery matches host queryTree + queryMatches (equality, nested, $pred escape hatch)', async () => {
  const { dir, gitDir } = freshRepo();
  try {
    const peopleTree = seed(gitDir, 'people', PEOPLE);
    const usersTree = seed(gitDir, 'users', USERS);

    // Each case pairs a Rust filter (with `$pred` snippets) and the equivalent
    // host filter (with predicate functions). The escape-hatch snippet and the
    // node:vm function are the SAME predicate, so any divergence is a real
    // boa-vs-node:vm difference — a stop-and-report, not a loosened assertion.
    const cases = [
      {
        name: 'empty filter (all records)',
        base: 'people',
        tree: peopleTree,
        template: '${{ slug }}',
        rust: {},
        ref: {},
      },
      {
        name: 'equality on a path field (prunes to one leaf)',
        base: 'people',
        tree: peopleTree,
        template: '${{ slug }}',
        rust: { slug: 'jane' },
        ref: { slug: 'jane' },
      },
      {
        name: 'equality on a non-path field (full scan + filter)',
        base: 'people',
        tree: peopleTree,
        template: '${{ slug }}',
        rust: { team: 'eng' },
        ref: { team: 'eng' },
      },
      {
        name: 'escape-hatch predicate: numeric comparison',
        base: 'people',
        tree: peopleTree,
        template: '${{ slug }}',
        rust: { age: { $pred: 'value >= 18' } },
        ref: { age: (value) => value >= 18 },
      },
      {
        name: 'escape-hatch predicate: string method',
        base: 'people',
        tree: peopleTree,
        template: '${{ slug }}',
        rust: { email: { $pred: "value.endsWith('x.org')" } },
        ref: { email: (value) => value.endsWith('x.org') },
      },
      {
        name: 'escape-hatch predicate using the whole record',
        base: 'people',
        tree: peopleTree,
        template: '${{ slug }}',
        rust: { age: { $pred: "record.team === 'eng' && value > 18" } },
        ref: { age: (value, record) => record.team === 'eng' && value > 18 },
      },
      {
        name: 'equality + predicate combined',
        base: 'people',
        tree: peopleTree,
        template: '${{ slug }}',
        rust: { team: 'eng', age: { $pred: 'value > 20' } },
        ref: { team: 'eng', age: (value) => value > 20 },
      },
      {
        name: 'composite key, leading field + boolean predicate',
        base: 'users',
        tree: usersTree,
        template: '${{ domain }}/${{ username }}',
        rust: { domain: 'af.mil', active: { $pred: 'value === true' } },
        ref: { domain: 'af.mil', active: (value) => value === true },
      },
    ];

    const corpusFor = (base) => (base === 'people' ? PEOPLE : USERS);
    const log = [];
    for (const c of cases) {
      const actual = recordQuery(gitDir, c.tree, c.base, c.template, c.rust);
      const expected = await refQuery(corpusFor(c.base), c.template, pruneQueryOf(c.rust), c.ref);
      // Compare matched path sets (records round-trip is proven by record-crud).
      const actualPaths = actual.map((r) => r.path).sort();
      const expectedPaths = expected.map((r) => r.path).sort();
      assert.deepEqual(actualPaths, expectedPaths, `query divergence on "${c.name}"`);
      // And the records themselves deep-equal on a per-path basis.
      const actualByPath = Object.fromEntries(actual.map((r) => [r.path, r.record]));
      for (const { path, record } of expected) {
        assert.deepEqual(actualByPath[path], record, `record mismatch at ${path} for "${c.name}"`);
      }
      log.push({ name: c.name, paths: actualPaths });
    }
    console.log('\n  query result parity (rust === host queryTree + queryMatches):');
    for (const c of log) console.log(`    OK  ${c.name}  ->  [${c.paths.join(', ')}]`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── getFieldNames parity ──────────────────────────────────────────────────────

// Verbatim transcription of `extractIdentifiers` + `getFieldNames` from
// `packages/gitsheets/src/path-template/index.ts`.
const IDENTIFIER_RE = /(?<![.\w$])([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
const JS_RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'async', 'await',
  'of', 'Array', 'Boolean', 'Date', 'Number', 'Object', 'String', 'Math',
  'JSON', 'RegExp', 'Symbol', 'Promise', 'Map', 'Set', 'NaN', 'Infinity',
  'globalThis',
]);
const FIELD_NAME_RE = /^[a-zA-Z0-9_-]+(\/\*\*)?$/;

function refFieldNames(template) {
  const normalized = template.replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = [[]];
  let pendingLiteral = '';
  let i = 0;
  const flush = () => {
    if (pendingLiteral) {
      segments[segments.length - 1].push({ kind: 'literal', text: pendingLiteral });
      pendingLiteral = '';
    }
  };
  while (i < normalized.length) {
    if (normalized.startsWith('${{', i)) {
      flush();
      i += 3;
      let src = '';
      while (!normalized.startsWith('}}', i)) {
        src += normalized[i];
        i++;
      }
      src = src.trim();
      i += 2;
      if (FIELD_NAME_RE.test(src)) {
        const recursive = src.endsWith('/**');
        segments[segments.length - 1].push({ kind: 'field', name: recursive ? src.slice(0, -3) : src });
      } else {
        segments[segments.length - 1].push({ kind: 'expression', source: src });
      }
    } else if (normalized[i] === '/') {
      flush();
      segments.push([]);
      i++;
    } else {
      pendingLiteral += normalized[i];
      i++;
    }
  }
  flush();
  const seen = new Set();
  for (const parts of segments) {
    for (const p of parts) {
      if (p.kind === 'field') seen.add(p.name);
      else if (p.kind === 'expression') {
        for (const m of p.source.matchAll(IDENTIFIER_RE)) {
          if (!JS_RESERVED.has(m[1])) seen.add(m[1]);
        }
      }
    }
  }
  return [...seen];
}

test('templateFieldNames matches the host Template.getFieldNames', () => {
  const templates = [
    '${{ slug }}',
    '${{ domain }}/${{ username }}',
    '${{ year }}/${{ status }}--${{ id }}',
    '${{ contentPath/** }}',
    'users/all',
    '${{ publishedAt.getUTCFullYear() }}/${{ slug }}',
    '${{ (slug || legacyId) }}',
    'shard-${{ id % 4 }}/${{ id }}',
    '[${{ ns }}]-${{ key }}-v${{ ver }}',
  ];
  const log = [];
  for (const t of templates) {
    const actual = templateFieldNames(t);
    const expected = refFieldNames(t);
    assert.deepEqual(actual, expected, `getFieldNames divergence on ${t}`);
    log.push({ t, actual });
  }
  console.log('\n  getFieldNames parity (rust === host):');
  for (const c of log) console.log(`    OK  ${c.t}  ->  [${c.actual.join(', ')}]`);
});
