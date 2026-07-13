# gitsheets

A git-backed document store for low-volume, high-touch, human-scale data.

Records are TOML (or markdown-with-frontmatter) files in a git repository, laid
out by a per-sheet path template. Every write is validated against your schema,
serialized to a canonical form (the same data always produces the same bytes),
and lands as a commit. The log is your audit trail, the diff is your review
tool, and a `git clone` is a complete copy of everything. The engine is a
shared Rust core with thin per-language bindings: the `gitsheets` npm package
and a Python binding both produce byte-identical commits.

## The whole idea in one terminal

```console
$ cat .gitsheets/contacts.toml
[gitsheet]
root = 'contacts'
path = '${{ handle }}'

[gitsheet.schema]
type = 'object'
required = ['handle', 'name']

$ npx -y gitsheets upsert contacts '{"handle": "ada", "name": "Ada Lovelace"}'

$ git show HEAD --stat --oneline
f3a91c2 contacts upsert ada
 contacts/ada.toml | 2 ++
```

A record is a file. A change is a commit. Everything git can do with commits
(blame, revert, branch, push, diff, sign) now applies to your data.

## What people run on it

- **An application datastore.** [codeforphilly.org's rebuild](https://github.com/CodeForPhilly/codeforphilly-ng)
  uses gitsheets as its only public datastore: about 32,000 person records,
  where every mutating HTTP request becomes one commit authored as the acting
  user. The audit system is `git log`.
- **Operational databanks.** Inventories and worklists that used to rot in
  spreadsheets, tracked as schema-validated records where every decision is a
  reviewable commit.
- **AI evaluation corpora.** Agents and models write verdicts as records
  (keyed by subject and evaluator), one commit per pass, and nothing acts on a
  verdict until a human has read the diff. The schema rejects malformed model
  output at write time.
- **Mirrors of external systems.** Extract an API into records, fix and merge
  data in git where diffs and review are free, then load only the deltas back.

## Getting started

### The library

```console
npm install gitsheets        # Node >= 20; prebuilt engine, no Rust toolchain
```

```typescript
import { openRepo } from 'gitsheets';

const repo = await openRepo({ gitDir: 'data/.git' });

await repo.transact(
  { message: 'contacts upsert ada', author: { name: 'Ada', email: 'ada@example.org' } },
  async (tx) => {
    await tx.sheet('contacts').upsert({ handle: 'ada', name: 'Ada Lovelace' });
  },
);
```

One handler, one commit, committed only on success. `openStore` layers typed
sheets on top with Standard Schema validators (Zod, Valibot, ArkType), and a
successful transaction auto-refreshes reads. See
[the docs](https://jarvusinnovations.github.io/gitsheets/) for the API guide.

### The CLI

Works in any repo with a `.gitsheets/` config, no install required:

```console
npx -y gitsheets query contacts --filter name='Ada Lovelace'
npx -y gitsheets read contacts ada
npx -y gitsheets normalize contacts
```

Installed globally it also mounts as a git subcommand: `git sheet query …`.

### For AI agents: gitsheets-axi

`gitsheets-axi` is the same store behind a CLI designed for agents: compact
token-efficient output, schemas surfaced with every listing, and bulk
operations (upsert, patch, delete) that land as single reviewable commits.

```console
npx -y gitsheets-axi sheets            # what's here, with schemas
npx -y gitsheets-axi query contacts --group-by name
jq -c '.[]' import.json | npx -y gitsheets-axi upsert contacts   # one commit
```

An agent working in a gitsheets repo can be given real write access: the
schema gates every write and the history makes every action reversible.

### The agent skill

For Claude Code and compatible harnesses, an installable skill teaches the
agent the config grammar, the API, and the axi tool, with session hooks that
surface your sheets at startup:

```console
npx skills add JarvusInnovations/gitsheets -y --skill gitsheets
```

### Python

A Python binding ([`rust/gitsheets-py`](rust/gitsheets-py), pyo3) runs on the
same core — a write from Python and a write from Node produce byte-identical
commits, proven by cross-binding tests in CI. It builds from the repo today;
PyPI publication is on the roadmap.

## What it is not

Every write is a commit, so sustained high write rates are the wrong fit. One
process writes to a repo at a time. Queries are index-assisted scans with
filters, grouping, and counts, not SQL joins. Large media belongs in object
storage, not records. If a conventional database is serving you well, keep it.

## Spec-driven

[`specs/`](specs/) is the source of truth for behavior; start at
[`specs/README.md`](specs/README.md). The library and CLI live in
[`packages/gitsheets`](packages/gitsheets); the Rust core and bindings live
under [`rust/`](rust/).

## License

[Apache-2.0](LICENSE).
