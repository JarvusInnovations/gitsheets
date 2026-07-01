---
status: done
depends: [holo-tree-napi-spike]
specs:
  - specs/architecture.md
  - specs/rust-core.md
upstream-specs:
  - hologit:holo-tree/README.md
issues: [127]
pr: https://github.com/JarvusInnovations/gitsheets/pull/203
---

# Plan: holo-tree migration — swap the whole tree substrate off hologit JS

## Scope

The full migration the [`holo-tree-napi-spike`](holo-tree-napi-spike.md) validated
(verdict: GO). Replace **every** gitsheets tree/commit operation that currently
goes through the hologit JS dependency with the Rust `holo-tree-napi` binding,
then **remove the `hologit` dependency entirely** — all behind the unchanged
public API.

**In scope:**

- Extend the binding to the full surface gitsheets needs (the spike bound only
  the upsert→commit slice).
- Migrate every consumer site: `repository.ts`, `sheet.ts`, `transaction.ts`,
  `path-template/`, `cli/`.
- Resolve the three operations #127 flagged as "not covered by holo-tree":
  `writeWorkingChanges`, `diffTree` (for `Sheet.diffFrom`), `git.var('GIT_EDITOR')`.
- Drop `hologit` from `package.json`; the binding becomes the sole substrate.
- Delete the spike's dual-path scaffolding (the `enableHoloTree` flag, the op-log,
  the parity gate) — holo-tree becomes the only path.

**Explicitly out of scope:**

