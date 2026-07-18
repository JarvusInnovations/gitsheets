---
status: done
depends: [contracts-core]
specs:
  - specs/behaviors/contracts.md
  - specs/api/repository.md
  - specs/api/errors.md
issues: []
pr: 267
---

# Plan: consumer-side contract verification — the two-rung ladder in `openSheet`

## Scope

The library surface a consumer uses to wire itself to another repo's sheet with
a checked interface: `openSheet(name, { contract })` implementing the two-rung
verification ladder, the conformance report on failure, the
`sheet.contractVerification` result surface, and advisory drift re-verification
for structurally-verified sheets.

In scope:

- `contract` option on `openSheet` (`schema` as parsed data or JSON/TOML text;
  `mode: 'verify' | 'declared' | 'structural'`; `onDrift`)
- Rung 1: declaration check (name in `implements`) + canonical-hash identity
  against the vendored document
- Rung 2: structural validation of all records against the consumer's
  document; `ContractError('contract_unsatisfied')` with per-record
  `ValidationIssue`s (including `record` paths) on failure
- `sheet.contractVerification` (`{ name, rung, tree }`)
- Advisory re-verification on rebind to a changed tree (freshness path):
  invoke `onDrift` with the report when a structural guarantee regresses;
  never block reads
- Node binding first; Python parity noted as follow-up

