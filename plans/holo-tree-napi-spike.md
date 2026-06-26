---
status: planned
depends: []
specs:
  - specs/architecture.md
upstream-specs:
  - hologit:holo-tree/README.md
issues: [127]
---

# Plan: holo-tree napi spike — validate the Rust tree substrate on one vertical slice

## Scope

A **validation spike**, not the migration. The goal is to prove that the new
Rust `holo-tree` crate (plus a fresh napi-rs binding) is a suitable, ergonomic
substrate for gitsheets' tree operations — and to **harden holo-tree upstream**
while we're the first real integrated consumer.

**In scope:**

- **Phase A** — a new `holo-tree-napi` crate in the **hologit** repo (branch
  `feat/holo-tree-napi`): a napi-rs binding exposing the narrow slice of
  `MutableTree` + `repo` functions gitsheets needs. Publishable, general-purpose
  (not gitsheets-private), so it validates the surface for *all* future JS
  consumers of holo-tree.
- **Phase B** — wire **one** end-to-end gitsheets path through the binding on the
  gitsheets `spike/holo-tree-napi` branch: a single-record **upsert committed via
  a transaction**, i.e. `transact → writeChild → root.write() → commit-tree →
  update-ref`. Keep the existing hologit JS path in place for everything else;
  the slice runs behind the unchanged public API.
- **Phase C** — harvest the ergonomic findings discovered in A/B into a written
  list, and open a **hologit PR** that improves holo-tree's API/ergonomics for
  this integrated use case. This is a first-class deliverable, not a footnote.

