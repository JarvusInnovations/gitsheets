---
status: planned
depends: [holo-tree-napi-spike]
specs:
  - specs/architecture.md
upstream-specs:
  - hologit:holo-tree/README.md
awaits:
  - "JarvusInnovations/hologit#465 — holo-tree fixes + the holo-tree-napi binding must merge first"
  - "holo-tree-napi published (npm, or a pinned git dep) with per-platform prebuilds — a release can't carry a local file: dep to a sibling repo"
issues: [127]
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

- [ ] Binding exposes the full surface above; `napi build --release` + smoke
      tests green.
- [ ] No `from 'hologit'` imports remain in `packages/gitsheets/src`; `hologit`
      removed from `package.json`; `npm run build` + `type-check` clean.
- [ ] The **entire** existing gitsheets vitest suite passes on the holo-tree
      substrate (the no-public-API-change conformance proof) — not just the
      upsert path.
- [ ] Public API surface unchanged: the published `.d.ts` diff is empty (no
      consumer-visible type change).
- [ ] `/audit-spec-drift` clean — implementation still matches every spec.
- [ ] Benchmark across the full surface (query-all/`getBlobMap`, diff, merge,
      working-tree flush), not just upsert; results recorded.
- [ ] `architecture.md` substrate flip merged spec-first before code conformance.

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

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
