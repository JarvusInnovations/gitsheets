// Markdown / mdx content-type codec boundary suite for gitsheets-napi.
//
// Proves byte-level parity with the JS oracle (packages/gitsheets/src/format/
// markdown.ts) and the end-to-end markdown-sheet behavior of
// specs/behaviors/content-types.md, driven through the core's napi boundary:
//   - the frontmatter+body codec: round-trip byte-identity, empty/embedded-`+++`
//     bodies, UTF-8 BOM, TOML datetimes in the frontmatter, lazy (header-only) reads;
//   - title-from-H1 extraction, the H1 rewrite helper, and the disagreement guard;
//   - native body normalization (the embedded dprint-plugin-markdown formatter):
//     deterministic + idempotent, applied on serialize, and the normalize:false toggle;
//   - end-to-end markdown sheets: `.md` on disk, read-back, withBody:false, and
//     the allowMissingBody opt-in.
//
// Requires the addon to be built first: `npm run build:debug` (or `build`).
// Run with: `npm test` (node --test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

let binding;
try {
  binding = require('../binding.cjs');
} catch (err) {
  throw new Error(
    `gitsheets-napi addon not built — run \`npm run build:debug\` first.\n  cause: ${err.message}`,
  );
}

const {
  CoreTransaction,
  markdownSerialize,
  markdownParse,
  markdownParseHeaderOnly,
  markdownExtractH1,
  markdownRewriteH1,
  markdownNormalizeBody,
} = binding;

// ── direct codec: serialize / parse byte parity ────────────────────────────────

test('serialize writes +++ frontmatter then the body', () => {
  const text = markdownSerialize(
    { slug: 'hello', title: 'Hello, world', body: '# Hello\n\nBody text\n' },
    'body',
  );
  assert.ok(text.startsWith('+++\n'));
  assert.match(text, /slug = "hello"/);
  assert.match(text, /title = "Hello, world"/);
  assert.ok(text.includes('+++\n\n# Hello\n\nBody text\n'));
});

test('empty body is just the delimiters + one trailing newline', () => {
  const text = markdownSerialize({ slug: 'empty', body: '' }, 'body');
  assert.equal(text, '+++\nslug = "empty"\n+++\n\n\n');
});

test('a missing body field serializes as an empty body', () => {
  const text = markdownSerialize({ slug: 'no-body' }, 'body');
  assert.match(text, /slug = "no-body"/);
  assert.ok(text.endsWith('+++\n\n\n'));
});

test('a non-string body throws a typed error', () => {
  assert.throws(
    () => markdownSerialize({ slug: 'bad', body: 42 }, 'body'),
    (err) => /must be a string/.test(err.message),
  );
});

test('frontmatter keys are deep-sorted', () => {
  const text = markdownSerialize({ zeta: 1, alpha: 2, slug: 'sorted', body: '' }, 'body');
  const fm = text.split('+++\n')[1] ?? '';
  assert.ok(fm.indexOf('alpha') < fm.indexOf('slug'));
  assert.ok(fm.indexOf('slug') < fm.indexOf('zeta'));
});

test('serialize → parse round-trips a record', () => {
  const original = {
    slug: 'roundtrip',
    title: 'Round-trip',
    tags: ['a', 'b'],
    body: '# Heading\n\nSome content.',
  };
  const text = markdownSerialize(original, 'body');
  const parsed = markdownParse(text, 'body');
  assert.equal(parsed.slug, 'roundtrip');
  assert.equal(parsed.title, 'Round-trip');
  assert.deepEqual(parsed.tags, ['a', 'b']);
  assert.equal(parsed.body, '# Heading\n\nSome content.');
  // Idempotent: re-serializing the parsed record yields the same bytes.
  assert.equal(markdownSerialize(parsed, 'body'), text);
});

test('a +++ line inside the body is preserved verbatim', () => {
  const body = 'before\n\n+++\n\nafter';
  const text = markdownSerialize({ slug: 'plus', body }, 'body');
  assert.equal(markdownParse(text, 'body').body, body);
});

test('an empty body reads back as ""', () => {
  const text = markdownSerialize({ slug: 'empty', body: '' }, 'body');
  assert.equal(markdownParse(text, 'body').body, '');
});

