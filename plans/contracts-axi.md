---
status: planned
depends: []
specs:
  - specs/behaviors/contracts.md
issues: []
---

# Plan: contract affordances for gitsheets-axi

## Scope

Surface the contract verification workflow through the agent-facing
`gitsheets-axi` CLI so agents can gate on and diagnose conformance without the
human CLI: `contracts verify`, `contracts test`, and `contracts list` — TOON
output, stable outcome codes, idempotent read-only semantics per the AXI
conventions the package already follows. The recorded follow-up from
[`contracts-cli`](contracts-cli.md).

Out of scope: mutating commands (`adopt`/`sync`/`prune` stay human-CLI-only for
now — adoption is a reviewed, committed act, not an agent loop step; revisit on
demand); any new core/napi surface (everything needed shipped in #265/#267/#268).

## Implements

- `specs/behaviors/contracts.md` — Consumer verification (`test` = rung 2) and
  the producer verify gate, exposed agent-side. Note: `gitsheets-axi` has no
  dedicated spec file (its conventions live in the AXI guidance + its README);
  this plan implements the *behaviors* spec and documents the command surface
  in the package README, matching how the rest of the axi surface is specified.

## Approach

1. Follow the existing `gitsheets-axi` command architecture (find the command
   registry in `packages/gitsheets-axi/src/`, match its option parsing, TOON
   emission, and error-code mapping exactly).
2. `contracts list` — the discovery view: each vendored contract (name, hash,
   declaring sheets) plus each sheet's `implements`; empty-state guidance line.
3. `contracts verify [<sheet>...]` — the offline producer gate, reusing the
   `gitsheets` package's exported machinery (never reimplement validation):
   TOON rows per sheet/contract with `outcome: ok|failed|warning`, per-record
   issues as structured rows (path, field, message, contract), stable exit
   behavior and a `CONTRACT_UNSATISFIED`-style outcome code consistent with
   the package's existing code vocabulary.
4. `contracts test <sheet> --against <file-or-name>` — rung-2 structural check,
   same output discipline; works against sheets declaring nothing.
5. Tests: the package's existing test style (`packages/gitsheets-axi/test/`)
   over fixture repos — verify ok / verify failure detail / test duck-typing /
   list; snapshot or assert the TOON shapes agents will parse.
6. README: document the three commands in the package README's command
   reference, in its existing format.

## Validation

- [ ] `contracts list` renders vendored contracts + declaring sheets in TOON,
      with a helpful empty state
- [ ] `contracts verify` passes on a conforming fixture and reports structured
      per-record issues (path, field, contract) on a seeded defect, with a
      stable outcome code
- [ ] `contracts test --against` verifies a contract-unaware sheet and reports
      per-record conformance
- [ ] Output is agent-parseable TOON consistent with the package's existing
      commands (spot-checked against a real run)
- [ ] Full `gitsheets-axi` suite passes; no changes outside the package +
      README

## Risks / unknowns

- **Code-vocabulary fit** — the package has an established outcome-code set
  (`VALIDATION_FAILED`, `CONFIG_INVALID`, …); new codes must extend it
  consistently, not fork a parallel convention. Read the existing table first.
- **TOON shape for nested issues** — per-record, per-field issues need a flat,
  parseable row shape; follow whatever the package already does for
  `check`-style validation output.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
