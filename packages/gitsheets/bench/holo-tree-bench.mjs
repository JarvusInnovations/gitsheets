// Substrate-level microbenchmark for the holo-tree spike (#127).
//
// Measures the cost that actually differs between the two substrates: load a
// large existing tree, insert record(s), rebuild it, commit, advance a ref.
// Both sides do identical logical work on the SAME real tree (the codeforphilly
// `people` sheet — ~18k records in one flat directory).
//
//   JS path:   hologit TreeObject.writeChild → root.write() → git commit-tree
//              + git update-ref   (in-memory tree, but git subprocess commit)
//   holo path: binding writeChild → write → commitTree → updateRef  (all gix,
//              in-process — no subprocess)
//
// Usage:  BENCH_REPO=/path/to/bench-repo node packages/gitsheets/bench/holo-tree-bench.mjs
//         (optional) K=20 N=500 to set iteration / bulk counts.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Repo: HologitRepo } = require('hologit');
const holo = require('holo-tree-napi');

const REPO = process.env.BENCH_REPO;
if (!REPO) {
  console.error('set BENCH_REPO to the bench repo working dir');
  process.exit(1);
}
const GIT_DIR = join(REPO, '.git');
const K = Number(process.env.K ?? 20);
const N = Number(process.env.N ?? 500);
const SHEET_ROOT = 'people';

const git = (...args) => execFileSync('git', args, { cwd: GIT_DIR, encoding: 'utf8' }).trim();
const PARENT = git('rev-parse', 'HEAD');
const PARENT_TREE = git('rev-parse', 'HEAD^{tree}');

function recordToml(slug) {
  return `slug = "${slug}"\nname = "Bench ${slug}"\nbenchmark = true\n`;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sum = s.reduce((a, b) => a + b, 0n);
  return {
    min: s[0],
    median: s[Math.floor(s.length / 2)],
    max: s[s.length - 1],
    mean: sum / BigInt(s.length),
  };
}
const ms = (ns) => Number(ns) / 1e6;
const fmt = (st) =>
  `min=${ms(st.min).toFixed(1)}  median=${ms(st.median).toFixed(1)}  mean=${ms(st.mean).toFixed(1)}  max=${ms(st.max).toFixed(1)} ms`;

// --- one JS-path commit: insert `count` records into people/, commit, move ref ---
async function jsCommit(slugs) {
  const repo = new HologitRepo({ gitDir: GIT_DIR });
  const ws = await repo.createWorkspaceFromRef(PARENT);
  for (const slug of slugs) {
    await ws.root.writeChild(`${SHEET_ROOT}/${slug}.toml`, recordToml(slug));
  }
  const treeHash = await ws.root.write();
  const commit = execFileSync(
    'git',
    ['commit-tree', treeHash, '-p', PARENT, '-m', 'bench'],
    { cwd: GIT_DIR, encoding: 'utf8' },
  ).trim();
  git('update-ref', 'refs/heads/js-bench', commit);
  return treeHash;
}

// --- one holo-path commit: same, all in-process via the binding ---
function holoCommit(slugs) {
  const repo = holo.Repo.open(GIT_DIR);
  const tree = repo.createTreeFromRef(PARENT);
  for (const slug of slugs) {
    tree.writeChild(`${SHEET_ROOT}/${slug}.toml`, recordToml(slug));
  }
  const treeHash = tree.write();
  const commit = repo.commitTree(treeHash, [PARENT], 'bench');
  repo.updateRef('refs/heads/holo-bench', commit);
  return treeHash;
}

async function main() {
  console.log(`bench repo: ${REPO}`);
  console.log(`parent: ${PARENT}  people records: ${git('ls-tree', '--name-only', `${PARENT}:${SHEET_ROOT}`).split('\n').length}`);
  console.log(`single-upsert iterations K=${K}, bulk N=${N}\n`);

  // Warm up both engines (load packs / caches) and sanity-check tree parity.
  const jsWarm = await jsCommit(['warm-0']);
  const holoWarm = holoCommit(['warm-0']);
  console.log(`parity check (1 record): js=${jsWarm} holo=${holoWarm} ${jsWarm === holoWarm ? 'OK' : 'MISMATCH'}\n`);

  // --- single upsert into the 18k tree ---
  const jsSingle = [];
  for (let i = 0; i < K; i++) {
    const t = process.hrtime.bigint();
    await jsCommit([`js-single-${i}`]);
    jsSingle.push(process.hrtime.bigint() - t);
  }
  const holoSingle = [];
  for (let i = 0; i < K; i++) {
    const t = process.hrtime.bigint();
    holoCommit([`holo-single-${i}`]);
    holoSingle.push(process.hrtime.bigint() - t);
  }
  console.log('single upsert → commit (into ~18k-record dir):');
  console.log(`  JS   : ${fmt(stats(jsSingle))}`);
  console.log(`  holo : ${fmt(stats(holoSingle))}`);
  console.log(`  speedup (median): ${(ms(stats(jsSingle).median) / ms(stats(holoSingle).median)).toFixed(1)}x\n`);

  // --- bulk: N records in one commit ---
  const bulkSlugs = (tag) => Array.from({ length: N }, (_, i) => `${tag}-${i}`);
  const jsBulk = [];
  const holoBulk = [];
  for (let r = 0; r < 5; r++) {
    let t = process.hrtime.bigint();
    await jsCommit(bulkSlugs(`jsbulk-${r}`));
    jsBulk.push(process.hrtime.bigint() - t);
    t = process.hrtime.bigint();
    holoCommit(bulkSlugs(`holobulk-${r}`));
    holoBulk.push(process.hrtime.bigint() - t);
  }
  console.log(`bulk: ${N} upserts in one commit:`);
  console.log(`  JS   : ${fmt(stats(jsBulk))}`);
  console.log(`  holo : ${fmt(stats(holoBulk))}`);
  console.log(`  speedup (median): ${(ms(stats(jsBulk).median) / ms(stats(holoBulk).median)).toFixed(1)}x`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