test('TOML datetime types survive the frontmatter round-trip', () => {
  const original = { slug: 'dated', publishedAt: new Date('2024-05-16T10:00:00Z'), body: 'hi' };
  const text = markdownSerialize(original, 'body');
  const parsed = markdownParse(text, 'body');
  assert.ok(parsed.publishedAt instanceof Date);
  assert.equal(parsed.publishedAt.toISOString(), '2024-05-16T10:00:00.000Z');
});

test('a UTF-8 BOM at the start of the file is stripped on parse', () => {
  const text = '﻿+++\nslug = "bom"\n+++\n\nhello\n';
  const parsed = markdownParse(text, 'body');
  assert.equal(parsed.slug, 'bom');
  assert.equal(parsed.body, 'hello');
});

test('a body-only file (no frontmatter) parses to just the body field', () => {
  const parsed = markdownParse('just some body text', 'body');
  assert.equal(parsed.body, 'just some body text');
  assert.deepEqual(
    Object.keys(parsed).filter((k) => k !== 'body'),
    [],
  );
});

test('parseHeaderOnly skips the body (lazy read)', () => {
  const text = markdownSerialize(
    { slug: 'header', title: 'Header only', body: 'this body is big\n'.repeat(1000) },
    'body',
  );
  const header = markdownParseHeaderOnly(text, 'body');
  assert.equal(header.slug, 'header');
  assert.equal(header.title, 'Header only');
  assert.equal(header.body, undefined);
});

// ── title-from-H1 ──────────────────────────────────────────────────────────────

test('extractH1 returns the first ATX H1, trimmed', () => {
  assert.equal(markdownExtractH1('# Hello, world\n\nBody'), 'Hello, world');
  assert.equal(markdownExtractH1('Some prose first.\n\n# Title\n\nMore.'), 'Title');
  assert.equal(markdownExtractH1('# Hello   '), 'Hello');
  assert.equal(markdownExtractH1('Body without a heading'), null);
  assert.equal(markdownExtractH1('## Subheading'), null);
  assert.equal(markdownExtractH1('#NoSpace'), null);
});

test('rewriteH1 rewrites the first H1, or prepends when absent', () => {
  assert.equal(markdownRewriteH1('# Old\n\nBody', 'New'), '# New\n\nBody');
  assert.equal(markdownRewriteH1('# First\n\n# Second', 'X'), '# X\n\n# Second');
  assert.equal(markdownRewriteH1('Just prose, no heading.', 'X'), '# X\n\nJust prose, no heading.');
  assert.equal(markdownRewriteH1('', 'X'), '# X\n');
});

test('serialize with a title field derives the title from the body H1', () => {
  const text = markdownSerialize({ slug: 'hello', body: '# Hello, world\n\nA short post.' }, 'body', 'title');
  assert.match(text, /title = "Hello, world"/);
  // Round-trips: the title field is read back from the frontmatter.
  assert.equal(markdownParse(text, 'body', 'title').title, 'Hello, world');
});

test('serialize with an agreeing supplied title passes through', () => {
  const text = markdownSerialize(
    { slug: 'hello', title: 'Hello, world', body: '# Hello, world\n\nA short post.' },
    'body',
    'title',
  );
  assert.match(text, /title = "Hello, world"/);
});

test('serialize throws ValidationError when the title disagrees with the H1', () => {
  assert.throws(
    () => markdownSerialize({ slug: 'hello', title: 'X', body: '# Y\n\nbody' }, 'body', 'title'),
    (err) => err.code === 'validation_failed' && err.name === 'ValidationError',
  );
});

test('serialize throws when a title is supplied but the body has no H1', () => {
  assert.throws(
    () => markdownSerialize({ slug: 'hello', title: 'Stale', body: 'No H1 here.' }, 'body', 'title'),
    (err) => err.code === 'validation_failed',
  );
});

test('serialize omits the title when the body has no H1 and none is supplied', () => {
  const text = markdownSerialize({ slug: 'hello', body: 'No H1 here.' }, 'body', 'title');
  assert.ok(!/title\s*=/.test(text));
});

// ── native body normalization (embedded dprint-plugin-markdown) ──────────────────

test('normalizeBody is deterministic and idempotent', () => {
  const messy = '#  Hello\n\n\n\nsome   text that\nis soft-wrapped\n\n*  one\n*  two\n';
  const once = markdownNormalizeBody(messy);
  assert.equal(once, markdownNormalizeBody(once), 'normalize(normalize(b)) == normalize(b)');
  // textWrap:never unwraps the paragraph; blank lines collapse; markers normalize.
  assert.equal(once, '# Hello\n\nsome text that is soft-wrapped\n\n- one\n- two\n');
});

