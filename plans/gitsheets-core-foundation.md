---
status: planned
depends: [holo-tree-migration]
specs:
  - specs/rust-core.md
issues: [127]
---

# Plan: gitsheets-core foundation — the crate, the value type, the boundary

## Scope

Stand up the Rust core and its FFI boundary so later plans have somewhere to land
engine logic. **In:** a `gitsheets-core` crate, the TOML-faithful **core value
type**, the typed-error surface, and a `gitsheets-napi` binding skeleton that
marshals records between JS and the core with full type fidelity. **Out:** any
actual engine behavior (TOML, normalization, validation, query, Sheet) — those
are downstream plans; this is the substrate they build on.

## Implements

- [`specs/rust-core.md`](../specs/rust-core.md) — "The FFI boundary" (typed core
  value, not JSON; batch APIs) and the `gitsheets-core` / thin-binding split. This
  plan delivers the *boundary*, not the engine on either side of it.

## Approach

- **Workspace.** Add a Rust workspace to the gitsheets repo (e.g. `rust/` with
  `gitsheets-core` + `gitsheets-napi` members). `gitsheets-core` depends on
  `holo-tree` — via a Cargo git dependency on hologit, or holo-tree published to
  crates.io (decide here; git dep is fine to start).
- **Core value type.** A `Value` enum that preserves TOML's type set —
  string, integer, float, bool, **datetime**, array, table — so nothing is lost
  crossing the boundary (JSON would flatten datetimes to strings and blur
  int/float). This is the lingua franca every later plan speaks.
- **Marshalling (napi).** `Value` ↔ JS object with fidelity rules: TOML datetime
  ↔ JS `Date`, integer ↔ number (bigint above 2^53?), float ↔ number, table ↔
  plain object. Round-trip tests are the contract.
- **Errors.** A `core::Error` enum with stable, matchable variants (the
  [findings doc](../notes/holo-tree-findings.md) flagged that holo-tree errors
  flatten to strings across FFI — don't repeat that). The binding maps variants
  to gitsheets' typed error classes ([`specs/api/errors.md`](../specs/api/errors.md)).
- **Batch-first signatures.** Even the skeleton APIs take/return arrays, so bulk
  paths never bake in per-record FFI crossings.

## Validation

- [ ] `gitsheets-core` + `gitsheets-napi` build; the napi addon loads in Node.
- [ ] A record round-trips JS → `Value` → JS preserving types: a `Date` stays a
      `Date`, an integer stays integral, a float stays a float, nested tables
      survive.
- [ ] A core error surfaces in JS as a structured, matchable cause (not an opaque
      string), and the binding maps it to the right typed error class.
- [ ] A batch (array) crosses the boundary in a single call.

## Risks / unknowns

- **holo-tree dependency form.** Git dep vs crates.io publish for holo-tree —
  affects reproducibility and the gitsheets build. Decide early.
- **Integer width.** TOML allows 64-bit integers; JS numbers lose precision above
  2^53. Decide bigint vs number per-field or globally (consumers' IDs may be large).
- **`Date` fidelity.** TOML local-vs-offset datetimes vs JS `Date` (always UTC
  instant). The current JS stack preserves `@iarna` `Date`; match that semantics.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
