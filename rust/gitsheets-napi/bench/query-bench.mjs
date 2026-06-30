// Bulk query/read benchmark: the Rust core record path vs the JS read+parse
// path, over a large corpus (~18k records).
//
// OPT-IN / LOCAL by default. With no env, it runs a fast SMOKE over the
// committed fixture subset (`bench/fixture/people`, ~60 records) — enough to
// exercise the path in CI and prove it completes. For the real numbers, point
// it at a large corpus WITHOUT disturbing that repo's working tree (it reads a
// ref via the core's `resolve_tree`, never checks anything out):
//
//   GITSHEETS_BENCH_REPO=/home/chris/repos/codeforphilly-data/.git \
//   GITSHEETS_BENCH_REF=origin/published \
//   GITSHEETS_BENCH_BASE=people \
//   node bench/query-bench.mjs
//
// What each number includes (be honest about the comparison):
//   - Rust `recordList`: holo-tree tree read + canonical TOML parse (Rust `toml`)
//     + FFI marshal of every record to a JS object.
//   - JS baseline: `git cat-file --batch` to read every record blob (one
//     subprocess) + parse each with `smol-toml` (the production parser). No FFI.
// Both materialize the same N JS record objects, so this is a fair read+parse
// throughput comparison — the read-heavy path where the hologit#464 headroom
// (per-call to_thread_local, the tree object-cache, per-read blob clone) lives.

import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { recordList, recordQuery, substrateStats, substrateReset } = require('../binding.cjs');

const here = dirname(fileURLToPath(import.meta.url));

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function ms(fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  const t1 = process.hrtime.bigint();
  return { out, ms: Number(t1 - t0) / 1e6 };
}

function fmt(n) {
  return n.toFixed(1).padStart(9);
}

// Build a temp repo from the committed fixture, return { gitDir, ref, base }.
function smokeCorpus() {
  const src = join(here, 'fixture');
  if (!existsSync(join(src, 'people'))) {
    throw new Error(`fixture not found at ${src}/people`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'gitsheets-bench-'));
  execFileSync('git', ['init', '-q', dir]);
  cpSync(src, dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'fixture']);
  return { gitDir: join(dir, '.git'), ref: 'HEAD', base: 'people', tmp: dir };
}