test('normalizeBody rewrites emphasis and converts setext headings to ATX', () => {
  assert.equal(markdownNormalizeBody('this is *italic* and __bold__\n'), 'this is _italic_ and **bold**\n');
  assert.equal(markdownNormalizeBody('Title\n=====\n\nbody\n'), '# Title\n\nbody\n');
});

test('serialize normalizes the body on write', () => {
  const text = markdownSerialize({ slug: 'x', body: 'hello *there*\n\n\n*  a\n*  b\n' }, 'body');
  assert.ok(text.endsWith('+++\n\nhello _there_\n\n- a\n- b\n'));
  // Round-trips byte-stably: re-serializing the parsed record is a no-op.
  assert.equal(markdownSerialize(markdownParse(text, 'body'), 'body'), text);
});

test('normalize:false frames the body verbatim', () => {
  const body = 'hello *there*\n\n\n*  a\n*  b';
  const text = markdownSerialize({ slug: 'x', body }, 'body', undefined, false);
  assert.ok(text.endsWith(`+++\n\n${body}\n`), 'body bytes untouched (verbatim)');
  assert.equal(markdownParse(text, 'body').body, body);
});

test('normalization feeds title-from-H1 from a setext heading', () => {
  const text = markdownSerialize(
    { slug: 'x', body: 'Hello, world\n============\n\nBody.' },
    'body',
    'title',
  );
  assert.match(text, /title = "Hello, world"/);
  assert.ok(text.includes('+++\n\n# Hello, world\n\nBody.\n'));
});

// ── end-to-end markdown sheets through a transaction ────────────────────────────

const MD_CONFIG =
  "[gitsheet]\npath = '${{ slug }}'\nroot = 'posts'\n[gitsheet.format]\ntype = 'markdown'\nbody = 'body'\n";
const MD_TITLE_CONFIG =
  "[gitsheet]\npath = '${{ slug }}'\nroot = 'posts'\n[gitsheet.format]\ntype = 'markdown'\nbody = 'body'\ntitle = 'title'\n";

function setupRepo(config) {
  const dir = mkdtempSync(join(tmpdir(), 'gitsheets-mdcore-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Seed']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'seed@x.org']);
  mkdirSync(join(dir, '.gitsheets'), { recursive: true });
  writeFileSync(join(dir, '.gitsheets/posts.toml'), config);
  execFileSync('git', ['-C', dir, 'add', '.gitsheets/posts.toml']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return { dir, gitDir: join(dir, '.git') };
}

function defaultOpts(message, extra = {}) {
  return {
    parent: undefined,
    branch: undefined,
    author: { name: 'Jane Doe', email: 'jane@x.org' },
    committer: undefined,
    message,
    trailers: undefined,
    timeSeconds: 1_700_000_000,
    offsetMinutes: -300,
    ...extra,
  };
}

// Drive one prepare → stage → finalize cycle for a markdown sheet.
function upsertPost(gitDir, opts, record, allowMissingBody) {
  const tx = CoreTransaction.begin(gitDir, opts);
  try {
    tx.openSheet('posts', '.gitsheets/posts.toml', '.', '');
    tx.prepareUpsert('posts', record, undefined, allowMissingBody);
    tx.stageUpsert('posts');
    return tx.finalize();
  } catch (err) {
    tx.discard();
    throw err;
  }
}

