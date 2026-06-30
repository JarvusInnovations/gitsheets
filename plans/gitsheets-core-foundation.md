---
status: done
depends: [holo-tree-migration]
specs:
  - specs/rust-core.md
issues: [127]
pr: https://github.com/JarvusInnovations/gitsheets/pull/204
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

- [x] `gitsheets-core` + `gitsheets-napi` build; the napi addon loads in Node.
      (`cargo build --workspace` clean; `cargo test -p gitsheets-core` → 8
      passed; `node -e "require('./binding.cjs')"` loads, `roundtrip` is a fn.)
- [x] A record round-trips JS → `Value` → JS preserving types: a `Date` stays a
      `Date`, a small integer stays an integral `number`, an integer above 2^53
      stays a `BigInt` with the exact value, a float stays a float, nested
      tables survive. (`test/roundtrip.mjs`.)
- [x] A core error surfaces in JS as a structured, matchable cause — asserted on
      `err.code`/class, not a substring — and the binding maps each variant to
      the right typed `GitsheetsError` subclass. (`test/errors.mjs`.)
- [x] A batch (array) crosses the boundary in a single call. (`roundtrip`
      takes/returns `Vec`; `test/roundtrip.mjs` "a batch of records crosses…".)
- [x] The existing JS suite stays green and independent: root `npm run build`
      then `npm test` → 287 + 66 passed; `npm run type-check` clean. The main
      build does not depend on the `.node` addon; Rust CI is its own
      `rust-core.yml` (triggered only on `rust/**`). `node --test` boundary
      suites → 16 passed.

## Risks / unknowns

- **holo-tree dependency form.** Git dep vs crates.io publish for holo-tree —
  affects reproducibility and the gitsheets build. Decide early.
- **Integer width.** TOML allows 64-bit integers; JS numbers lose precision above
  2^53. Decide bigint vs number per-field or globally (consumers' IDs may be large).
- **`Date` fidelity.** TOML local-vs-offset datetimes vs JS `Date` (always UTC
  instant). The current JS stack preserves `@iarna` `Date`; match that semantics.

## Notes

**What got built.** A Cargo workspace at `rust/` with two members
([PR #204](https://github.com/JarvusInnovations/gitsheets/pull/204)):

- `gitsheets-core` (lib) — the pure-Rust core. `Value` (`src/value.rs`)
  preserves TOML's full type set: string, `i64` integer, `f64` float, bool, the
  **four distinct datetime kinds** (backed by `toml::value::Datetime` so they
  re-serialize byte-faithfully), array, and an order-preserving `IndexMap`
  table. Integer-vs-float and the four datetime kinds never collapse — they
  determine on-disk bytes. `Error` (`src/error.rs`) is a stable, matchable enum
  with one variant per `errors.md` code-table row, each exposing `code()`,
  `class()`, `status()`, and payloads (`ValidationIssue`, conflicting paths).
  Batch-first skeleton: `echo_batch`, `example_error`.
- `gitsheets-napi` (napi-rs binding) — manual `FromNapiValue`/`ToNapiValue` on a
  `JsValue` newtype implements the locked type-fidelity rules (adaptive
  integer↔`number`/`BigInt`, float↔`f64`, the four datetime kinds↔JS `Date`,
  table↔plain object with order preserved). Errors are thrown as **structured**
  JS `Error` objects (own `code`/`status`/`gitsheetsClass` + `issues`/
  `conflictingPaths`); the thin `binding.cjs` wrapper maps each onto its typed
  `GitsheetsError` subclass — answering `notes/holo-tree-findings.md` §4 (no
  opaque-string flattening across FFI). A dedicated `rust-core.yml` CI workflow
  builds + tests the boundary on `rust/**` PRs, separate from the JS `ci.yml`.

**holo-tree dependency form (decided, deferred to first use).** The chosen form
is a **Cargo git dependency** on the hologit repo (the existing JS substrate
ships holo-tree as `@hologit/holo-tree`; the Rust crate is consumed by git dep
until/unless it is published to crates.io). This foundation does **no** tree ops,
so the dependency is intentionally **not** added yet — per the plan's "don't add
an unexercised dependency" guidance. It gets wired when the first downstream plan
(the bytes-authority core: TOML serialize + normalization + tree writes) needs
tree operations.

**Datetime projection caveat.** A JS `Date` is an absolute instant, so inbound
Dates become offset-datetime (UTC `Z`) core values — matching `@iarna` v1.x. The
four kinds are all distinguishable core-side and surface as `Date`; local kinds
populated later by the TOML parser are projected to a UTC instant for the `Date`
surface while retaining their precise kind for re-serialization (the documented
least-lossy idiomatic surface).

## Follow-ups

- **Deferred to plan (bytes-authority core):** wire the holo-tree Cargo git dep
  and move TOML parse/serialize + normalization into `gitsheets-core`; that plan
  exercises faithful re-serialization of all four datetime kinds (only
  offset-datetime is exercised end-to-end here, via JS `Date`).
- **Issue (cosmetic):** napi-rs emits `Array<JsValue>` in the generated
  `index.d.ts` for the custom-marshalled type (`JsValue` is undefined in TS).
  Harmless — the binding's public surface is `binding.cjs`, and this crate is not
  in the npm workspace nor type-checked by the main build. Revisit if/when the
  binding is re-thinned and published with hand-authored types.
- **None** otherwise — engine behavior (validation, query, Sheet/Transaction)
  is out of scope by design and lives in downstream plans.
