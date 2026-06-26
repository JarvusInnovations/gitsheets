# holo-tree findings — gitsheets spike (#127)

Running log of ergonomic + correctness findings from being the first integrated
consumer of the Rust holo-tree libs. Per the spike's governing principle, rough
edges get fixed **upstream in holo-tree**, not papered over in gitsheets glue.
This is the input to the Phase-C hologit PR.

Branch: gitsheets `spike/holo-tree-napi` consumes hologit `feat/holo-tree-napi`.

Legend: **Fixed** = patched on the hologit branch · **Open** = needs upstream work.

---

## 1. `get_or_create_subtree` drops writes into existing dirs, then panics — **Fixed**

**Severity: critical.** Hit by *every* upsert into an already-populated sheet
directory (the common case after the first record lands).

Two bugs in one path:

- It marked the navigated path dirty only when a *new* node was created. Writing
  into an existing dir dirtied just the leaf; its clean ancestors short-circuited
  in `write()` (`if !self.dirty { return self.hash }`), so `write()` returned the
  parent's unchanged tree hash and **silently dropped the write**.
- It returned a lazily-loaded existing destination node with `children: None`;
  the mutating caller (`write_child_bytes`) did `children.as_mut().unwrap()` and
  **panicked**, which aborted the whole Node process across FFI (see #6).

Fix (hologit `fdc4657f`): mark the whole path dirty unconditionally (this
navigator is only called to mutate) and `ensure_children` on the returned node
(also preserves existing siblings). Added `tests/write_child.rs`.

**Why integration caught it:** holo-tree's own merge tests only build trees from
scratch (every dir created fresh → `children: Some`), so neither bug showed. The
first write into a *pre-existing* directory is what exposed both.

## 2. `update_ref` rejects bare branch names — **Fixed**

**Severity: medium** (drop-in substrate compatibility).

`git update-ref main …` works; gix's `reference()` rejects a standalone
lowercase name ("Standalone references must be all uppercased"). gitsheets'
`transact({ branch: 'main' })` passes the short name straight through.

Fix (hologit `96d710b7`): `update_ref` qualifies a bare name to
`refs/heads/<name>`; qualified names and all-caps pseudo-refs pass through.

## 3. `commit_tree` can't take explicit author/committer/time — **Open**

**Severity: high** (correctness + blocks commit-hash parity).

`holo_tree::repo::commit_tree(repo, tree, parents, message)` derives identity
from git config and stamps `SystemTime::now()`. gitsheets resolves an explicit
author/committer per transaction (constructor opts, or a documented anonymous
fallback) and the JS path sets `GIT_AUTHOR_*`/`GIT_COMMITTER_*` per commit. Via
holo-tree the commit silently gets git-config identity instead, and the
uncontrollable timestamp means **commit-hash parity with the JS path is not
achievable** — so the spike asserts tree-hash parity only.

Recommendation: `commit_tree` should accept explicit author + committer
signatures (name/email/time), e.g. an options struct, falling back to config as
today. This is the last gap to a true drop-in commit path.

## 4. `holo_tree::Error` flattens to a string across FFI — **Open**

**Severity: medium.** The binding maps every `holo_tree::Error` to
`napi::Error::from_reason(e.to_string())`, collapsing the variant. gitsheets
maps substrate failures onto typed error classes (`RefError`, `TransactionError`,
…); a stringified `Display` makes that lossy/brittle.

Recommendation: give `holo_tree::Error` stable, matchable discriminants (an enum
kind or string code) that survive FFI, so consumers can branch on cause without
parsing prose.

## 5. `&gix::Repository` threaded through every call + thread-local cache — **Open (design)**

**Severity: medium** (ergonomics + a correctness risk across threads).

Nearly every `MutableTree`/`repo` fn takes `&gix::Repository`, and the tree cache
is a `thread_local!`. The binding smooths the first half (a `Tree` holds a
`ThreadSafeRepository` and derives `to_thread_local()` per call) — but that is
exactly the kind of thing the principle says to fix upstream, not hide. And the
second half is untouched: if napi/libuv ever dispatches calls for one logical
operation on different threads, the thread-local cache silently misses (or worse).

Recommendation: a repo-bound tree handle (tree owns/borrows its repo so calls
don't thread it), and/or an explicit cache/session object the consumer owns and
passes — instead of process/thread-implicit global state.

## 6. A panic aborts the host process across FFI — **Open**

**Severity: high** (robustness for any embedded consumer).

When finding #1 panicked, the process died with `fatal runtime error: failed to
initiate panic, error 5, aborting` — not a catchable JS exception. holo-tree uses
`.unwrap()` on internal invariants in hot paths; any violated invariant takes
down the host. Fixing #1 removed *this* panic, but the class remains.

Recommendation: return `Result` from internal invariants rather than `unwrap()`
on the public path; and/or have the binding install a panic hook / rely on
napi's `catch_unwind` so a panic surfaces as a JS error instead of an abort.
(Worth confirming why the napi boundary didn't already catch it — possibly the
`napi` feature set in the binding's `Cargo.toml`.)

## 7. `update_ref` has no compare-and-swap — **Open (minor)**

`git update-ref <ref> <new> <old>` supports an expected-old-value for optimistic
concurrency; holo-tree uses `PreviousValue::Any` (force). gitsheets does its own
parent-moved re-check before finalize, so this isn't blocking, but exposing an
expected-old-value would let the substrate enforce it natively.

---

## What worked well

- **Tree-build parity is byte-identical.** For single and bulk upserts, holo-tree
  produces the exact tree hash git/hologit produce — the core substrate-
  equivalence claim holds. (Validated in `src/holo-tree-parity.test.ts`.)
- **Binding boundary conventions are clean:** object ids as hex strings and blob
  content as `Buffer` mapped onto gitsheets' existing conventions with zero
  friction.
- **`napi build` DX is good:** generated `index.d.ts` carries the Rust doc
  comments through to TypeScript verbatim.
