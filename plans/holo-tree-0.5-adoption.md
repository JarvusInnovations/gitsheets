---
status: in-progress
depends: [core-native-record-reads]
specs:
  - specs/rust-core.md
issues: []
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

- [ ] `cargo test` (core) passes with the same test count as before the bump.
- [ ] `cargo clippy --workspace -D warnings` clean.
- [ ] napi `node --test` and `pytest` (incl. the cross-binding byte-parity
      suite) pass unchanged — no byte-level change anywhere.
- [ ] vitest `gitsheets` + `gitsheets-axi` pass unchanged.
- [ ] `Cargo.lock` pins `holo-tree-v0.5.0`'s commit; the Cargo.toml comment
      names the release.
- [ ] Spot benchmark on the 4,300-record sheet shows no regression on
      `query --limit 1` / `read` / 100-row `patch`.

## Risks / unknowns

- **Warm-cache behavior across calls.** 0.4.0's thread-local cache persisted
  across binding calls on a thread; the per-thread leaked cache preserves
  that for ref reads. Transactions start cold by design (one per tx).
- **Borrow shape in `Transaction`.** `Context` borrows `repo` + `cache`
  immutably while `root` is borrowed mutably — fine via direct field access
  (`Context::new(&self.repo, &self.cache)`), not via a `&self` method.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
