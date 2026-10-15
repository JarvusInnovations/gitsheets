---
status: done
depends: [sheet-aware-merge]
specs:
  - specs/behaviors/merge.md
  - specs/api/cli.md
issues: [307]
pr: 327
---

# Plan: `git sheet merge --install-driver`

## Scope

One flag that does the two manual steps the merge-driver docs asked for:
set `merge.gitsheets.name` / `merge.gitsheets.driver` in the repo's git
config and add `<root>/**/*<ext> merge=gitsheets` lines for every sheet at
`HEAD` to the working tree's `.gitattributes`, idempotently, without
committing. Bare repos get the config plus the printed lines.

## Implements

- `specs/behaviors/merge.md` — "Merge driver" (the install step).
- `specs/api/cli.md` — `git sheet merge --install-driver`.

## Approach

1. `merge [theirs]` with `--install-driver`; `theirs` and the flag are
   mutually exclusive (usage error otherwise, exit 2).
2. `runInstallDriver`: `git config` the two keys; `git rev-parse
   --show-toplevel` for the work tree (absent → bare); discover sheets via
   `repo.openSheets()` + `readConfig()` for root and format; compute the
   pattern per sheet; merge into `.gitattributes` keeping existing lines;
   print `set:` / `added:` / `kept:` lines.
3. Tests: fresh fixture → config keys set, attributes written for two
   sheets with different formats; second run adds nothing; `merge import
   --install-driver` is a usage error.
4. Docs: `docs/cli.md`, skill `references/cli.md`, and the recipe mention.

## Validation

- [x] vitest: the cases above.
- [x] `npm run type-check` clean.

## Risks / unknowns

- A `root = '.'` sheet yields the pattern `**/*.toml`, which also matches
  `.gitsheets/*.toml` configs and vendored contracts. The driver handles a
  path no sheet owns by falling back to git's text merge, so the only cost
  is a redundant driver invocation on those files.

## Notes

- Running git with `cwd` inside `.git` reports the repo as bare, so the
  command reads `core.bare` via `--git-dir` and resolves the top level from
  the git dir's parent.
- yargs usage failures exit 2 through `process.exit`, which vitest
  intercepts; the tests assert a non-zero code plus the message.

## Follow-ups

- None.
