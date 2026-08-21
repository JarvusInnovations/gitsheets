---
status: done
depends: []
specs:
  - specs/behaviors/contracts.md
issues: []
pr: https://github.com/JarvusInnovations/gitsheets/pull/278
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

- [x] `contracts list` renders vendored contracts + declaring sheets in TOON,
      with a helpful empty state
- [x] `contracts verify` passes on a conforming fixture and reports structured
      per-record issues (path, field, contract) on a seeded defect, with a
      stable outcome code
- [x] `contracts test --against` verifies a contract-unaware sheet and reports
      per-record conformance
- [x] Output is agent-parseable TOON consistent with the package's existing
      commands (spot-checked against a real run)
- [x] Full `gitsheets-axi` suite passes; no changes outside the package +
      README

## Risks / unknowns

- **Code-vocabulary fit** — the package has an established outcome-code set
  (`VALIDATION_FAILED`, `CONFIG_INVALID`, …); new codes must extend it
  consistently, not fork a parallel convention. Read the existing table first.
- **TOON shape for nested issues** — per-record, per-field issues need a flat,
  parseable row shape; follow whatever the package already does for
  `check`-style validation output.

## Notes

Built entirely on `gitsheets`'s **public** export surface — `Repository.
readBlobStream`, `parseConfigToml`/`parseToml`, `canonicalContractHash`,
`validateRecord`, `openSheet({ contract })` — never the human CLI's internal
`packages/gitsheets/src/cli/contracts.ts` (confirmed not part of the
package's export map: `package.json`'s `exports` only publishes
`dist/index.js`). `contracts test` is almost entirely `openSheet(sheet,
{ contract: { schema, format, mode: 'structural' } })` — the exact rung-2
primitive the spec describes, reused as-is with no additional logic needed.

`contracts verify` validates each declared contract independently via
`validateRecord`, plus the sheet's local schema separately, rather than
hand-assembling `{ allOf: [...contracts, local] }` and validating once — a
conjunction of independent JSON-Schema branches is satisfied iff every
branch is (no `$defs` sharing/keyword interaction across the contract vs.
local-schema branches here), so this reproduces the spec's composition
semantics exactly without reimplementing validation or hand-rolling schema
composition. Per-sheet outcome vocabulary settled on `ok` / `warning`
(closed local schema under `allOf`) / `failed` / `skipped` (no declared
contracts), matching the plan's three-way ask plus an explicit skip state.

**Gap found + partially closed:** the human CLI's `contracts verify` checks
a declared contract's full "document requirements" (self-contained, open-
for-extension, no null-bearing keywords, canonical bytes, `$id`-matches-path)
via the core's `load_contract`/`check_contract_document`, reached through the
package's *internal* `addon` object. No such check is reachable read-only
through the public surface — `Sheet::open`'s `compile_effective_schema` (the
only call site) only runs on the **write** path. Closed the two cheapest,
safely-replicable checks locally (canonical-TOML-bytes via
`canonicalContractHash`, `$id`-matches-derived-path via string comparison —
neither is JSON-Schema validation) so a corrupted/hand-edited vendored file
is still caught by `contracts verify` (regression test: "fails … when the
vendored document is not canonical TOML"). The remaining three checks
(self-contained/no external `$ref`, open-for-extension, no null) are not
independently re-verified; a malformed vendored document on those axes still
surfaces correctly at the sheet's next `upsert` (enforcement stays where
enforcement already happens), so this is a narrower pre-hoc diagnostic gap,
not a hole in enforcement.

## Follow-ups

- **Full contract document-requirements check for `contracts verify`** would
  need new `gitsheets` public surface (e.g. an exported `checkContractDocument`/
  `loadContract`-equivalent) to reach the core's self-contained /
  open-for-extension / no-null-keyword checks read-only. Explicitly out of
  scope for this plan ("any new core/napi surface" was declared out of
  scope) — revisit if `contracts verify` needs to catch these without an
  intervening write.
- **`--prefix` on `contracts verify`/`test`** (tenant sub-tree scoping,
  matching `query`/`check`/`attachment`) wasn't added — not requested by the
  plan and contracts vendor at the repo/root level, not per-tenant. Revisit
  on demand.
