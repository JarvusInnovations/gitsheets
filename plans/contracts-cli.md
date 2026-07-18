---
status: done
pr: 268
depends: [contracts-core]
specs:
  - specs/behaviors/contracts.md
  - specs/api/cli.md
issues: []
---

# Plan: contracts CLI — adopt, verify, test, sync, export, prune

## Scope

The producer-facing (and CLI-consumer-facing) tooling for contracts: the
`git sheet contracts` command group and the `.gitsheets/contracts/sources.toml`
provenance sidecar. Everything rides `contracts-core`'s loader, requirement
checks, and canonical-hash primitive.

In scope:

- `contracts adopt <source> [--sheet <name>]...` — fetch/read (local path or
  HTTPS URL; JSON or TOML), enforce document requirements, canonicalize,
  vendor at the derived path, record provenance; with `--sheet`, gate on
  validating every existing record against the new effective schema
- `contracts verify [<sheet>]...` — the offline CI gate, including the
  closed-local-schema warning
- `contracts test <sheet> --against <file-or-name>` — structural (rung-2)
  check against an arbitrary document
- `contracts sync [<name>]...` — re-fetch sources, report drift, never rewrite
- `contracts export <name>` — interchange JSON to stdout
- `contracts prune [--dry-run]`
- `ContractError` exit code 67; error output per the existing CLI error shape

Out of scope: git-native source shorthand and vanity-name resolution
(`specs/deferred.md`); registry tooling; the library-consumer verification
surface ([`contracts-consumer-verify`](contracts-consumer-verify.md));
`gitsheets-axi` contract affordances (follow-up — see Risks).

## Implements

- `specs/behaviors/contracts.md` — the sources sidecar; adoption gating
  (validate-existing-records); immutability posture of `sync`; prune as the
  non-error path for orphans
- `specs/api/cli.md` — the `git sheet contracts` command group; exit code 67

## Approach

1. Command group scaffold following the existing CLI command layout; all
   writes confined to `.gitsheets/contracts/` — sheet configs are never
   modified (print the exact `implements` line for the author to add after a
   successful adopt).
2. `adopt`: source read (fs / HTTPS via the existing fetch utility, one-shot,
   no runtime network path added anywhere else); parse → requirement checks →
   canonical encode → write derived path (mkdir -p semantics in-tree) →
   upsert `sources.toml` entry (source + adopted timestamp). With `--sheet`:
   build the would-be effective schema and validate every existing record,
   streaming failures as per-record issues to stderr; refuse vendoring on any
   failure so a red adopt leaves the tree untouched.
3. `verify`: pure-offline walk — for each declaring sheet (or named subset):
   resolution, requirement checks, canonical-bytes check, `$id`↔path, record
   validation against effective schema; warn (stderr, exit 0) when a declaring
   sheet's local schema sets `additionalProperties: false`; exit 67 on any
   hard failure. This is the command CI adds.
4. `test`: load the target document (file path, or vendored name), validate
   the sheet's records against **that document alone** (not the effective
   schema) — rung 2 exactly; per-record conformance report; exit 67 on
   failure.
5. `sync`: for each `sources.toml` entry (or named subset), re-fetch and
   byte-compare against vendored; report match/drift; missing source entry →
   listed as unsyncable, not an error. Never writes.
6. `export`: canonical TOML → interchange JSON (stable key order from the
   canonical form), stdout.
7. `prune`: diff vendored documents against the union of all sheets'
   `implements`; `--dry-run` lists; removal requires confirmation.
8. Tests: end-to-end fixture repo exercising adopt (both source forms, JSON
   and TOML input, refusal on non-conforming existing records), verify (each
   failure class + the closed-local warning), test against a
   contract-unaware sheet (duck-typing path), sync drift detection, export
   round-trip (export → adopt yields byte-identical vendored file), prune.

## Validation

- [x] `adopt` of the same document from JSON-over-HTTPS and a local TOML file
      produces byte-identical vendored files and records both sources
- [x] `adopt --sheet` against a sheet with a non-conforming existing record
      refuses, streams the per-record issues, and leaves the tree untouched
- [x] `verify` passes on a conforming fixture repo, fails (exit 67) on each
      seeded defect class, and warns on a closed local schema without failing
- [x] `contracts test` passes against a contract-unaware sheet whose records
      conform, and reports per-record issues against one whose records don't
- [x] `sync` reports drift when the upstream fixture changes and never
      modifies the vendored file
