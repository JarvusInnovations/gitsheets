---
status: done
depends: []
specs:
  - specs/rust-core.md
  - specs/behaviors/aggregation.md
  - specs/behaviors/path-templates.md
  - specs/behaviors/normalization.md
  - specs/api/errors.md
  - specs/api/python-binding.md
issues: [362]
pr: 372
---

# Plan: deterministic realm for path-template and comparator snippets

## Scope

[#354](https://github.com/JarvusInnovations/gitsheets/issues/354) made the
aggregate realm deterministic (`Engine::new_limited`: pinned UTC host hooks,
a clock fixed at the epoch, and a bootstrap that denies `Math.random`,
`Date.now`, and argument-less `Date`). `Engine::new` — the realm for
path-template expression components and raw-JS sort comparators — still had
the clock, randomness, and the host time zone, and both decide committed
bytes. [#362](https://github.com/JarvusInnovations/gitsheets/issues/362)
closes that gap:

- One determinism rule for every definition-embedded snippet, stated once in
  `rust-core.md` § "Determinism rule for definition snippets" and referenced
  from `aggregation.md`, `path-templates.md`, and `normalization.md`.
- `Engine::new` gets the same hooks and deny bootstrap as `new_limited`
  (shared setup; the runtime limits stay aggregate-only).
- The specced error mapping: a path expression's throw is `PathTemplateError`
  (`path_render_failed`) naming the expression; a comparator's throw is
  `ConfigError` (`config_invalid`) naming the field.
- The Node binding's host-side `node:vm` path (exported `Template` →
  `pathForRecord`; `normalizeRecord`'s `buildSorter`) applies the same rule
  for parity while the host-side deferral stands.
- `docs/migration-guide.md` v2.12 → v2.13 entry (behavior change for
  templates/comparators that read host local time).

Out of scope:

- Lifting the host-side deferral (routing the Node `Template` / comparators
  through the core engine).
- Runtime limits (loop / recursion / stack caps) for path expressions and
  comparators — a separate decision; documented in `Engine::new`.
- The bare `${{ dateField }}` rendering wart (core: un-renderable; Node
  `Template`: host `Date#toString()`), which is a field reference, not a
  snippet.

## Implements

- `specs/rust-core.md` — "Determinism rule for definition snippets" (rule,
  violation table, v2.13 behavior change, host-side parity requirement).
- `specs/behaviors/path-templates.md` — "Expression rendering", "Rendering
  semantics" (the `getFullYear()` wart).
- `specs/behaviors/normalization.md` — "Sort rule formats" (inline JS).
- `specs/behaviors/aggregation.md` — purity paragraph now references the
  shared rule.
- `specs/api/errors.md` — `config_invalid` / `path_render_failed` meanings.

## Approach

1. **Core** (`rust/gitsheets-core/src/engine.rs`): factor
   `Engine::deterministic()` (pinned `DeterministicHooks` + `FixedClock` +
   `DENY_NONDETERMINISM`); `new()` = that, `new_limited()` = that + limits.
   Generalize the denial messages to "not available in a gitsheets snippet"
   and deny `toLocale{,Date,Time}String` (boa has no `Intl`; they threw an
   opaque "Function Unimplemented" before). Name the expression in
   `path_template.rs`'s render error and the field in `sheet.rs`'s comparator
   error.
2. **Node** (`packages/gitsheets/src/sandbox.ts`): a `node:vm` realm with the
   same bootstrap plus a shim for what V8 can't pin per context — local-time
   `Date` getters/setters → UTC twins, `getTimezoneOffset` → 0, boa's
   `toString` form, multi-arg constructor and offset-less ISO strings at
   UTC, ISO/`toString`/`toUTCString`-only parsing — and `toRealm`, which
   copies each argument into the realm so a record's host `Date` gets the
   patched prototype. `path-template/index.ts` and `sheet.ts` `buildSorter`
   compile through it and map throws to `PathTemplateError` / `ConfigError`.
3. **Review round 1** (adversarial probe of the shim on #372): close the
   remaining host-zone reads (`setYear`, ToPrimitive in `new Date`, V8's
   parser), make the locale methods locale-free in both realms, copy every
   argument object, move `$pred` / key snippets to a query realm with the
   clock (`Engine::compile_query`), scope the comparator cache per Sheet, and
   build the package in the Python CI job.
4. **Tests**: core unit tests (engine, path template, sheet comparator)
   including `TZ=America/New_York`; a package vitest suite diffing the vm
   realm against the napi core; napi `path-template.mjs` updated (the old
   "getFullYear parity is reported" probe becomes a UTC assertion); a Python
   cross-binding test rendering a `getHours()` template with `TZ` set.

## Validation

- [x] `cargo build --workspace --all-targets`, `cargo test -p gitsheets-core`,
  `cargo clippy --workspace --all-targets -- -D warnings` green
- [x] Core tests: expression and comparator calling `Date.now()` /
  `Math.random()` / `new Date()` fail with the specced error naming the
  expression / field and the call; `getHours()` under
  `TZ=America/New_York` reads UTC; `new Date(ms)` / `Date.UTC` still work
- [x] Node tests mirror the same for the `node:vm` path and match the core
- [x] napi suite green
- [x] `npm run build`, `npm run type-check`, `npm test` green
- [x] Python suite green, including the cross-binding `getHours()` parity test
- [x] Review round 1: the vm realm matches the addon on the hard cases
  (setters incl. `setYear`, two-digit years, a DST-boundary instant,
  `toJSON`/`toISOString`, `String` objects, class-instance records,
  `Intl`/`localeCompare`/`toLocale*`, legacy and malformed date strings)
  under at least two host zones
- [x] Review round 1: `$pred` filters and index key snippets run in a query
  realm with the clock (Python and napi tests), specced in `rust-core.md`
  and `python-binding.md`
- [x] Review round 1: Rust TZ tests run in a child process per zone; the
  `rust-core.yml` Python job builds `packages/gitsheets/dist` so the host
  leg of the cross-binding test runs
- [ ] `rust-core.yml` cross-binding parity gate green on the PR

## Notes

- Verified totals at closeout (develop at 7a9d1af, no newer commits):
  `cargo test -p gitsheets-core` 346 + 4 (5 `#[ignore]`d TZ inner tests run
  through their wrappers, each under America/New_York and Asia/Kolkata),
  clippy `-D warnings` clean, `cargo build --workspace --all-targets` clean;
  release napi build; vitest 610 (gitsheets; 24 in
  `snippet-determinism.test.ts`) + 172 (gitsheets-axi); napi `node --test`
  158; pytest 96 with `TZ=America/New_York` (the cross-binding local-time
  test also passes with `CI=1`, i.e. with the host leg asserted);
  `npm run type-check` clean. No generated napi files changed.
- `rust-core.yml` parity-gate box left unchecked: it runs in CI on the PR
  (now including the host `Template` leg), not verifiable locally.
- **Release ordering:** `gitsheets-core` behavior changed (the realms, the
  query realm, error messages), so per CLAUDE.md a `core-napi-v*` release
  must ship BEFORE the next JS `v*` release, then the manifest sync —
  `publish-npm` runs `snippet-determinism.test.ts` against the published
  platform binaries and would fail on stale ones. PyPI needs a `py-v*` bump.
- **Shim coverage** (`packages/gitsheets/src/sandbox.ts`), each diffed
  against the addon under New York, Kolkata, and UTC: the deny list and
  messages; the global names (V8-only `Intl`, `WebAssembly`, `console`,
  `FinalizationRegistry`, `Iterator`, `escape`, `unescape` removed;
  `SharedArrayBuffer` / `Atomics` removed in both realms); every local-time
  getter and setter incl. Annex B `getYear` / `setYear`; `getTimezoneOffset`;
  `toString` / `toDateString` / `toTimeString`; the multi-argument
  constructor; ToPrimitive in `new Date(x)`; string parsing computed from
  regex captures (never V8's parser); `localeCompare`, `toLocaleUpper/
  LowerCase`, `Number` / `BigInt` / `Array` / typed-array `toLocaleString`;
  argument copying (own enumerable keys, `__proto__` as an own key, holes
  kept). Probed boa first for each behavior and matched it (boa joins
  `Array#toLocaleString` with `', '`, parses ISO fractions only at exactly
  three digits, validates toString-form days per month but accepts any
  weekday name and offset hours up to 99).
- **Known divergences, specced:** boa accepts `T24:01` / `T24:00:00.001Z`
  (the host returns NaN; a boa bug, not mimicked); boa exposes non-standard
  `TypedArray` and `Float16Array` globals the host lacks.
- **Predicate-realm decision:** `$pred` filters and index key snippets are
  query-time snippets, never committed, so they run in a nested query realm
  (`Engine::compile_query`): UTC offset pinned, real clock, no deny
  bootstrap, separate globals so nothing leaks to definition snippets. This
  restores `{"$pred": "value < Date.now()"}`, which the first round had
  turned into a `config_invalid` error.
- Runtime limits deliberately not applied to `Engine::new` (long-lived
  sheet engine); they stay the aggregate realm's guarantee.
- A comparator that does not compile is `config_invalid` naming the field.
  In practice the core reports it when the Node sheet's config is checked,
  so the host `normalizeRecord` wrap is a fallback.
- `Template.fromString`'s process-wide cache (pre-existing) still shares one
  realm per expression across repositories; only the comparator cache was
  scoped per Sheet. #373 removes the host realm altogether.
- Verified that `git sheet normalize` renames a record whose rendered path
  changed (scratch repo: `people/{jane.toml => x-jane.toml}`); the spec and
  the migration guide say so.

## Follow-ups

- Tracked as: [#373](https://github.com/JarvusInnovations/gitsheets/issues/373) —
  route the Node `Template` and `normalizeRecord` comparators through the
  core engine and delete the `node:vm` shim.
