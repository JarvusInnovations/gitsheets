// Cross-binding parity helper: drives the *Node* (napi) binding over the same
// gitsheets-core, so the Python parity suite can prove byte-identical output.
//
// Usage: node _node_writer.mjs <op> [arg...]
//   record-write <fixture>            → { treeHash, blobHashes }
//   commit <gitDir>                   → { commitHash, treeHash, refName }
//   comparator <rule> <aJson> <bJson> → { result }
//   contract-hash <kind> <input>      → { hash } — kind: data|json|toml
//   verify-contract <gitDir> <docJson> [mode]
//     → { ok: true, report } | { ok: false, code, contract, issues }
//     Verifies the 'people' sheet (config at .gitsheets/people.toml, root '.',
//     no prefix) at HEAD — the same shared fixture the Python side builds via
//     test_cross_binding.py, so the two bindings' reports can be diffed.
//   aggregate <gitDir> <treeHash>   → { toml } — recordAggregate over the
//     'ledger' fixture test_aggregate.py wrote, result serialized canonically.
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
  // Nullish keys (cleared optionals) are DROPPED at the marshal boundary in
  // every binding — the record serializes as if the keys were never set
  // (specs/behaviors/normalization.md "Null / undefined handling", #232). The
  // Python side mirrors this with None values (and simply never sets the
  // `undefined` one); both must land on the same bytes.
  nullish: {
    slug: 'jane',
    middleName: null,
    bio: undefined,
    contact: { email: 'jane@x.org', phone: null },
    roles: [{ title: 'chair', until: null }],
  },
};

// The aggregate spec shared with test_aggregate.py (AGGREGATE_SPEC there).
const AGGREGATE_SPEC = {
  n: { count: true },
  total: { sum: 'amountCents' },
  rate: { sum: 'rate' },
  meanRate: { avg: 'rate' },
  lo: { min: 'amountCents' },
  latest: { max: 'postedAt' },
  firstId: { min: 'id' },
  statuses: { distinct: 'status' },
  byStatus: { count: true, groupBy: 'status' },
  rateByStatus: { sum: 'rate', groupBy: 'status' },
  posted: { sum: 'amountCents', where: { status: 'posted' } },
  order: { reduce: 'return acc + record.id;', initial: '' },
  stats: {
    reduce: 'acc.n += 1; acc.cents += record.amountCents; acc.ids.push(record.id); return acc;',
    initial: { n: 0, cents: 0, ids: [] },
    finalize: 'return { mean: acc.cents / acc.n, ids: acc.ids, third: 1 / 3 };',
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
} else if (op === 'commit-attachment') {
  // A record upsert + an attachment staged in the SAME transaction/commit. The
  // attachment bytes are shared with the Python side (fixed binary content), so
  // the resulting tree + commit must be byte-identical across bindings.
  const gitDir = args[0];
  const attachBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x2a]);
  const opts = {
    parent: undefined,
    branch: 'refs/heads/main',
    author: { name: 'Jane Doe', email: 'jane@x.org' },
    committer: undefined,
    message: 'people: add jane + avatar',
    trailers: [{ key: 'Action', value: 'person.create' }],
    timeSeconds: 1_700_000_000,
    offsetMinutes: -300,
  };
  const tx = binding.CoreTransaction.begin(gitDir, opts);
  try {
    tx.openSheet('people', '.gitsheets/people.toml', '.', '');
    tx.prepareUpsert('people', { slug: 'jane', email: 'jane@x.org' });
    tx.stageUpsert('people');
    const hash = binding.writeBlob(gitDir, attachBytes);
    tx.setAttachment('people', 'jane', 'avatar.bin', hash);
    const r = tx.finalize();
    out({ commitHash: r.commitHash, treeHash: r.treeHash, blobHash: hash });
  } catch (err) {
    tx.discard();
    throw err;
  }
} else if (op === 'comparator') {
  const rule = args[0];
  const a = JSON.parse(args[1]);
  const b = JSON.parse(args[2]);
  out({ result: binding.runComparator(rule, a, b) });
} else if (op === 'contract-hash') {
  const kind = args[0]; // 'data' | 'json' | 'toml'
  const input = kind === 'data' ? JSON.parse(args[1]) : args[1];
  const format = kind === 'data' ? undefined : kind;
  out({ hash: binding.canonicalContractHash(input, format) });
} else if (op === 'verify-contract') {
  const gitDir = args[0];
  const doc = JSON.parse(args[1]);
  const mode = args[2]; // 'verify' | 'declared' | 'structural' | undefined
  try {
    const report = binding.verifySheetContract(
      gitDir,
      'HEAD',
      'people',
      '.gitsheets/people.toml',
      '.',
      '',
      doc,
      undefined,
      mode,
    );
    out({ ok: true, report });
  } catch (err) {
    out({ ok: false, code: err.code, contract: err.contract, issues: err.issues ?? [] });
  }
} else if (op === 'aggregate') {
  // Ad-hoc aggregation over the ledger fixture the Python side wrote into
  // <gitDir> at <treeHash> (test_aggregate.py). The spec is mirrored there
  // (AGGREGATE_SPEC) — keep the two in lockstep. Emits the result serialized
  // canonically by the core, so the comparison is byte-level.
  const [gitDir, treeHash] = args;
  const result = binding.recordAggregate(
    gitDir,
    treeHash,
    'ledger',
    'ledger',
    '${{ postedAt: YYYY/MM }}/${{ id }}',
    { postedAt: { $gte: '2026-01-01' } },
    AGGREGATE_SPEC,
    '.toml',
    null,
    null,
  );
  out({ toml: binding.serializeRecords([result])[0] });
} else {
  process.stderr.write(`unknown op: ${op}\n`);
  process.exit(2);
}