// JS read+parse baseline: list record blobs at the ref, batch cat-file their
// contents, parse each with smol-toml. Returns N parsed records.
function jsReadParse(gitDir, ref, base, parse) {
  // (hash, path) for every <base>/**.toml at the ref.
  const lsTree = execFileSync('git', ['--git-dir', gitDir, 'ls-tree', '-r', ref, base], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const hashes = [];
  for (const line of lsTree.split('\n')) {
    if (!line) continue;
    // <mode> blob <hash>\t<path>
    const m = line.match(/^\S+ blob (\S+)\t(.+\.toml)$/);
    if (m) hashes.push(m[1]);
  }
  // One `git cat-file --batch` subprocess fed all hashes.
  const batch = spawnSync('git', ['--git-dir', gitDir, 'cat-file', '--batch'], {
    input: hashes.join('\n') + '\n',
    maxBuffer: 512 * 1024 * 1024,
  });
  const buf = batch.stdout;
  const records = [];
  let off = 0;
  for (let i = 0; i < hashes.length; i++) {
    // header line: "<hash> blob <size>\n"
    const nl = buf.indexOf(0x0a, off);
    const header = buf.toString('utf8', off, nl);
    const size = parseInt(header.split(' ')[2], 10);
    const start = nl + 1;
    const text = buf.toString('utf8', start, start + size);
    records.push(parse(text));
    off = start + size + 1; // skip content + trailing \n
  }
  return records;
}

async function main() {
  const envRepo = process.env.GITSHEETS_BENCH_REPO;
  let corpus;
  let smoke = false;
  if (envRepo) {
    corpus = {
      gitDir: envRepo,
      ref: process.env.GITSHEETS_BENCH_REF ?? 'origin/published',
      base: process.env.GITSHEETS_BENCH_BASE ?? 'people',
    };
  } else {
    corpus = smokeCorpus();
    smoke = true;
  }
  const { gitDir, ref, base } = corpus;

  // Production TOML parser for the JS baseline (optional — skip if absent).
  let smolParse = null;
  try {
    ({ parse: smolParse } = require('smol-toml'));
  } catch {
    // smol-toml not installed; JS baseline skipped.
  }

  console.log(`\n=== gitsheets bulk read/query benchmark ${smoke ? '(SMOKE — committed fixture)' : ''} ===`);
  console.log(`repo=${gitDir} ref=${ref} base=${base}\n`);

  const REPS = smoke ? 2 : 3;

  // ── Rust recordList (bulk read + parse + marshal) ──────────────────────────
  let n = 0;
  let rustReadMs = Infinity;
  let firstStats = null;
  for (let r = 0; r < REPS; r++) {
    substrateReset();
    const { out, ms: t } = ms(() => recordList(gitDir, ref, base));
    n = out.length;
    if (r === 0) firstStats = substrateStats(); // cold cache (post-reset)
    rustReadMs = Math.min(rustReadMs, t);
  }

  // ── JS git cat-file + smol-toml baseline ───────────────────────────────────
  let jsReadMs = null;
  if (smolParse) {
    for (let r = 0; r < REPS; r++) {
      const { out, ms: t } = ms(() => jsReadParse(gitDir, ref, base, smolParse));
      if (out.length !== n) {
        console.warn(`  WARN: JS baseline parsed ${out.length} records, core read ${n}`);
      }
      jsReadMs = jsReadMs === null ? t : Math.min(jsReadMs, t);
    }
  }

  // ── Rust point query (pruned to ~1 blob via the path template) ─────────────
  // Use the first record's last path segment as a slug to look up.
  const sample = recordList(gitDir, ref, base);
  const someSlug = sample.length ? (sample[0].record.slug ?? sample[0].path.split('/').pop()) : null;
  let pointMs = null;
  let pointStats = null;
  if (someSlug != null) {
    substrateReset();
    const { ms: t } = ms(() => recordQuery(gitDir, ref, base, '${{ slug }}', { slug: someSlug }));
    pointMs = t;
    pointStats = substrateStats();
  }

  // ── Rust full-scan predicate query (read all + engine filter) ──────────────
  const { out: scanOut, ms: scanMs } = ms(() =>
    recordQuery(gitDir, ref, base, '${{ slug }}', { slug: { $pred: "typeof value === 'string'" } }),
  );

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log(`records: ${n}`);
  console.log(`\n  bulk read + parse (best of ${REPS}):`);
  console.log(`    Rust recordList   ${fmt(rustReadMs)} ms   ${fmt(n / (rustReadMs / 1000))} rec/s`);
  if (jsReadMs != null) {
    console.log(`    JS  cat-file+smol ${fmt(jsReadMs)} ms   ${fmt(n / (jsReadMs / 1000))} rec/s`);
    console.log(`    speedup (JS/Rust) ${fmt(jsReadMs / rustReadMs)} x`);
  } else {
    console.log('    JS baseline skipped (install smol-toml to enable: npm i -D smol-toml)');
  }
  if (firstStats) {
    console.log(
      `\n  substrate read amplification (cold, 1 recordList over ${n} records):` +
        `\n    trees_read=${firstStats.treesRead} blobs_read=${firstStats.blobsRead} ` +
        `cache_hits=${firstStats.cacheHits} cache_misses=${firstStats.cacheMisses}`,
    );
  }
  if (pointMs != null) {
    console.log(`\n  point query { slug: ${JSON.stringify(someSlug)} } (pruned):`);
    console.log(
      `    Rust recordQuery  ${fmt(pointMs)} ms   ` +
        `blobs_read=${pointStats.blobsRead} trees_read=${pointStats.treesRead} ` +
        `(reads ~1 record, not ${n})`,
    );
  }
  console.log(`\n  full-scan predicate query (read all + engine filter):`);
  console.log(`    Rust recordQuery  ${fmt(scanMs)} ms   matched ${scanOut.length}/${n}`);

  if (corpus.tmp) rmSync(corpus.tmp, { recursive: true, force: true });
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