Out of scope: producer tooling ([`contracts-cli`](contracts-cli.md)); any
transport (the consumer opens whatever repo path/clone it already has —
fetching remote repos is the consumer's business); `openSheets`/`openStore`
contract maps (follow-up if demanded).

## Implements

- `specs/behaviors/contracts.md` — Consumer verification (the ladder, modes,
  mismatch-degrades-to-evidence, advisory drift)
- `specs/api/repository.md` — `openSheet` `opts.contract`,
  `sheet.contractVerification`, the `ContractError` rows
- `specs/api/errors.md` — `contract_unsatisfied` with the conformance report
  in `issues` (`record` + `contract` fields populated)

## Approach

1. Core: `verify_sheet_contract(sheet, document, mode)` — canonicalize+hash
   the consumer document (the `contracts-core` primitive); rung 1 = name
   membership in the target's `implements` **and** hash equality with the
   vendored bytes (both required: declaration proves future-write
   enforcement, identity proves same-document); on miss and mode `verify`,
   rung 2 = validate every record against the consumer document alone,
   accumulating per-record issues.
2. Report shape: `{ name, rung, tree, conforming, issues }` — `issues` empty
   on success; on failure it is the payload of
   `ContractError('contract_unsatisfied')`. Reuse the record-validation
   machinery so issue quality matches write-time errors.
3. Node binding: thread `opts.contract` through `openSheet`; run verification
   before returning the handle; attach `contractVerification` to the `Sheet`.
4. Drift: for rung-2-verified sheets, hook the existing rebind/freshness path
   — when the sheet's bound tree hash changes, schedule a lazy re-validation;
   if conformance regressed, invoke `onDrift(report)`. No `onDrift` → no
   re-validation work (don't pay for an unobserved signal). Reads are never
   gated on this.
5. Tests: fixture producer repo (from the core plan's fixtures) exercising —
   rung-1 pass (zero record reads — assert via instrumentation); rung-1 miss
   on hash mismatch falling through to rung-2 pass (producer implements a
   newer compatible version); rung-2 failure report quality (record paths +
   contract name + field issues); `declared` mode never scanning records and
   failing fast; `structural` mode ignoring declarations; drift callback
   firing after a non-conforming commit lands in the producer fixture, with
   reads still succeeding.

## Validation

- [x] Rung-1 verification of a declaring sheet passes with zero record reads
      and reports `rung: 'declared'`
- [x] Against a producer implementing a newer, data-compatible contract
      version, `verify` mode falls through and passes with
      `rung: 'structural'`
- [x] Against a non-conforming sheet, `openSheet` throws
      `ContractError('contract_unsatisfied')` whose `issues` name each failing
      record path, field, and the contract
- [x] `declared` mode refuses (without reading records) any sheet not
      declaring the byte-identical contract; `structural` mode verifies a
      contract-unaware sheet (duck typing)
- [x] After a drift-inducing commit in the producer, `onDrift` fires with a
      regressed report and in-flight reads are unaffected
- [x] The motivating pair works end-to-end as a test: a consumer holding a
      contract wires to a fixture "meal-bank" sheet in another repo, rung-1
      verifies, reads records typed by the contract

## Risks / unknowns

- **Rung-2 cost on large sheets** — full-corpus validation at wiring time is
  the honest guarantee, but on a large sheet it's a real scan. Acceptable at
  contract-consumer scale (human-cadence sheets); if it bites, sampling is
  explicitly *not* the fix (silent partial guarantees) — a persisted
  verification cache keyed by tree hash is. Note in closeout if observed.
- **Drift-hook interaction with freshness rebind semantics** — the rebind path
  is `HEAD`-tree-oriented (see behaviors/freshness.md); verify the hook point
  sees non-`HEAD` ref rebinds too, since cross-repo consumers commonly read
  refs outside `refs/heads/`.
- **Python parity** — the core function is binding-agnostic, but the Python
  `openSheet` surface lags; record as a follow-up rather than widening this
  plan.

## Notes

- **Spec amendment**: `specs/api/repository.md`'s `opts.contract` example
  listed `schema: object | string` with no `format` field, even though both
  this plan's Approach and `specs/behaviors/contracts.md` say the input
  handling "matches `canonicalContractHash`'s" — which requires an explicit
  `format: 'json' | 'toml'` for text input, with no auto-detection. Added
  `format?` to the documented shape (required when `schema` is a string), and
  expanded the documented `sheet.contractVerification` shape from `{ name,
  rung, tree }` to the full `{ name, rung, tree, conforming, issues }` the
  implementation returns — the same conformance-report shape `onDrift`
  receives on a regression (always `conforming: true` / `issues: []` on a
  successful handle, since a failed verification throws rather than returning
  a non-conforming report).
- **Freshness / non-`HEAD`-refs finding** (the plan's flagged risk):
  `Repository`'s rebind path (`#resolveReadTree`) is unconditionally
  `HEAD^{tree}` — there is no `ref` option on `openRepo`/`openSheet` today. A
  "cross-repo consumer reading a ref outside `refs/heads/`" achieves that only
  by pointing `openRepo({ gitDir })` at a distinct git directory/worktree whose
  *own* `HEAD` is checked out to the ref of interest. Since the single rebind
  path (`repo.refresh()` / the post-commit auto-refresh in `repo.transact`)
  operates purely in terms of "that repository's `HEAD`" regardless of what
  ref `HEAD` is attached to, the drift hook riding `Sheet.rebindReadTree` sees
  every rebind there is — there is no separate non-`HEAD`-ref path that could
  bypass it. No code change was needed; there's nothing to build against a
  case the library doesn't support yet. Worth revisiting if/when a pinned-ref
  `openSheet` surface is ever added.
- **Rung-2 cost on large sheets** — not empirically measured against a
  large corpus in this plan (the test fixtures are human-cadence-sized, per
  the design's own target scale). The full-corpus-scan design is unchanged
  from the plan's Approach; a persisted verification cache keyed by tree hash
  remains the identified mitigation if this bites in practice, same as
  contracts-core's own analogous follow-up
  ([#266](https://github.com/JarvusInnovations/gitsheets/issues/266) for
  compiled-contract caching).
- **Drift re-check reuses the full rung-2 scan** — `Sheet`'s lazy drift
  re-verification (`#checkDriftAfterRebind`) re-runs the *same*
  `verify_sheet_contract` call against the new tree, i.e. a fresh full-corpus
  structural scan per rebind for a rung-2-verified sheet with `onDrift`
  registered. Correct and simple; a future optimization could diff only the
  paths that changed between the old and new tree instead. Not built here —
  no drift performance issue observed at the test scale.
- **`resolve_contract_document`** was factored out of the existing
  `canonical_contract_hash` (rather than added fresh) so both the identity
  primitive and the new verification path parse a supplied document through
  the identical `ContractHashInput` handling — no behavioral difference
  introduced, no re-tested edge cases beyond what `canonical_contract_hash`'s
  existing suite already covers.

## Follow-ups

- **Python parity** — `verify_sheet_contract` in `gitsheets-core` is fully
  binding-agnostic, but `rust/gitsheets-py`'s `openSheet` surface doesn't
  thread `opts.contract` through yet. Deliberately out of scope for this plan
  (per Scope); a follow-up plan should mirror the Node binding's
  `verifySheetContract` napi shape onto the pyo3 surface once there's a
  consumer.
- **`openSheets`/`openStore` contract maps** — verifying every sheet a Store
  opens against a map of contracts in one call, rather than per-sheet
  `openSheet({ contract })`. Explicitly deferred in Scope; revisit if a
  multi-sheet consumer wants it.
- **Persisted verification cache** — if rung-2's full-corpus scan cost
  becomes a real bottleneck at wiring time (see Notes), a cache keyed by data
  subtree hash (mirroring the existing per-sheet index-build cache pattern in
  `rust/gitsheets-core/src/sheet.rs`) is the identified fix — sampling is
  explicitly ruled out (silent partial guarantees).
- **`contracts test` CLI command** — the CLI-facing half of consumer
  verification (`specs/behaviors/contracts.md` mentions it alongside
  `openSheet(name, { contract })`) is producer/CLI tooling, out of scope here
  per [`contracts-cli`](contracts-cli.md); that plan (or a new one) should
  reuse `gitsheets_core::verify_sheet_contract` directly — it takes an
  already-opened `Sheet`, so no core changes should be needed to wire it into
  a CLI command.
