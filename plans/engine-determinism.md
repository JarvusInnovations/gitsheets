---
status: in-progress
depends: []
specs:
  - specs/rust-core.md
  - specs/behaviors/aggregation.md
  - specs/behaviors/path-templates.md
  - specs/behaviors/normalization.md
  - specs/api/errors.md
issues: [362]
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
3. **Tests**: core unit tests (engine, path template, sheet comparator)
   including `TZ=America/New_York`; a package vitest suite diffing the vm
   realm against the napi core; napi `path-template.mjs` updated (the old
   "getFullYear parity is reported" probe becomes a UTC assertion); a Python
   cross-binding test rendering a `getHours()` template with `TZ` set.

## Validation

- [ ] `cargo build --workspace --all-targets`, `cargo test -p gitsheets-core`,
  `cargo clippy --workspace --all-targets -- -D warnings` green
- [ ] Core tests: expression and comparator calling `Date.now()` /
  `Math.random()` / `new Date()` fail with the specced error naming the
  expression / field and the call; `getHours()` under
  `TZ=America/New_York` reads UTC; `new Date(ms)` / `Date.UTC` still work
- [ ] Node tests mirror the same for the `node:vm` path and match the core
- [ ] napi suite green
- [ ] `npm run build`, `npm run type-check`, `npm test` green
- [ ] Python suite green, including the cross-binding `getHours()` parity test
- [ ] `rust-core.yml` cross-binding parity gate green on the PR