**Explicitly out of scope** (lands later, gated on this spike's verdict):

- Migrating the other tree sites — `getSubtree`/`getBlobMap`/`getChild`/
  `deleteChild`/`merge`/`clearChildren`, `path-template/`, `cli/`,
  `Sheet.diffFrom` (`git.diffTree`), `writeWorkingChanges`. These become a
  follow-up **full-migration plan** once the slice validates the substrate.
- `singer-target.js` empty-tree usage, holo-projector, any public-API change
  (the migration's governing constraint is **no public-API impact** — see
  [`specs/architecture.md`](../specs/architecture.md) "Holo-tree migration",
  issue #127).
- Publishing `holo-tree-napi` to npm. The spike consumes it locally.

## Implements

This plan does not change any spec. It implements **toward** the deferred,
internal-engine substrate swap already described in the specs, under the
guardrail those specs set:

### Own specs

- [`specs/architecture.md`](../specs/architecture.md) — the "Tree primitives"
  stack row and the "Holo-tree migration (deferred post-v1.2)" section. The
  load-bearing constraint inherited here: **the swap must have no public-API
  impact** — consumers see only faster tree ops. The spike's vertical slice must
  sit entirely behind the existing `Repository`/`Sheet`/`Transaction` surface,
  with the JS path untouched for everything it doesn't cover.

### Upstream specs (informational — owned by hologit, not audited here)

- `hologit:holo-tree/README.md` — the holo-tree crate's documented surface
  (`MutableTree`, three merge modes, `repo::create_tree_from_ref` /
  `commit_tree` / `update_ref`, `read_toml`, `GlobMatcher`). We consume it and,
  per the spike's purpose, propose changes to it.

## Approach

### Governing principle: fix the substrate, don't paper over it

The entire point of being the first integrated consumer is to **harden
holo-tree for future consumers who won't also author it**. So: when Phase A or B
hits a rough edge in holo-tree's API — an awkward signature, a missing
convenience, a forced dance around the thread-local cache, a type that doesn't
cross the napi boundary cleanly, an error that's hard to map — the response is to
**record it and fix it upstream in holo-tree** (Phase C), *not* to absorb it in
gitsheets glue or the binding's JS shim. The binding may smooth genuinely
JS-specific concerns (async, Buffer marshalling), but anything that is really a
holo-tree shortcoming goes back to holo-tree. Every workaround we'd be tempted
to write in gitsheets is a Phase-C finding.

### Phase A — `holo-tree-napi` binding (hologit repo)

On `hologit/feat/holo-tree-napi`, add a `holo-tree-napi/` member to the existing
Cargo workspace (alongside `holo-tree/`, `holo-projector/`):

- napi-rs (`napi`, `napi-derive`, `napi-build`) crate scaffold; `napi build` →
  `.node` addon + generated `index.d.ts`; `package.json` named e.g.
  `holo-tree-napi` (or `@hologit/holo-tree`).
- Expose the **minimal** surface the upsert slice needs, plus a repo handle:
  - open/hold a repo handle (wrap `gix::open`) — decide how the `&gix::Repository`
    that holo-tree threads through nearly every call is held across napi calls
    (this is finding #1 territory — see Risks).
  - `createTreeFromRef(ref) -> Tree` ← `repo::create_tree_from_ref`
  - `tree.writeChild(path, content)` ← `MutableTree::write_child` /
    `write_child_bytes` (Buffer in, hashes blob + deep-inserts)
  - `tree.write() -> treeHash` ← `MutableTree::write`
  - `commitTree(treeHash, parents, message, author/committer) -> hash` ←
    `repo::commit_tree`
  - `updateRef(ref, hash)` ← `repo::update_ref`
  - `emptyTreeHash()` ← `tree::empty_tree_id` (cheap, likely needed soon)
- Map `holo_tree::Error` → JS errors with enough structure that gitsheets can
  translate to its typed error classes (don't lose the variant).
- A couple of Rust/Node smoke tests proving an upsert+commit round-trips against
  a scratch repo.

### Phase B — one vertical slice (gitsheets repo)

On `gitsheets/spike/holo-tree-napi`, add `holo-tree-napi` as a **local path or
git dependency** (not npm) and route exactly the upsert-commit path through it,
leaving the hologit JS path in place elsewhere. Concretely, the current chain is:

- `Repository.transact` → `hologitRepo.createWorkspaceFromRef(parentCommitHash)`
  → `transaction.ts` holds `workspace.root` (a hologit `TreeObject`).
- `Sheet.#upsertInTx` (`sheet.ts:1353`) → `this.#dataTree.writeChild(fullPath,
  content)` (subtree of `workspace.root`).
- `Transaction.commit` (`transaction.ts:~245`) → `this.#workspace.root.write()`
  → `treeHash`, then **shells out** to `git commit-tree` and `git update-ref`.

The slice replaces that chain's tree object with a holo-tree `MutableTree` from
the binding: `createTreeFromRef(parentRef)` → `writeChild(path, bytes)` →
`write()` → `commitTree(...)` → `updateRef(...)`. Note this also **retires two
subprocess shell-outs** (`commit-tree`, `update-ref`) — a concrete ergonomics +
perf win to measure.

- Gate the slice behind an internal flag/seam (e.g. an env var or a constructor
  option) so both paths coexist on the branch and can be A/B compared. Do **not**
  change the public API.
- Prove parity: an upsert through the holo-tree path must produce the **same
  commit/tree hash** as the hologit-JS path for the same input (git objects are
  content-addressed, so byte-identical trees → identical hashes — a strong,
  cheap oracle).
- Benchmark the slice vs the JS path (single upsert, and a batch of N upserts in
  one transaction) and record the numbers.

### Phase C — ergonomics findings + hologit PR

- Maintain a running findings log during A/B (scratch file on the branch, e.g.
  `notes/holo-tree-findings.md` — not committed to gitsheets `main`).
- Turn the findings into a concrete **hologit PR** on `feat/holo-tree-napi` (or a
  sibling branch) that improves holo-tree's ergonomics/suitability for embedded
  consumers. Likely candidates to evaluate (confirm against real friction, don't
  pre-commit): a repo-bound handle so callers don't thread `&Repository` through
  every call; clearer error variants / `Display` for cross-FFI mapping; a
  one-call "commit these blobs to this ref" convenience; cache lifecycle that's
  safe when calls arrive on different libuv threads.
- The PR is the deliverable that closes the loop on "validate *and improve* the
  RS libs."

## Validation

- [ ] `holo-tree-napi` crate builds on this machine (`napi build`) and produces a
      loadable `.node` addon + generated `.d.ts`.
- [ ] Rust/Node smoke test: create-tree-from-ref → write-child → write →
      commit-tree → update-ref round-trips against a scratch repo and the ref
      advances to the new commit.
- [ ] gitsheets `spike/holo-tree-napi` consumes the binding via a local
      path/git dep and builds + type-checks.
- [ ] A single-record upsert committed through the holo-tree slice produces a
      commit whose **tree hash and commit hash match** the hologit-JS path for
      the same input (parity oracle).
- [ ] The existing gitsheets vitest suite stays green with the slice flag **off**
      (no regression to the JS path), and the upsert-path tests also pass with the
      flag **on**.
- [ ] Benchmark recorded: holo-tree slice vs JS path for 1 upsert and N-in-one-tx,
      including the eliminated `commit-tree`/`update-ref` shell-outs.
- [ ] Findings log written, and a hologit PR opened against
      `JarvusInnovations/hologit` implementing at least the highest-value
      ergonomic improvement surfaced (link the PR in this plan's Notes at
      closeout).
- [ ] A go/no-go note on the full migration (does holo-tree, as improved, clear
      the bar to become the v-next substrate?) plus a pointer to the follow-up
      full-migration plan if go.

## Risks / unknowns

- **`&gix::Repository` threading + thread-local cache.** holo-tree takes
  `&Repository` on nearly every method and keeps a *thread-local* tree cache.
  napi/libuv may dispatch calls on different threads, which can silently void the
  cache or worse. This is the single biggest ergonomics question — and exactly
  the kind of thing to fix upstream (a repo-bound handle, or an explicit
  cache/session object), not to hack around in the binding. Treat as Phase-C
  finding #1.
- **napi value marshalling.** Blob content (binary), object ids (hex strings vs
  bytes), and author/committer identity need clean, cheap crossings. Watch for
  forced UTF-8 assumptions on blob bytes (records are TOML/text, but attachments
  are binary).
- **Error fidelity across FFI.** `holo_tree::Error` variants must survive to JS so
  gitsheets can map them to its typed error classes; a stringified `Display` may
  lose structure. Candidate Phase-C improvement.
- **Build/toolchain friction.** Rust toolchain + napi build in a JS repo's dev
  loop; per-platform prebuilds are out of scope for the spike (build locally).
- **Parity oracle assumptions.** Identical-hash parity assumes byte-identical
  tree serialization (sorting, modes, empty-tree handling). A hash mismatch is a
  *finding*, not necessarily a blocker — investigate whether it's a holo-tree
  serialization difference.
- **Spike, not migration.** The slice deliberately leaves the JS path in place.
  Resist scope-creep into the full swap; that's the follow-up plan's job.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
