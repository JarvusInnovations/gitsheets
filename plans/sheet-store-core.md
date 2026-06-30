---
status: done
pr: https://github.com/JarvusInnovations/gitsheets/pull/210
depends: [record-query-index]
specs:
  - specs/rust-core.md
  - specs/api/sheet.md
  - specs/api/transaction.md
  - specs/api/store.md
  - specs/behaviors/transactions.md
issues: [127]
---

# Plan: Sheet / Transaction / Store state machine in the core

## Scope

Lift the orchestration layer — `Sheet`, `Transaction`, `Store` — into
`gitsheets-core`, on top of the record engine. **In:** the transaction lifecycle
(parent resolution, optimistic concurrency, commit + ref update), sheet config
resolution, the Store multi-sheet surface, and the strict/permissive mutation
rules. **Out:** the binding-level idiomatic surface and the consumer validator
(those stay per-binding) and the working-tree `--working` path (deferred).

## Implements

- [`specs/rust-core.md`](../specs/rust-core.md) — "The `Sheet` / `Transaction` /
  `Store` state machine" in the core.
- [`specs/api/sheet.md`](../specs/api/sheet.md),
  [`specs/api/transaction.md`](../specs/api/transaction.md),
  [`specs/api/store.md`](../specs/api/store.md),
  [`specs/behaviors/transactions.md`](../specs/behaviors/transactions.md) —
  behavior-preserving (the *contracts* don't change; the implementation moves).

## Approach

- **Transaction.** parent resolution, the in-process mutex / serialization, the
  optimistic `parent_moved` re-check, no-op detection, commit-tree + update-ref
  (already in holo-tree's `commit_tree`/`update_ref`, now with explicit identity).
- **Sheet.** config resolution (`read_toml` for `.gitsheets/<name>.toml`), the
  upsert/willChange/patch pipeline, strict-vs-permissive mode.
- **Store.** the typed multi-sheet surface + `Store.transact`.
- The consumer-validator hook is a **callback into the binding** at the documented
  point (native object → consumer validator → core), since it runs host-side.

## Validation

- [x] The full transaction lifecycle (commit, no-op, `parent_moved`, strict mode)
      matches the JS behavior and the specs. Commit / no-op (tree-hash equality) /
      `parent_moved` / `transaction_in_progress` proven in both the Rust lifecycle
      suite (`transaction.rs` tests) and the napi boundary suite
      (`test/sheet-store.mjs`). Strict mode + the async mutex *queueing* are
      host-`Repository` concerns (the core owns the detectable
      `transaction_in_progress` + `parent_moved` guards) — see Notes.
- [x] An upsert through the core produces the expected commit/tree for the same
      input (against the **new canonical form**, per the plan's bytes-vs-semantics
      note — NOT the v1.0 `@iarna` bytes), incl. correct author/committer identity.
      `full_upsert_commits_with_identity_trailers_and_record` (Rust) +
      `full upsert commits with identity, trailers, and the written record` (node).
- [x] The consumer-validator callback fires at the right point (the two-phase
      protocol) and can reject a write before any bytes are written. Demonstrated
      end-to-end in `the consumer validator can REJECT a write before any bytes are
      written` (asserts nothing was committed), plus the JSON-Schema phase-1
      rejection cases.
- [x] Behavioral parity with the existing transaction/Sheet/Store semantics —
      relevant cases transcribed/ported to the Rust + napi boundary suites (lean on
      the existing JS suite as the oracle). The main JS suite stays green and
      independent: `npm test` (287 + 66) + `npm run type-check` pass; the main
      build never imports the `.node` addon.

## Risks / unknowns

- **The consumer-validator callback across FFI** is the trickiest seam — a
  host-language function invoked mid-core-operation. Design the re-entrancy
  carefully (or validate-then-commit in two phases to avoid calling back into the
  host while holding core state).
- **Behavioral parity surface is large** — this is where "no public-API change"
  is truly tested. Lean on the existing suite as the oracle.

## Notes

**What was built.** Four core modules on top of the merged record/query/index
engine, plus a napi boundary driver:

- `config.rs` — `SheetConfig` parsing (`loadConfig` port): root, path template,
  `fields.<f>.sort` rules, `[gitsheet.schema]`, `[gitsheet.format]`, with the
  markdown body-presence rules. The body↔template *collision* check moved into
  `Sheet::open` (it needs the compiled template's `get_field_names()`).
- `sheet.rs` — the compiled-once `Sheet` handle (config + `Template` +
  `CompiledSchema` + array-sort comparators + index registry + boa `Engine`),
  composing the lower primitives into `prepare_upsert` / `stage_upsert` /
  `will_change` / `delete_at_path` / `clear` / `normalize_record` /
  `path_for_record` / `find_by_*_index`.
- `transaction.rs` — `Transaction::begin`/`finalize` with parent resolution,
  optimistic `parent_moved`, no-op detection, `commit_tree` + CAS `update_ref`,
  trailer validation + commit-message formatting, and a process-wide
  single-writer registry.
- `store.rs` — `discover_sheets` + `check_validators`.
- `gitsheets-napi` — a stateful `CoreTransaction` exposing the state machine, plus
  `coreDiscoverSheets` / `coreCheckValidators`, with a `node --test` boundary suite.

**The two-phase consumer-validator protocol.** The consumer validator
(Zod/Pydantic/Standard Schema) runs **host-side** and stays in the binding; the
core never calls back into the host mid-operation. The write is split:
**phase 1** `prepare_upsert` (non-mutating) shape-validates (JSON Schema),
normalizes, renders the path, runs the unique-index conflict check, and
serializes, returning the candidate (incl. the normalized record marshalled back
to JS); **the host gate** runs the consumer validator on that candidate and
throws to reject; **phase 3** `stage_upsert` (mutating) does the rename-delete +
blob write. Phases 1 and 3 are **separate FFI calls with no core lock held
between them**, so the host callback can never re-enter the core while it holds
state — the re-entrancy hazard from the plan's Risks is structurally avoided
(rather than mitigated by a callback). A transforming validator is supported by
re-invoking `prepare_upsert` on the transformed record before `stage_upsert`
(`prepare_upsert` is idempotent and cheap). Demonstrated end-to-end, asserting a
rejected record is never committed.

**Bytes vs. semantics (per the plan's two design points).** Behavioral parity
(lifecycle, `parent_moved`, no-op, identity, validation rejection) is verified
against the existing JS semantics; byte/tree-level correctness is verified against
the **new Rust canonical form** (key-sorted `toml`-crate bytes), NOT the v1.0
`@iarna` on-disk bytes — matching the old bytes is the cutover's concern
(`node-binding-thin`). E.g. the boundary suite asserts the written blob is the
canonical `email = "..."\nslug = "..."\n`.

**Markdown-format deferral (resolved).** The frontmatter/body codec is **deferred**
to a follow-up. Rationale: the TOML pipeline is the v1.0 bytes-authority capstone;
the markdown codec (frontmatter parse/serialize, H1 title extraction, lazy body)
is a distinct format codec that belongs with the binding re-thin / a dedicated
format-core plan. The core still *parses + validates* markdown config (so config
parity holds), but record ops on a markdown sheet fail loudly with
`config_invalid` ("not yet implemented") rather than writing wrong bytes. TOML
(the default and the vast majority of sheets) is fully implemented.

**Index build-caching deferral (resolved).** Implemented at the `Sheet` level: a
cache keyed by the **data-subtree hash**, built once on demand and dropped on any
mutation (`stage_upsert` / `delete` / `clear` / `define_index`) or when the tree
hash moves — the `#ensureIndexBuilt` state machine, wrapping the pure
`UniqueIndex`/`MultiIndex` build primitives. The pre-write unique-conflict check
in `prepare_upsert` uses it.

**Behavioral-parity coverage.** 110 `gitsheets-core` tests (incl. the lifecycle +
pipeline integration tests on throwaway gix repos) and 61 napi boundary tests
(11 new in `sheet-store.mjs`). The main JS suite (287 + 66) stays green and never
imports the `.node` addon.

**Design decisions.** (1) `time_seconds` / `offset_minutes` are passed *into* the
core for the commit signature — the host owns the wall-clock + local-timezone
offset (exactly as JS `commitTreeWithRepo` computes them), keeping the core
deterministic. (2) The single-writer **registry** in the core detects overlapping
opens (`transaction_in_progress`); the async *queueing* of contended transactions
is host-runtime-specific (Node `AsyncLocalStorage`, Python `asyncio`) and stays in
the binding. (3) Array-field sort comparators (incl. `sort = true`'s
`localeCompare`) are compiled into boa and run there for `node:vm` parity, rather
than reimplemented in Rust — the locale/`Intl` divergence is the spec's existing
embedded-engine parity-gate concern.

## Follow-ups

- **Deferred to plan / follow-up — markdown/mdx record codec.** Implement the
  frontmatter+body format (parse/serialize, H1 title extraction, lazy body,
  `allowMissingBody`) in the core so markdown sheets round-trip. Config is already
  parsed/validated; record ops currently fail loudly. Belongs with
  `node-binding-thin` or a dedicated format-core plan.
- **Deferred (per plan) — the `--working` working-tree path.** Out of scope here;
  to be addressed when the working-tree surface is lifted.
- **Tracked for `node-binding-thin`.** Re-thin the Node `Sheet`/`Transaction`/
  `Store`/`Repository` onto `CoreTransaction` + the core handles: thread the
  consumer Standard Schema validator through the two-phase gate; enforce **strict
  mode** (`requireExplicitTransactions` → `transaction_required`) and the
  permissive auto-transaction host-side; normalize the core's `Option::None`
  result fields to `null` for the public API (the raw napi surface returns
  `undefined`); wire the async single-writer mutex/queueing + `AsyncLocalStorage`
  nesting detection; map the rename `RECORD_PATH_KEY` annotation to the core's
  explicit `previous_path`; and cut over the on-disk bytes (the `@iarna` →
  canonical re-baseline).
- **Tracked for `python-binding`.** The same `CoreTransaction` surface + the
  two-phase protocol drives the Python binding (Pydantic as the host validator);
  the core orchestration is binding-agnostic.
- **Upstream holo-tree hardening (Issue).** `holo_repo::update_ref` writes a
  reflog whose committer it reads from ambient **git config** identity, even when
  the transaction supplies explicit author/committer for the commit. With no
  `user.name`/`user.email` configured (a fresh CI runner, or a consumer in an
  unconfigured/bare context) the ref update fails with *"The reflog could not be
  created or updated."* Worked around for CI by configuring a git identity in
  `rust-core.yml` (matching hologit's own CI), but the proper fix is upstream:
  `update_ref` should derive the reflog identity from the commit's committer (or
  accept an explicit one / allow suppressing the reflog) so a ref update never
  depends on ambient git config. Per the holo-tree hardening mandate, file against
  hologit.
- **`sort = true` locale collation via boa (decide at `node-binding-thin`).**
  Array-field locale sorting (`sort = true`'s `localeCompare`) currently runs
  through the boa engine, which lacks `Intl` — so for non-ASCII / case-sensitive
  strings it sorts by code unit, diverging from the JS `node:vm` ICU collation
  (the documented boa parity-gate trade-off). For ASCII data (the common case)
  there is no divergence. Before the cutover, decide whether locale array-sort
  fidelity warrants native ICU collation in Rust (e.g. the `icu`/`feruca` crate)
  instead of boa — a behavior call with an i18n-data blast radius.
