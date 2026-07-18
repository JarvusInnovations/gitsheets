---
status: done
depends: []
specs:
  - specs/behaviors/contracts.md
  - specs/behaviors/validation.md
  - specs/api/errors.md
issues: []
pr: 265
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

- [x] A sheet declaring a vendored contract rejects a non-conforming write with
      `ValidationError` whose issue names the contract; a conforming write with
      extra local fields succeeds
- [x] `implements` naming an absent contract fails sheet-open with
      `ContractError('contract_missing')`
- [x] Each document-requirement violation (bad `$id`, external `$ref`,
      `additionalProperties: false`, null-bearing keyword, non-canonical bytes,
      unknown keyword) fails with `ContractError('contract_invalid')` and a
      message naming the rule
- [x] Two sheets declaring the same name compose the same single vendored
      document
- [x] `canonical_contract_hash` yields identical hashes for the same document
      supplied as JSON text, TOML text, and parsed data — in both Node and
      Python
- [x] Existing validation/normalization test suites pass unchanged (sheets with
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

- **Composition is a literal `allOf` wrapper, compiled once.** The effective
  schema is `{"allOf": [contract1_json, …, contractN_json,
  local_json_or_{}]}`, built via a new `CompiledSchema::compile_composed`
  alongside the existing `CompiledSchema::compile`. A sheet with no
  `implements` still compiles the bare `[gitsheet.schema]` with no wrapper at
  all — this is what makes "zero regression" exact rather than approximate:
  `schema_path` strings for a non-contract sheet never gain an `/allOf/N`
  prefix that didn't exist before this plan.
- **`ValidationIssue.contract` attribution is schema-path parsing, not a
  second validation pass.** `CompiledSchema` carries the declared contract
  names in `allOf` order; a failing issue's `jsonschema`-reported `schema_path`
  (e.g. `/allOf/0/properties/slug/pattern`) is parsed for a leading
  `/allOf/<i>` and mapped back to the name at that index. Index == the local
  schema's position (always last) → `None`.
- **Per-contract strict-mode (unknown-keyword) checking happens at
  `load_contract` time, per contract — not once on the composed tree.**
  Otherwise an unknown keyword inside a contract branch would surface as a
  generic `ConfigError` rather than `ContractError` naming that contract. The
  local schema's own strict-mode check is unchanged (still `ConfigError`).
  The unknown-keyword walker (`reject_unknown_keywords`) was refactored into a
  generic `walk_schema(schema, visit)` so the contract document-requirement
  checks (self-containment / openness / null-bearing keywords) reuse its exact
  descent rules instead of duplicating the "never misread a data position as a
  keyword" logic.
- **`canonical_contract_hash`'s JSON-text input path is the first place raw
  JSON (with real `null`) enters the core directly**, via a new `json_to_value`
  in `contract.rs`. It applies the identical null-handling contract every
  binding's host→core marshal already applies (drop a null-valued table key
  recursively; reject a null array element or a null value itself), reusing
  the existing `null_array_element_msg`/`null_value_msg` diagnostic helpers.
  Consequence: `const: null` / `enum` containing `null` / `default: null` can
  never actually occur in a document loaded from the **committed vendored
  TOML** path (TOML has no null, so `Value` has no null variant) — only
  `type: 'null'` (a string) is reachable that way. The null-bearing-keyword
  checker (`check_no_null_bearing_keywords`) is still written to catch all
  four forms because it operates on the generic `serde_json::Value` the same
  document-requirement checks would run against once the (out-of-scope) CLI
  `adopt` path feeds raw JSON text in directly; the plan's own tests exercise
  those three unreachable-via-TOML forms by constructing `serde_json::Value`
  fixtures directly, bypassing TOML entirely.
- **No `Sheet::open` / binding signature changes.** Contract resolution reuses
  the `open_root` parameter already threaded through every caller; `implements`
  is just another field the existing config parse discovers. Every binding
  change is additive (a new `ContractError` class + `contract` payload field +
  one new function), which is why zero existing napi/py/JS tests needed
  updates beyond the new coverage.
- **Bindings needed almost no per-class plumbing.** Both napi's
  `throw_structured_error` and Python's `raise_core_error` are already generic
  over `err.class().as_str()`/`err.code()`; adding `ContractError` was one
  match arm plus threading the new `contract`/`issue.contract` fields through
  the existing marshalling — no new dispatch machinery.
- Test evidence (full detail in the PR body): `cargo test -p gitsheets-core`
  222 passed + 4 corpus-parity; `cargo clippy --workspace --all-targets -- -D
  warnings` clean; napi `npm test` 119 passed (114 pre-existing + 5 new);
  Python `pytest` 42 passed; `npm test --workspaces --if-present` at repo root
  (gitsheets 364, gitsheets-axi 118, gitsheets-napi 119) all green.

## Follow-ups

- Issue [#266](https://github.com/JarvusInnovations/gitsheets/issues/266) —
  cache the compiled contract JSON by blob OID across sheet-opens (the plan's
  own "Canonical-bytes check cost" risk — a performance optimization, not a
  correctness gap; today every `Sheet::open` re-parses/re-canonicalizes/
  re-checks every declared contract from scratch).
