---
status: done
depends: [core-native-record-reads]
specs:
  - specs/rust-core.md
issues: []
pr: 297
---

# Plan: adopt holo-tree 0.5 (consumer-owned TreeCache + Context)

## Scope

Bump `gitsheets-core`'s `holo-tree` pin from `holo-tree-v0.4.0` to
`holo-tree-v0.5.0` and absorb its one breaking change: every `MutableTree`
operation takes a `&Context` (repository handle + consumer-owned `TreeCache`)
instead of `&gix::Repository`, replacing holo-tree's thread-local cache.
Upstream's own note (hologit#480): "downstream (gitsheets) adopts on the next
holo-tree-v* tag" — this is that adoption.

In scope:

- Core: tree-operation signatures take `ctx: &Context<'_>`; `Transaction`
  owns a `TreeCache` for its private tree (`split()` yields the context);
  the `*_at_ref` convenience helpers build a per-call cache.
- Bindings: a per-thread `TreeCache` behind committed-ref reads (`tree_cache()`),
  the transaction methods take the context from `split()`, `substrateReset`
  clears the thread's cache alongside the counters.
- Spec: `specs/rust-core.md` states the ownership model.

Out of scope:

- Any behavior change. Trees, blobs, and commits are byte-identical; the
  cross-binding parity suite is the proof.
- Sharing one cache across binding threads (the type is `Send` but not
  `Sync` by design).

## Implements

- `specs/rust-core.md` — "Tree caches are consumer-owned, never
  thread-implicit" under the embedded-code thread-model bullets.

## Approach

Compiler-driven, in three passes: (1) rewrite every holo-tree call site to
pass `ctx` and every tree-op signature to take `ctx: &Context<'_>`, keeping
`repo`-only helpers (`resolve_tree`, blob reads by hash, `write_blob`) on the
repository handle; (2) give `Transaction` a `cache` field, `split()` →
`(Context, &mut MutableTree)` by disjoint-field destructuring, `ctx()` for
the commit path; (3) bindings: `thread_local! { static TREE_CACHE: &'static
TreeCache = Box::leak(...) }` so a `Context` can borrow it for a call, and
`let (ctx, tree) = tx.split()` in the transaction methods. Test modules get a
`tctx(repo)` helper over a leaked cache.

## Validation

- [x] `cargo test` (core) passes with the same test count as before the bump.
- [x] `cargo clippy --workspace -D warnings` clean.
- [x] napi `node --test` and `pytest` (incl. the cross-binding byte-parity
      suite) pass unchanged — no byte-level change anywhere.
- [x] vitest `gitsheets` + `gitsheets-axi` pass unchanged.
- [x] `Cargo.lock` pins `holo-tree-v0.5.0`'s commit; the Cargo.toml comment
      names the release.
- [x] Spot benchmark on the 4,300-record sheet shows no regression on
      `query --limit 1` / `read` / 100-row `patch`.

## Risks / unknowns

- **Warm-cache behavior across calls.** 0.4.0's thread-local cache persisted
  across binding calls on a thread; the per-thread leaked cache preserves
  that for ref reads. Transactions start cold by design (one per tx).
- **Borrow shape in `Transaction`.** `Context` borrows `repo` + `cache`
  immutably while `root` is borrowed mutably — fine via direct field access
  (`Context::new(&self.repo, &self.cache)`), not via a `&self` method.

## Notes

- **A/B** (same packed 4,300-record markdown repo, develop addon vs this
  branch loaded side by side in one process, body-less `recordQuery` over all
  records, ms ×3): develop 2528/2538/2535 and 2550/2569/2439; branch
  2738/2540/2546 and 2574/2698/2642 — within noise on a loaded box. The walk
  touches 6 tree objects; the time is blob reads + frontmatter parsing, which
  the cache change does not touch. An earlier apparent 1.8 s → 2.8 s gap was
  the bench repo having been `git gc`-packed in between, plus load.
- `cargo test` count matches develop exactly (246) — the mechanical rewrite
  touched arguments only.
- The 0.5.0 `TreeCache` is `Send` but not `Sync` (`RefCell` inside), so the
  bindings leak one per thread (`thread_local!` holding a `&'static
  TreeCache`) rather than sharing a `static`; `Context` borrows it per call.
- `Transaction::split` returns the context by destructuring disjoint fields;
  building it through a `&self` method would conflict with the mutable
  borrow of the root tree in the commit path.
- holo-tree's global stats counters survive the change; the thread cache is
  cleared in `substrateReset` so benchmark phases start cold on both axes.

## Follow-ups

- Tracked as: the five `*_at_ref` convenience helpers in `record.rs` build a
  fresh cache per call. Taking a `&TreeCache` parameter so bindings can pass
  their per-thread cache would warm them too; no measurable cost today (each
  resolves one tree), so left as is.
