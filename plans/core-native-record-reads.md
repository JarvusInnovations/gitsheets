---
status: done
depends: [range-pruned-queries]
specs:
  - specs/rust-core.md
  - specs/architecture.md
  - specs/api/transaction.md
issues: [289, 290]
pr: 295
---

# Plan: core-native record reads (no `git cat-file` on any read path)

## Scope

Finish the cutover for **reads**. The Node binding still fetches record bytes
with `git cat-file` subprocesses on three paths, and lists the whole sheet on
a fourth:

| Path | Today | Cost on a 4,300-record markdown sheet |
| --- | --- | --- |
| `Sheet.query` on a markdown/mdx sheet (committed ref) | core prunes, then **one `git cat-file` spawn per candidate** | 4,300 spawns ≈ 46 s (#289) |
| `Sheet.query` on a **tx-bound** sheet | `coreTx.list` — whole sheet, bodies included, no pruning | 2,916 patches × full list ≈ 51 min (#290) |
| `Sheet.loadBody`, sheet-config load | one spawn each (+ `git rev-parse` for the config hash) | small, but the hydrate path for `read` |
| `diffFrom({ records })`, attachment `read()` / `stream()` | one `git cat-file` by hash each | per change / per attachment |

In scope:

- Core: a **format-aware query** over any tree (committed ref or a
  transaction's private tree) that reads candidate blobs through the object
  database and decodes with the codec (TOML / markdown, `with_body` switch);
  `Sheet::query` on the core sheet; blob-read primitives by `ref:path` and by
  hash.
- napi + pyo3: expose them (`recordQuery` gains format params;
  `CoreTransaction.query`; `treeReadBlob`; `treeEntryHash`; `blobRead`).
- Host: route every record / config / attachment / diff-side read through
  them; delete `readTreeBlobText`'s subprocess body and the per-candidate
  loop. `git` subprocesses remain only for push, `diff-tree`, working-tree
  materialization, and repo discovery (`rev-parse --absolute-git-dir`,
  `ls-tree` for attachment listing, `git config` for author defaults).

Out of scope (follow-up plans / issues):

- axi-side behavior changes for #289 — body-less `query` by default, `read`
  by exact path, `--limit` short-circuit — and the single-transaction
  preflight for bulk `patch` (#290). This plan removes the per-record cost
  underneath them; they are separate, smaller changes.
- Replacing `git diff-tree` in `diffFrom` and `git ls-tree` in attachment
  listing with core walks (not record reads; no spawn-per-record).

## Implements

- `specs/rust-core.md` — "Query traversal + filtering" (format-aware, both
  trees) and the new "Blob reads" bullet.
- `specs/architecture.md` — tree-primitives row: reads go through the core;
  the remaining `git` shell-outs enumerated.
- `specs/api/transaction.md` — "Read isolation": tx-bound queries prune like
  committed-ref queries.

## Approach

1. **Core `record.rs`**: `read_blob_text(repo, hash)` (UTF-8 decode of a blob
   by id), `read_blob_entry(repo, tree, path) -> Option<(hash, bytes)>` (deep
   `get_child` + object read), `read_blob_by_hash(repo, hash) -> Option<bytes>`,
   `tree_entry_hash(repo, tree, path)`.
2. **Core `query.rs`**: `query_records_format(repo, tree, base, template,
   filter, engine, format: &FormatConfig, with_body)` — same walk as
   `query_records`, decoding each candidate with `codec::parse` /
   `parse_header_only`. `query_records` becomes the TOML special case.
3. **Core `sheet.rs`**: `Sheet::query(repo, tree, filter, with_body)` over the
   sheet's compiled template / engine / format — the tx-bound read.
4. **napi**: `recordQuery(..., extension?, bodyField?, titleField?, withBody?)`
   (a `bodyField` selects the markdown codec; `.mdx` extension → Mdx);
   `CoreTransaction.query(name, filter, withBody)`; `treeReadBlob(gitDir,
   treeRef, path) -> { hash, content: Buffer } | null`; `treeEntryHash`;
   `blobRead(gitDir, hash) -> Buffer | null`.
5. **pyo3**: the same module-level functions (`record_query` format kwargs,
   `tree_read_blob`, `tree_entry_hash`, `blob_read`); the Python
   `CoreTransaction` has no read surface today, so no `query` there.
6. **Host `sheet.ts`**: `readTreeBlobText` → `treeReadBlob`; `loadConfig`
   keys its cache on the returned hash (drops `rev-parse`); the markdown query
   branch calls `recordQuery` with the format params; the tx branch calls
   `coreTx.query` with the stripped filter; `readBlobAsRecord` and the
   attachment handle use `blobRead` (`stream()` wraps the buffer in a
   `Readable`); `getAttachment` resolves the hash via `treeEntryHash`.
7. **Benchmark**: seed a 4,300-record markdown sheet and time `gitsheets-axi
   query --limit 1`, `read`, and a 100-row bulk `patch` before/after.

## Validation

- [x] `cargo test`: format-aware query over a markdown corpus (with/without
      body, pruned + wildcard), `Sheet::query` on a mutated private tree sees
      staged writes, blob-entry / blob-by-hash reads, `.mdx` kind selection.
- [x] `cargo clippy --workspace -D warnings` clean.
- [x] napi `node --test`: `recordQuery` markdown parity with the host codec,
      `CoreTransaction.query` prunes (candidate count) and honors `withBody`,
      `treeReadBlob` / `treeEntryHash` / `blobRead` round-trips.
- [x] pytest: the same module-level functions, byte-identical results.
- [x] vitest (`gitsheets`): the existing markdown, lazy-body, attachment,
      diffFrom, and transaction suites pass unchanged; `grep -n "cat-file"
      packages/gitsheets/src/*.ts` returns only the `repository.ts`
      `cat-file -t` ref-type probe.
- [x] vitest (`gitsheets-axi`) passes (with a writable `TMPDIR`).
- [x] Benchmark table recorded in Notes: markdown `query --limit 1`, `read`,
      and 100-row bulk `patch` on a 4,300-record sheet, before vs after.
- [x] `npm run type-check` clean.

## Risks / unknowns

- **Error mapping** — `readBlobAsRecord` swallowed any failure as "no
  record"; the core path must keep that contract (unparseable blob → `null`),
  not surface `config_invalid`.
- **Attachment `stream()`** — becomes a buffered `Readable`, so a huge
  attachment is held in memory once instead of streamed. Acceptable for the
  human-scale premise; noted in the handle's doc.
- **Core change ⇒ release ordering** — stacks on the `core-napi-v*` release
  #292 already requires.

## Notes

- **Benchmark** (devbox, 4,300-record markdown sheet, `${{ ring }}/${{ id }}`,
  2.3 MB of bodies; published `gitsheets-axi@latest` on gitsheets 2.6.0 +
  core-napi 0.3.0 vs this branch):

  | Command | Before | After |
  | --- | ---: | ---: |
  | `count` | 3.7 s | 0.3 s |
  | `query --fields id --limit 1` | 27.4 s | 1.8 s |
  | `query --filter id=…` | 28.0 s | 1.8 s |
  | `read <sheet> <path>` | 29.3 s | 1.8 s |
  | `patch` 100 rows, one commit | 23.9 s | 6.6 s |
  | `patch --dry-run` 100 rows | 3.0 s | 5.6 s |

  The read wins are the per-candidate subprocess fan-out disappearing; the
  bulk-patch win is the transaction-bound query pruning instead of listing the
  sheet per row. The dry-run regressed because its preflight still begins a
  throwaway core transaction per row (`willChange` on a standalone sheet) —
  deliberately left to the axi follow-up (single-transaction preflight).
- **`Repository.readBlobStream` keeps its `git cat-file` on purpose** — its
  spec is a true streaming read that never buffers the blob. The attachment
  handle's `stream()` is the opposite trade: buffered once, in memory.
- **Markdown bodies parse without their trailing newline** (the codec trims
  it); every new test asserts `'# One'`, not `'# One\n'`.
- The napi test wrapper `binding.cjs` enumerates exports by hand; new addon
  functions must be added there or the boundary suite sees `undefined`.
- Python's `CoreTransaction` has no read surface (no `list`), so no `query`
  was added there — the module-level functions carry parity.
- Remaining `git` shell-outs in the library: `readBlobStream`, push,
  `diff-tree` in `diffFrom`, `ls-tree` for attachment listing, working-tree
  materialization, `rev-parse --absolute-git-dir`, `git config` author
  defaults. None is per-record.

## Follow-ups

- Issue [#289](https://github.com/JarvusInnovations/gitsheets/issues/289) —
  the axi half: body-less `query` by default (bodies only when the filter,
  `--fields`, or an export needs them), `read` by exact path through a
  by-path library read, `--limit` short-circuit without `--sort`.
- Issue [#290](https://github.com/JarvusInnovations/gitsheets/issues/290) —
  bulk `patch` preflight inside the one real transaction (no per-row
  throwaway transaction; dry-run discards), plus progress output for large
  batches.
- Tracked as: `diffFrom` still enumerates changes with `git diff-tree` and
  attachment listing with `git ls-tree` — core walks would retire the last
  two read-side subprocesses; no consumer has reported them as a cost.
