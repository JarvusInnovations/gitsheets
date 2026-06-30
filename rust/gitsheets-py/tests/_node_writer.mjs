// Cross-binding parity helper: drives the *Node* (napi) binding over the same
// gitsheets-core, so the Python parity suite can prove byte-identical output.
//
// Usage: node _node_writer.mjs <op> [arg...]
//   record-write <fixture>            → { treeHash, blobHashes }
//   commit <gitDir>                   → { commitHash, treeHash, refName }
//   comparator <rule> <aJson> <bJson> → { result }
//
// The binding.cjs path comes from $GITSHEETS_NAPI_BINDING. Fixtures are authored
// here as native JS values (the whole point: the same logical data, expressed in
// each host's native types, must serialize to identical bytes via the core).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const binding = require(process.env.GITSHEETS_NAPI_BINDING);

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Fixtures shared with the Python side (test_cross_binding.py builds the same
// logical records in Python natives). Keep the two in lockstep.
const FIXTURES = {
  basic: { email: 'jane@x.org', slug: 'jane', tags: ['a', 'b'], age: 30 },
  // int vs float fidelity + a datetime instant (the same UTC instant the Python
  // side constructs as datetime(2026, 6, 26, 12, 0, 0, tzinfo=utc)).
  typed: {
    slug: 'jane',
    count: 7, // integral number → core Integer
    ratio: 1.5, // → core Float
    when: new Date(Date.UTC(2026, 5, 26, 12, 0, 0)),
  },
};

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

const [op, ...args] = process.argv.slice(2);

if (op === 'record-write') {
  const record = FIXTURES[args[0]];
  const res = binding.recordWrite(args[1], EMPTY_TREE, 'people', ['jane'], [record]);
  out({ treeHash: res.treeHash, blobHashes: res.blobHashes });
} else if (op === 'commit') {
  const gitDir = args[0];
  const opts = {
    parent: undefined,
    branch: 'refs/heads/main',
    author: { name: 'Jane Doe', email: 'jane@x.org' },
    committer: undefined,
    message: 'people: add jane',
    trailers: [{ key: 'Action', value: 'person.create' }],
    timeSeconds: 1_700_000_000,
    offsetMinutes: -300,
  };
  const tx = binding.CoreTransaction.begin(gitDir, opts);
  try {
    tx.openSheet('people', '.gitsheets/people.toml', '.', '');
    tx.prepareUpsert('people', { slug: 'jane', email: 'jane@x.org' });
    tx.stageUpsert('people');
    const r = tx.finalize();
    out({ commitHash: r.commitHash, treeHash: r.treeHash, refName: r.refName });
  } catch (err) {
    tx.discard();
    throw err;
  }
} else if (op === 'comparator') {
  const rule = args[0];
  const a = JSON.parse(args[1]);
  const b = JSON.parse(args[2]);
  out({ result: binding.runComparator(rule, a, b) });
} else {
  process.stderr.write(`unknown op: ${op}\n`);
  process.exit(2);
}