test('markdown sheet writes a .md file with TOML frontmatter', () => {
  const { dir, gitDir } = setupRepo(MD_CONFIG);
  try {
    const result = upsertPost(gitDir, defaultOpts('first post'), {
      slug: 'hello-world',
      title: 'Hello, world',
      body: '# Hello\n\nFirst post.\n',
    });
    assert.ok(result.commitHash);

    const tree = execFileSync('git', ['--git-dir', gitDir, 'ls-tree', '-r', '--name-only', 'HEAD'])
      .toString();
    assert.ok(tree.includes('posts/hello-world.md'));
    assert.ok(!tree.includes('posts/hello-world.toml'));

    const blob = execFileSync('git', ['--git-dir', gitDir, 'show', `${result.commitHash}:posts/hello-world.md`])
      .toString();
    assert.ok(blob.startsWith('+++\n'));
    assert.match(blob, /slug = "hello-world"/);
    assert.match(blob, /title = "Hello, world"/);
    assert.ok(blob.includes('+++\n\n# Hello\n\nFirst post.\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mdx alias is configurable and reads back the same codec', () => {
  const { dir, gitDir } = setupRepo(MD_CONFIG.replace("type = 'markdown'", "type = 'mdx'"));
  try {
    const result = upsertPost(gitDir, defaultOpts('mdx post'), { slug: 'intro', body: 'mdx body' });
    assert.ok(result.commitHash);
    const tree = execFileSync('git', ['--git-dir', gitDir, 'ls-tree', '-r', '--name-only', 'HEAD']).toString();
    assert.ok(tree.includes('posts/intro.mdx'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list reads markdown records back, with and without the body', () => {
  const { dir, gitDir } = setupRepo(MD_CONFIG);
  try {
    upsertPost(gitDir, defaultOpts('seed a'), { slug: 'a', title: 'A', body: 'a huge body\n'.repeat(100) });
    upsertPost(gitDir, defaultOpts('seed b'), { slug: 'b', title: 'B', body: 'body of B' });

    const tx = CoreTransaction.begin(gitDir, defaultOpts('read'));
    try {
      tx.openSheet('posts', '.gitsheets/posts.toml', '.', '');

      const withBody = tx.list('posts', true);
      const bySlug = new Map(withBody.map((e) => [e.record.slug, e.record]));
      assert.equal(bySlug.get('b').title, 'B');
      assert.equal(bySlug.get('b').body, 'body of B');

      const withoutBody = tx.list('posts', false);
      for (const { record } of withoutBody) {
        assert.equal(record.body, undefined, 'body omitted under withBody:false');
        assert.ok(record.title, 'frontmatter fields still present');
      }
    } finally {
      tx.discard();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a body-less upsert is rejected by default, permitted with allowMissingBody', () => {
  const { dir, gitDir } = setupRepo(MD_CONFIG);
  try {
    assert.throws(
      () => upsertPost(gitDir, defaultOpts('no body'), { slug: 'a', title: 'A' }),
      (err) => err.code === 'validation_failed' && /missing the body field/.test(err.message),
    );

    const ok = upsertPost(gitDir, defaultOpts('opt in'), { slug: 'a', title: 'A' }, true);
    assert.ok(ok.commitHash);

    const tx = CoreTransaction.begin(gitDir, defaultOpts('read'));
    try {
      tx.openSheet('posts', '.gitsheets/posts.toml', '.', '');
      const [{ record }] = tx.list('posts', true);
      assert.equal(record.body, '', 'serialized as an empty body');
    } finally {
      tx.discard();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('title-from-H1 derivation through upsert, visible in body-less reads', () => {
  const { dir, gitDir } = setupRepo(MD_TITLE_CONFIG);
  try {
    upsertPost(gitDir, defaultOpts('derive'), { slug: 'hello', body: '# Hello, world\n\nLong body here.' });

    const tx = CoreTransaction.begin(gitDir, defaultOpts('read'));
    try {
      tx.openSheet('posts', '.gitsheets/posts.toml', '.', '');
      const [{ record }] = tx.list('posts', false);
      assert.equal(record.title, 'Hello, world', 'title denormalized into frontmatter');
      assert.equal(record.body, undefined);
    } finally {
      tx.discard();
    }

    // A disagreeing supplied title is rejected at prepare time.
    assert.throws(
      () => upsertPost(gitDir, defaultOpts('bad'), { slug: 'x', title: 'X', body: '# Y\n\nbody' }),
      (err) => err.code === 'validation_failed',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a byte-identical markdown re-upsert is a no-op', () => {
  const { dir, gitDir } = setupRepo(MD_CONFIG);
  try {
    upsertPost(gitDir, defaultOpts('seed'), { slug: 'a', title: 'A', body: 'body bytes' });

    const tx = CoreTransaction.begin(gitDir, defaultOpts('check'));
    try {
      tx.openSheet('posts', '.gitsheets/posts.toml', '.', '');
      const [{ record }] = tx.list('posts', true);
      const wc = tx.willChange('posts', record);
      assert.equal(wc.changed, false, 'round-tripped record re-serializes to identical bytes');
    } finally {
      tx.discard();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