- [x] `export <name> | contracts adopt -` round-trips to identical bytes
- [x] `prune --dry-run` lists exactly the undeclared vendored documents

## Risks / unknowns

- **HTTPS fetch surface** — the CLI gains its first network-touching command;
  keep it one-shot in `adopt`/`sync` only, with no proxy of it into the
  library runtime path. Timeout + clear error on failure.
- **`sources.toml` merge conflicts** — two branches adopting different
  contracts both touch the sidecar; entries are per-name tables so conflicts
  are rare and mechanical, but document the resolution (union) in the file's
  header comment.
- **`gitsheets-axi` parity** — agents will want `contracts verify`/`test`
  through the axi surface; deliberately a follow-up so this plan stays
  bounded.

## Notes

- Built two new thin `gitsheets-core`/`gitsheets-napi` surfaces rather than
  re-implementing their logic host-side, per the plan's "reuse, not reinvent"
  building blocks: `contract::check_contract_document` (a new pub wrapper
  around the existing private `check_document_requirements` +
  `reject_unknown_keywords`, for a not-yet-vendored candidate) and a
  `contractLoad` napi binding surfacing `load_contract` end-to-end
  (byte-canonical + document-requirement + `$id`↔path, exactly what `verify`
  needs). Also added `CoreTransaction.deleteFile` (napi + JS) — `writeFile`'s
  inverse, needed for `prune` — via `MutableTree::delete_child_deep`.
- `checkContractDocument`'s napi signature is `Either<String, JsValue> +
  format` (mirroring `canonicalContractHash`), not a plain `JsValue`: a
  JSON-text input is parsed via `serde_json::from_str` directly, preserving a
  literal `null`. Routing through the `JsValue`/core-`Value` marshalling
  boundary would silently drop null-valued keys (the documented type-fidelity
  rule), making the "no null-bearing keywords" document requirement
  unreachable for exactly the JSON-sourced input it exists to catch. Caught by
  reasoning through the marshalling contract, not by a failing test — worth
  flagging as a general hazard for any future napi surface that needs to see
  a real JSON `null`.
- The effective-schema `allOf` array (contracts + local schema) is assembled
  host-side in TS, not in the core — it's the one documented, mechanical
  formula (specs/behaviors/contracts.md "Composition and enforcement") that
  doesn't need a dedicated core entry point, since it's just an array literal
  handed to the already-exposed `validateBatch`.
- `prune` gained a `--yes` flag (not in the original spec text) to skip the
  removal confirmation prompt non-interactively/in scripts and tests — the
  spec says "needs confirmation" without dictating the mechanism, so this
  isn't a spec amendment, just a filled-in gap.
- The plan's Risks note ("document the resolution (union) in the file's
  header comment" for `sources.toml`) isn't honored as a literal file
  comment: the canonical TOML encoder strips comments on every rewrite, same
  as every other config file this CLI rewrites (`init`/`infer`/
  `migrate-config`). Documented as a source comment in `contracts.ts` instead.
- Test coverage: `packages/gitsheets/src/cli/cli-contracts.test.ts` (17
  tests) covers every Validation bullet above. The HTTPS leg of `adopt`/`sync`
  is exercised with `fetch` mocked (`vi.stubGlobal`) rather than a real
  network call, per this plan's Risks note allowing a "unit seam" fallback —
  `readSource`'s URL branch (timeout, non-2xx handling) is exercised through
  the full CLI path, just with the network substituted.

## Follow-ups

- **`gitsheets-axi` parity** (deliberately out of scope here, per Risks):
  agents will want `contracts verify`/`test` surfaced through the axi
  interface. Needs its own plan.
- **`sources.toml` merge-conflict resolution is undocumented in-repo** beyond
  a source comment — if this becomes a real pain point, consider a
  `--merge-sources` flag or a dedicated `contracts sources` subcommand rather
  than relying on git's default table-level merge behavior.
- No dedicated `rust/gitsheets-napi/test/contracts.mjs` boundary tests were
  added for the four new napi functions (`validateContractName`,
  `contractPath`, `checkContractDocument`, `contractLoad`) or
  `CoreTransaction.deleteFile` — they're exercised indirectly through the
  full CLI test suite (which passed, including the `check_contract_document`
  null-preservation behavior via the JSON-adopt tests) and through
  `gitsheets-core`'s own unit tests, but a future pass could add direct
  boundary coverage matching the existing `contracts.mjs` style.
