---
status: planned
depends: [contracts-core]
specs:
  - specs/behaviors/contracts.md
  - specs/api/repository.md
  - specs/api/errors.md
issues: []
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

- [ ] Rung-1 verification of a declaring sheet passes with zero record reads
      and reports `rung: 'declared'`
- [ ] Against a producer implementing a newer, data-compatible contract
      version, `verify` mode falls through and passes with
      `rung: 'structural'`
- [ ] Against a non-conforming sheet, `openSheet` throws
      `ContractError('contract_unsatisfied')` whose `issues` name each failing
      record path, field, and the contract
- [ ] `declared` mode refuses (without reading records) any sheet not
      declaring the byte-identical contract; `structural` mode verifies a
      contract-unaware sheet (duck typing)
- [ ] After a drift-inducing commit in the producer, `onDrift` fires with a
      regressed report and in-flight reads are unaffected
- [ ] The motivating pair works end-to-end as a test: a consumer holding a
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

(populated at closeout)

## Follow-ups

(populated at closeout)
