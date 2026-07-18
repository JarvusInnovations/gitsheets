---
status: planned
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

- [ ] `adopt` of the same document from JSON-over-HTTPS and a local TOML file
      produces byte-identical vendored files and records both sources
- [ ] `adopt --sheet` against a sheet with a non-conforming existing record
      refuses, streams the per-record issues, and leaves the tree untouched
- [ ] `verify` passes on a conforming fixture repo, fails (exit 67) on each
      seeded defect class, and warns on a closed local schema without failing
- [ ] `contracts test` passes against a contract-unaware sheet whose records
      conform, and reports per-record issues against one whose records don't
- [ ] `sync` reports drift when the upstream fixture changes and never
      modifies the vendored file
- [ ] `export <name> | contracts adopt -` round-trips to identical bytes
- [ ] `prune --dry-run` lists exactly the undeclared vendored documents

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

(populated at closeout)

## Follow-ups

(populated at closeout)
