---
status: done
depends: []
specs:
  - specs/behaviors/default-branch.md
  - specs/api/repository.md
  - specs/api/cli.md
  - specs/api/axi.md
issues: [361]
pr: 371
---

# Plan: explicit opt-out of an inherited branch or submodule binding

## Scope

Submodule mode resolves `openRepo({ submodule })` → `GITSHEETS_SUBMODULE` →
`gitsheets.submodule` git config, and branch mode the same with
`GITSHEETS_BRANCH` / `gitsheets.branch`. Code that wants the superproject
itself (or `HEAD`'s branch) has no way to say so: an exported env var or a
global config silently redirects `openRepo()`, `git sheet`, and
`gitsheets-axi`. Add an explicit opt-out for both knobs, in the library and
in both CLIs (#361).

Out of scope: `stagePointer` (`false` already overrides env and config) and
`at` (a per-invocation pin the library never reads from env or config).

## Implements

- [behaviors/default-branch.md](../specs/behaviors/default-branch.md) —
  Resolution: the `null` opt-out row, "Explicit opt-out", "An empty value
  is unset", "`stagePointer` and `at` need no `null`"; CLI: `--no-branch` /
  `--no-submodule`, last-of-pair wins.
- [api/repository.md](../specs/api/repository.md) — `branch` /
  `submodule` typed `string | null`; "`null` opts out".
- [api/cli.md](../specs/api/cli.md) — global flags `--no-branch` /
  `--no-submodule`; `submodule init` treats `--no-branch` as no `--branch`.
- [api/axi.md](../specs/api/axi.md) — global flags `--no-branch` /
  `--no-submodule`, any position, no value.

## Approach

1. **Library** (`packages/gitsheets/src/repository.ts`,
   `packages/gitsheets/src/submodule.ts`): `OpenRepoOptions.branch` /
   `.submodule` become `string | null`. `resolveSubmodulePath` returns
   `null` (no submodule) for an explicit `null` before reading env or
   config; `resolveDefaultBranch` skips straight to `HEAD`'s branch.
2. **`git sheet`** (`cli/index.ts`, `cli/shared.ts`): yargs' boolean
   negation already parses `--no-submodule` / `--no-branch` on the string
   options as `false`, and a command-line value beats yargs' env folding.
   A coerce keeps the last of repeated/paired flags; `repoOptions` maps
   `false` → `null`. `submodule init` treats `--no-branch` as unset.
3. **`gitsheets-axi`** (`packages/gitsheets-axi/src/context.ts`):
   `parseGlobalFlags` recognizes `--no-branch` / `--no-submodule` in any
   position (rejecting `=value`) and sets the field to `null`, which
   `createContext` passes through to `openRepo`.
4. Docs: `docs/cli.md`, `docs/axi.md`, `docs/recipes/headless-data.md`,
   `skills/gitsheets/references/cli.md` / `axi.md`; CLI `--help` text.

## Validation

- [x] `openRepo({ submodule: null })` with `GITSHEETS_SUBMODULE` exported
      opens the superproject; with global `gitsheets.submodule` set, too.
- [x] `openRepo({ branch: null })` with a global `gitsheets.branch` (and
      with `GITSHEETS_BRANCH`) binds to `HEAD`'s branch.
- [x] Omitted options still resolve env → config (existing suites pass).
- [x] `GITSHEETS_SUBMODULE=data git sheet --no-submodule query users`
      reads the superproject; `--no-branch` likewise ignores
      `GITSHEETS_BRANCH`.
- [x] `gitsheets-axi` honors `--no-submodule` / `--no-branch` before and
      after the command name; `--no-submodule=x` is `VALIDATION_ERROR`.
- [x] An empty `GITSHEETS_SUBMODULE=` still falls through to git config.
- [x] `npm run build`, `npm run type-check`, `npm test` green.

## Risks / unknowns

- yargs collects a flag given twice (`--submodule x --no-submodule`) into
  an array; the coerce must reduce it to the last value.

## Notes

- **Empty env stays unset.** `GITSHEETS_SUBMODULE=` / `GITSHEETS_BRANCH=`
  fall through to git config, as before. An empty variable is how shells,
  CI templates, and env files spell "nothing here"
  (`GITSHEETS_SUBMODULE=${DATA_SUBMODULE:-}`), so giving it a meaning would
  turn an unfilled template into a silent rebind. The opt-out is the flag
  or `null`, which say it on purpose.
- An empty **config** value was already "unset at its tier", which gives a
  clone-level opt-out for free: `git config gitsheets.submodule ""` in the
  local config shadows a global one. Specced and tested; no code change.
- yargs' default boolean negation already parses `--no-submodule` on a
  `type: 'string'` option as `false`, and a command-line value beats its env
  folding, so no extra option was needed. A flag given twice arrives as an
  array; a `coerce` keeps the last value (also fixes `--submodule a
  --submodule b`, which previously passed an array through).
- `submodule init` reads the global `--branch`; it now treats `false`
  (`--no-branch`) as unset instead of crashing on `false.replace`.
- The global-config tests point `GIT_CONFIG_GLOBAL` at a scratch file;
  `gitExec` does not scrub it, matching git's own layering.
- The axi `bulk-patch` "large batch commits once" test timed out in the full
  run under load (~31) and passed alone — the known flake.

## Follow-ups

None.