- holo-projector, the broader hologit projection engine.
- Any public-API change. The migration's governing constraint remains **no
  public-API impact** (see [`specs/architecture.md`](../specs/architecture.md)
  "Holo-tree migration", #127).
- Per-platform prebuild/release engineering for the binding beyond what gitsheets
  needs to ship (coordinate with the hologit side).

## Implements

### Own specs

- [`specs/architecture.md`](../specs/architecture.md) — flips the "Tree
  primitives" row from **hologit (JS)** to **holo-tree (Rust via napi)** and
  retires the "Holo-tree migration (deferred)" section. That spec edit is
  **spec-first**: it lands in its own PR before this plan brings code into
  conformance. The load-bearing constraint carried forward: no public-API impact.

Every other spec (`api/*`, `behaviors/*`) must stay green *unchanged* — this is
an internal substrate swap, so the existing suite + a clean spec-drift audit are
the conformance proof, not new spec text.

### Upstream specs (informational)

- `hologit:holo-tree/README.md` — the holo-tree surface this consumes; new
  operations needed here may require upstream additions (same harden-upstream
  principle as the spike).

## Approach

### Governing principle (carried from the spike)

Same as [`holo-tree-napi-spike`](holo-tree-napi-spike.md): rough edges in
holo-tree get **fixed upstream**, not papered over in gitsheets glue. The full
surface will surface more findings than the slice did — expect more upstream PRs.

### Step 1 — extend the binding surface

The spike bound `createTreeFromRef`/`createTree`, `writeChild`/`writeChildBytes`/
`readBlob`/`deleteChildDeep`/`write`, `commitTree`/`updateRef`, `emptyTreeHash`.
The full migration additionally needs (map to holo-tree, adding upstream where
missing):

- `getChild` / `getChildren` / `getSubtree` ← `get_child` / `ensure_children` /
  `get_subtree` (returning child-type + hash info across FFI).
- `getBlobMap` ← `get_blob_map` (recursive blob flatten — used by query-all,
  export, attachment iteration). Watch read-heavy perf (hologit#464).
- `clearChildren` ← O(1) empty-tree pointer (hologit `TreeObject.clearChildren`;
  confirm/ add the holo-tree equivalent).
- `merge` (overlay/replace/underlay + glob) ← `MutableTree::merge` + `MergeOptions`.
- `readToml` ← `read_toml` (config reads; replaces the hologit `Configurable`
  pattern + the `@iarna/toml` augmentation in `toml.ts`).
- `writeBlobFromFile` (hash a file from disk → blob) ← needs a holo-tree helper
  or a gix `write_blob` from a file stream; used by `cli/` for binary attachments.
- `getHash` on an in-memory tree (for no-op detection without re-`write()`).

### Step 2 — migrate consumers

Site by site, replacing hologit `TreeObject`/`BlobObject`/`Workspace` handles with
binding handles. Order roughly by dependency:

- `repository.ts` — `createWorkspaceFromRef`/`getWorkspace`/`createWorkspaceFromTreeHash`/
  `resolveRef`/`createBlob`/empty-workspace → binding `Repo` + `Tree`.
- `transaction.ts` — make the holo path the **only** path; delete the op-log,
  the `enableHoloTree` flag, and the parity gate; keep the resolved-identity
  commit.
- `sheet.ts` — `getChild`/`getSubtree`/`getBlobMap`/`writeChild`/`deleteChild`/
  `clearChildren`/`getHash`/`clone`/blob `read`; and `diffFrom` (see Step 3).
  Note the structural-compat assumptions (`srcBlob`/`dstBlob` as hologit
  `BlobObject`) in the diff path need new handle shapes.
- `path-template/index.ts` — `getChild`/`getChildren`/`getBlobMap` (mind the
  `for...in` prototype-walk hologit needed; the binding returns plain data).
- `cli/index.ts` — `writeBlobFromFile` for binary attachments.

### Step 3 — the three "not covered" operations

- `writeWorkingChanges()` (flush in-memory tree → working dir, today `git
  read-tree -m -u`): add to the binding/holo-tree repo module, or shell out to
  git. Decide during the plan; lean toward an upstream holo-tree helper.
- `git.diffTree()` for `Sheet.diffFrom` record-level diffs: use gix's diff API
  (new binding surface) or continue shelling out. Measure both.
- `git.var('GIT_EDITOR')`: trivial — stays in JS (`git var`), no substrate
  dependency.

### Step 4 — drop hologit

Remove `hologit` from `packages/gitsheets/package.json`; delete the
`hologitRepo` accessor and the `@internal` substrate escape hatch; update
`architecture.md` "What we deliberately don't use" / stack rows. Confirm no
remaining `from 'hologit'` imports.

## Validation

- [x] Binding exposes the full surface above (`@hologit/holo-tree@^0.3.0`),
      including the `deleteChildDeep` ancestor-dirtying fix; smoke-tested green.
- [x] No `from 'hologit'` imports remain in `packages/gitsheets/src`; `hologit`
      removed from `package.json`; `npm run build` + `type-check` clean.
- [x] The **entire** existing gitsheets vitest suite passes on the holo-tree
      substrate (287/287) — the no-public-API-change conformance proof.
- [x] Public API runtime-compatible: hologit `BlobObject`/`TreeObject` in the
      public surface (`UpsertResult.blob`, `getAttachment(s)`, `diffFrom`
      `srcBlob`/`dstBlob`, `Transaction.tree`) replaced by gitsheets-owned
      structurally-compatible `BlobHandle` / `TreeView` — no runtime behavior
      change. (The `.d.ts` type *names* change, by design, to drop hologit.)
- [ ] `/audit-spec-drift` clean — **follow-up** (not run in this PR).
- [ ] Benchmark across the full surface — **follow-up** (the spike's microbench
      already returned GO; a full-surface rerun is deferred).
- [ ] `architecture.md` substrate flip merged spec-first — **follow-up**: lands
      as its own spec-only PR (this PR makes no `specs/` changes).

## Risks / unknowns

- **The "not covered" trio.** `writeWorkingChanges` + `diffTree` are the least
  certain — they may need real upstream holo-tree work or stay as git shell-outs
  (a partial migration). Scope creep risk; decide early.
- **Structural-compat handles.** Several gitsheets sites lean on hologit's
  `TreeObject`/`BlobObject` *shapes* (e.g. `diffFrom`'s `srcBlob`/`dstBlob`).
  The binding returns plain data, so these need redesigned handle types without
  changing the public API.
- **Read-heavy perf + the thread-local cache.** `getBlobMap`/query over large
  sheets is the workload the spike didn't measure; depends on hologit#464 items
  (per-read clone, object cache, per-call `to_thread_local`).
- **Distribution.** A published binding with per-platform prebuilds is a release
  prerequisite (`awaits:`), and a new native-addon install story for consumers.
- **Bigger finding surface.** The full API will expose more holo-tree rough
  edges than the slice; budget for upstream round-trips.

## Notes

- **Done** in [#203](https://github.com/JarvusInnovations/gitsheets/pull/203) on
  `@hologit/holo-tree@^0.3.0`. The whole tree layer runs on the binding; the
  `hologit` JS dependency is removed. Key landings:
  - **Working tree (Sheet / path-template) — the previously-blocked thread.** A
    single binding `Tree` now threads `Repository → Transaction → Sheet /
    path-template`. `src/working-tree.ts` introduces **`TreeView`**, a deep-path
    adapter (`rootTree.op(joinTreePath(base, rel))`, no subtree handles — a
    "subtree" is another `TreeView` over the same root at a deeper base). It
    backs `getChild`/`getChildren`/`getBlobMap`/`writeChild`/`writeChildBytes`/
    `deleteChild`/`clearChildren`/`getSubtree`/`getHash`/`clone`. The `0.2.0`
    `deleteChildDeep` flush bug is **fixed in `0.3.0`** (delete dirties
    ancestors), which unblocked this.
  - **Transaction.finalize** is binding-only now (no git-CLI fallback):
    working-tree flush (`Tree.write()`), `commitTree`, the no-op tree-hash
    probe, the parent-moved precheck, and CAS `updateRef`.
  - **Repository** opens the binding `Repo`, resolves `gitDir` via `git rev-parse
    --absolute-git-dir`, and exposes `writeBlob` (binding `writeBlob`) for the
    CLI's binary attachments.

- **Public blob/tree handles — gitsheets-owned now.** `BlobHandle`
  (`{ isBlob; hash; mode; read(): Promise<Buffer> }`) and `TreeView` replace
  hologit's `BlobObject`/`TreeObject` in the public surface (`UpsertResult.blob`,
  `getAttachment(s)`, `diffFrom` `srcBlob`/`dstBlob`, `Transaction.tree`).
  Structurally compatible with how consumers used them → no runtime behavior
  change; the `.d.ts` type *names* change by design so the hologit dep can go.
  `BlobHandle` is exported from the package root.

- **Platform failure mode.** `substrate.loadBinding()` lazily imports the addon
  and throws a clear `ConfigError` naming `process.platform-process.arch` when no
  prebuilt loads (outside the 6 targets: linux x64/arm64 gnu+musl, darwin
  arm64/x64, win x64) — not a cryptic native-loader throw. The binding is
  mandatory; the old `GITSHEETS_COMMIT_SUBSTRATE=git` escape is gone.

- **Staying on the git CLI by design** (per #127): `Sheet.diffFrom`'s
  record-level diff (`git diff-tree` + `git cat-file`), the CLI `$EDITOR` flow,
  author resolution (`git config`), and HEAD discovery (`git symbolic-ref` /
  `rev-parse`). These are git-porcelain ops, not hologit.

- **push-daemon race fix (incidental).** `checkStartupBacklog` no longer
  additively primes its pending counter once a live `notifyCommit` has been
  observed — a latent double-count the now-fast in-process commit path reliably
  exposed.

## Follow-ups

- **gitsheets:** spec-first `architecture.md` substrate flip (hologit → holo-tree
  for the v1.0 "Tree primitives" row) — its own spec-only PR (this PR makes no
  `specs/` changes).
- **gitsheets:** run `/audit-spec-drift` and a full-surface benchmark
  (query-all/`getBlobMap`, diff, working-tree flush) on the binding substrate.
