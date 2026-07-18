---
status: planned
depends: []
specs:
  - specs/behaviors/contracts.md
  - specs/behaviors/validation.md
  - specs/api/errors.md
issues: []
---

# Plan: contracts core — declaration, vendored store, composed enforcement

## Scope

The core mechanics of schema contracts in the Rust engine, surfaced through every
binding: the `implements` config key, the derived-path vendored contract store
under `.gitsheets/contracts/`, contract-document requirement checks at compile,
and `allOf` composition of declared contracts into write-time validation.

In scope:

- `implements` parsing/validation in sheet config
- Contract name rules + name→path derivation (reusing path-segment character
  validation)
- Loading vendored contracts from the committed tree; canonical-bytes and
  `$id`↔path consistency checks
- Effective-schema composition (`allOf: [contracts…, local]`) in the existing
  validation pipeline; contract attribution on `ValidationIssue`
- `ContractError` (`contract_missing`, `contract_invalid`) across bindings
- Canonical hashing of a contract document supplied as data or JSON/TOML text
  (the identity primitive `contracts-cli` and `contracts-consumer-verify` both
  build on)

Out of scope: all CLI commands and the sources sidecar
([`contracts-cli`](contracts-cli.md)); consumer verification
([`contracts-consumer-verify`](contracts-consumer-verify.md)); everything in
`specs/deferred.md`'s contract entries (source shorthand, registry, `$ref`
closure, sheet-level assertions).

## Implements

- `specs/behaviors/contracts.md` — Concepts, names/derived path, document
  requirements, canonical form, `implements` declaration, composition and
  enforcement, the `contract_missing`/`contract_invalid` failure rows
- `specs/behaviors/validation.md` — the amended layer-1 rule (effective schema
  is `allOf` of contracts + local schema; issues name the contract)
- `specs/api/errors.md` — `ContractError` class, `contract_missing` /
  `contract_invalid` codes, `ValidationIssue.contract`

## Approach

1. Core: extend sheet-config parsing with `implements: Vec<String>`; validate
   name rules (host-qualified, ≥1 `/`, path-segment character rules, no `.`/`..`,
   no trailing slash). Reject invalid names as `ConfigError('config_invalid')`
   (it's a config defect, not a contract defect).
2. Core: contract loader — resolve each name to
   `.gitsheets/contracts/<name>.toml` in the committed tree; absent →
   `ContractError('contract_missing')`. Parse; enforce document requirements
   (strict Draft-07 compile, `$id == 'https://' + name`, self-contained, open,
   no null-bearing keywords, bytes are canonical — re-encode and compare) →
   `ContractError('contract_invalid')` naming the violated rule.
3. Core: build the effective schema per sheet as `allOf` of the N compiled
   contracts + `[gitsheet.schema]`, compiled once and cached alongside the
   existing per-sheet compiled schema. Tag validation issues that originate in
   a contract branch with the contract name (`ValidationIssue.contract`).
4. Core: expose `canonical_contract_hash(document)` — parse (JSON or TOML) →
   canonical TOML encode → SHA-256 — as the shared identity primitive.
5. Bindings: surface `ContractError` in Node and Python error marshalling with
   stable codes; no new binding API beyond the error type (enforcement rides
   the existing write path).
6. Tests: name-rule table tests; each document-requirement rejection; deep +
   root-level composition (contract-required field missing, contract + local
   both failing, defaults from contract applying); multi-contract composition;
   canonical-hash equality across JSON and TOML input of the same document;
   cross-binding parity test that Node and Python compute identical hashes and
   enforce identically (extend the existing parity suite).

## Validation

- [ ] A sheet declaring a vendored contract rejects a non-conforming write with
      `ValidationError` whose issue names the contract; a conforming write with
      extra local fields succeeds
- [ ] `implements` naming an absent contract fails sheet-open with
      `ContractError('contract_missing')`
- [ ] Each document-requirement violation (bad `$id`, external `$ref`,
      `additionalProperties: false`, null-bearing keyword, non-canonical bytes,
      unknown keyword) fails with `ContractError('contract_invalid')` and a
      message naming the rule
- [ ] Two sheets declaring the same name compose the same single vendored
      document
- [ ] `canonical_contract_hash` yields identical hashes for the same document
      supplied as JSON text, TOML text, and parsed data — in both Node and
      Python
- [ ] Existing validation/normalization test suites pass unchanged (sheets with
      no `implements` are byte-for-byte unaffected)

## Risks / unknowns

- **Draft-07 `$id` handling in the `jsonschema` crate** — the crate may attempt
  reference resolution against `$id` base URIs. Contracts are self-contained,
  so resolution should never leave the document; verify no network/filesystem
  resolver is reachable and disable external resolution outright.
- **Canonical-bytes check cost** — re-encoding each vendored contract at
  sheet-open to verify canonicality is O(contract size); fine at realistic
  sizes, but cache by blob OID so repeated opens don't re-check.
- **Openness detection depth** — `additionalProperties: false` must be rejected
  at any nesting level, including inside `definitions`/`items`/`allOf`
  branches. Needs a full-document walk, not a top-level check.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
