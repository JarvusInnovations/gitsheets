---
status: in-progress
depends: []
specs:
  - specs/api/cli.md
  - specs/principles.md
  - specs/behaviors/default-branch.md
issues: [352]
---

# Plan: CLI `--ref` reads, rollup binding flags, `--stage-pointer` / `--at`, exit codes

## Scope

Close the CLI gaps a post-v2.12.0 spec-drift audit found:

1. `--ref` is ignored on reads (#352): `query`, `read`, `aggregate`,
   `normalize`, `check`, and the read side of `upsert --delete-missing` /
   `--patch`, `edit`, `infer` read the default branch whatever `--ref` says.
2. `git sheet rollup` ignores `--branch` / `--submodule` (it calls bare
   `openRepo({ gitDir })`).
3. `openRepo({ stagePointer })` and `openRepo({ at })` have no CLI twin,
   against the first-party-git-extension principle. Add `--stage-pointer`
   (setting: flag → `GITSHEETS_STAGE_POINTER` → `gitsheets.stagePointer`)
   and `--at` (per-invocation pin: flag → `GITSHEETS_AT`) to `git sheet` and
   `gitsheets-axi`; the library resolves the `stagePointer` env and config
   tiers itself so the CLI and the application agree in one clone.
4. Malformed `--agg` / `--trailer` / `--attachment` / `--filter` values (and
   invalid flag combinations) exit 1 instead of the specced 2;
   `AggregationError` has no exit code row.
5. `merge --into` help text says "HEAD's branch" instead of the default
   branch.
6. Found while specifying `specs/api/axi.md` (#369): `docs/axi.md` has
   drifted from the code (a nonexistent `--format=json` opt-out,
   `VALIDATION_FAILED` named as the usage-error code, an incomplete
   error-code list, missing `count` / `distinct` / `rename` / `contracts`);
   `gitsheets-axi check --help` lists exit codes 22 / 64 it never uses; a
   malformed axi global flag exits 1 with a bare `error:` line instead of
   `VALIDATION_ERROR` / exit 2; `Repository.writeBlob` and
   `Sheet.rollupStatus` still carry `@internal` though the specs make them
   public. Also link `cli.md`'s `rollup --check` / `--attachment` to those
   APIs, and state `TransactionResult.ref === 'HEAD'` after a detached
   advance in `default-branch.md`.

Out of scope: a `gitsheets.root` / `gitsheets.prefix` config tier
(grandfathered in `specs/principles.md`); `--working` (#165, deferred);
`specs/api/repository.md`'s `openRepo({ stagePointer })` default wording
(owned elsewhere — follow-up cross-reference).

## Implements

- `specs/api/cli.md` — "Global flags" (`--stage-pointer`, `--at`, `--ref`
  semantics for reads and read-then-commit commands, every global flag on
  every command), "Exit codes" (2 for argument errors, 23
  `AggregationError`), "Error output".
- `specs/behaviors/default-branch.md` — `stagePointer` resolution, `at`
  from the CLI, § CLI (flags table, axi flags), submodule path
  normalization, `submodule init` edge cases (documented as implemented).
- `specs/principles.md` — settings vs per-invocation pins vs per-call
  options; grandfathered knobs.

## Approach

1. **`--ref` reads.** `loadRepoAndSheet` passes `ref: argv.ref` to
   `openSheet` whenever `--ref` is set. Every command that uses it only reads
   through that sheet and writes through `repo.transact` + `tx.sheet`, whose
   parent is already `--ref` (`buildTxOpts`), so read and commit see the same
   ref. `runRollup` opens through `openCliRepo` and pins both paths at
   `--ref`. `readRef` (config commands) falls back to the `--at` pinned
   commit before the default branch.
2. **`--stage-pointer`.** Library: `resolveStagePointer(superGitDir,
   explicit)` in `src/submodule.ts` — explicit → `GITSHEETS_STAGE_POINTER`
   (git boolean spellings; invalid → `ConfigError(config_invalid)`) →
   `git config --type=bool gitsheets.stagePointer` of the superproject → false,
   used only in `#openSubmodule`. CLI: a boolean global flag; a middleware
   drops yargs' env-derived value (yargs reads only `"true"` as true) so the
   env tier is the library's. `openCliRepo` passes it when given on the
   command line.
3. **`--at`.** CLI string global (`GITSHEETS_AT` via yargs `.env`), passed
   as `openRepo({ at })`; `openCliRepo` rewrites `openRepo({ at })` error
   prefixes to `--at / GITSHEETS_AT`. Axi: `parseGlobalFlags` learns
   `--at` / `--at=` / `--stage-pointer` / `--no-stage-pointer` (any
   position); `createContext` passes them, reading `GITSHEETS_AT` when the
   flag is absent; `defaultRef` honors the pin.
4. **Exit codes.** A `CliUsageError` (shared.ts) thrown by the coerce
   functions and flag-combination checks maps to exit 2 and prints one
   `gitsheets: <message>` line; `AggregationError` → 23.
5. **Docs.** `docs/cli.md`, `docs/axi.md`, and the skill references gain the
   new flags, `--ref` semantics, and exit codes; axi `TOP_HELP` lists the
   new flags.

## Validation

- [ ] `git sheet query|read|aggregate --ref <other>` read `<other>`, not the
      default branch (test).
- [ ] `normalize --ref <other>` and `upsert --delete-missing --ref <other>`
      read and commit on `<other>`; the default branch does not move (test).
- [ ] `git sheet rollup --branch data` / `--check --branch data` operate on
      the data branch (test).
- [ ] `--stage-pointer`, `GITSHEETS_STAGE_POINTER=1`, and
      `gitsheets.stagePointer = true` stage the gitlink after a CLI write;
      `--no-stage-pointer` beats config; an invalid env value is exit 64
      (tests).
- [ ] `openRepo({ submodule })` honors `GITSHEETS_STAGE_POINTER` /
      `gitsheets.stagePointer`, and an explicit `stagePointer: false` wins
      (test).
- [ ] `--at HEAD` / `GITSHEETS_AT` read the pinned snapshot; a write under
      `--at` exits 69; `--at` without submodule mode exits 64 naming `--at`
      (tests).
- [ ] `gitsheets-axi` accepts `--at` and `--stage-pointer` before or after
      the command (tests).
- [ ] Malformed `--agg`, `--trailer`, `--attachment`, `--filter` exit 2; an
      `AggregationError` exits 23 with `sheet:` / `aggregate:` lines (tests).
- [ ] `merge --help` says the default branch.
- [ ] A malformed axi global flag (`--at` with no value, `--branch`,
      `--submodule=`, `--stage-pointer=yes`) exits 2 with
      `VALIDATION_ERROR` (test).
- [ ] `gitsheets-axi check --help` lists only exit codes 0 / 1 / 2.
- [ ] `docs/axi.md` matches the code: no `--format`, the full error-code
      list, all commands, links `specs/api/axi.md`.
- [ ] `writeBlob` / `rollupStatus` carry no `@internal`.
- [ ] `npm run build`, `npm run type-check`, `npm test` green.

## Risks / unknowns

- **Commands that today rely on `--ref` reads falling back to the default
  branch** — e.g. `upsert --ref <new-branch>` previously opened the config
  from the default branch before failing the transaction; it now fails at
  `openSheet` with the same `RefError`. Watch existing tests.
- **yargs boolean env parsing** — `.env('GITSHEETS')` would coerce
  `GITSHEETS_STAGE_POINTER=1` to `false`; the middleware keeps that tier in
  the library.

## Notes

## Follow-ups
