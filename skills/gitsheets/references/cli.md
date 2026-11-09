# gitsheets CLI reference

`gitsheets <command>` (also aliased as `git sheet <command>`). All commands are thin wrappers around the JS API and inherit the same exit-code conventions.

## Table of contents

- [Global flags](#global-flags)
- [upsert](#upsert) — insert or update records
- [query](#query) — read records
- [aggregate](#aggregate) — count / sum / min / max / avg / distinct
- [rollup](#rollup) — materialize / check a rollup sheet
- [read](#read) — read a single record
- [edit](#edit) — open a record in $EDITOR
- [check](#check) — validate + optionally fix a working-tree file
- [normalize](#normalize) — re-canonicalize every record
- [init](#init) — scaffold a sheet config
- [submodule init](#submodule-init) — set up a data submodule with no record checkout
- [infer](#infer) — scan records → starter JSON Schema
- [migrate-config](#migrate-config) — pre-v1.0 fields → v1.0 schema
- [merge](#merge-v28)
- [Exit codes](#exit-codes)
- [Error output](#error-output)

## Global flags

| Flag | Default | Env |
| --- | --- | --- |
| `--git-dir <path>` | discovered from cwd | `GIT_DIR` |
| `--root <path>` | `/` | `GITSHEETS_ROOT` |
| `--prefix <path>` | none | `GITSHEETS_PREFIX` |
| `--branch <name>` | `gitsheets.branch` git config, else `HEAD`'s branch | `GITSHEETS_BRANCH` |
| `--submodule <path>` | `gitsheets.submodule` git config, else none | `GITSHEETS_SUBMODULE` |
| `--stage-pointer` / `--no-stage-pointer` | `gitsheets.stagePointer` git config, else off | `GITSHEETS_STAGE_POINTER` |
| `--at <superproject-ref>` | none | `GITSHEETS_AT` |
| `--ref <ref>` | the default branch (the pinned commit under `--at`) | `GITSHEETS_REF` |
| `--commit-to <ref>` | derived from `--ref` | — |
| `--message <msg>` | auto-generated | — |
| `--author-name <name>`, `--author-email <email>` | git config | — |
| `--trailer <Key>=<value>` (repeatable) | none | — |

`--prefix` scopes records to a sub-tree under each sheet's configured root — useful for multi-tenant deployments. With `--prefix tenant-a`, a sheet with `root = 'users'` reads/writes records at `users/tenant-a/<path>.toml`. The sheet's config file is unaffected.

A `--working` flag (read/write the working tree's state) is documented but deferred — see issue #165.

`--branch` binds the repository's **default branch** (what commands read and commit to); `--submodule` binds a **data submodule** instead (its `HEAD` is the superproject's pointer; combine with `--branch` for a branch of the submodule). Both resolve flag → env → git config, so one `git config gitsheets.branch data` or `git config gitsheets.submodule data` per clone binds the CLI, `gitsheets-axi`, and the application alike.

In submodule mode, `--stage-pointer` (flag → `GITSHEETS_STAGE_POINTER` → the superproject's `gitsheets.stagePointer`, git booleans) also stages the moved gitlink after each write, and `--at <superproject-ref>` (or `GITSHEETS_AT`; no git config — it is a one-run pin) reads the data snapshot that superproject commit pins, refusing writes (exit `69`).

`--ref` pins reads as well as writes: `query` / `read` / `aggregate` read `<ref>`, and `normalize`, `upsert --delete-missing`, `edit`, `infer`, `rollup` read `<ref>` and commit onto it.

> **Working-tree gotcha.** Every mutating command commits to the git **ref** via plumbing and never updates checked-out files. If the records live on the branch you check out, `git status` shows them *deleted* or *modified* after each write — not data loss. **Fix the layout:** keep records on a data branch (`gitsheets init <sheet> --commit --branch data`, then `git config gitsheets.branch data`) or in a data submodule ([submodule init](#submodule-init), then `git config gitsheets.submodule data`) — no working tree of records exists to fall behind. Only when records must stay on the code branch, run `git checkout HEAD -- .` after writes to refresh the files.

## upsert

Insert or update one or more records.

```bash
gitsheets upsert users users.json
gitsheets upsert users - < records.jsonl
gitsheets upsert users '{"slug":"jane","email":"jane@x.org"}'
gitsheets upsert users users.csv --format=csv
gitsheets upsert users users.toml --format=toml
```

Input is inline JSON (single record `{...}` or array `[{...}, ...]`), a file path, or `-` for stdin.

### Flags

- `--format <json|toml|csv>` — input format. Default: inferred from extension (`*.toml` → TOML, `*.csv` → CSV), else JSON.
- `--encoding <enc>` — encoding for file/stdin input. Default `utf8`.
- `--delete-missing` — **destructive**: full-replace mode. Records in the sheet but not in the input set are deleted in the same transaction.
- `--attachment <name>=<source>` (repeatable) — attach a file alongside the (single) record. `<source>` is a file path (relative to the input file's directory, or cwd for stdin) or `-` for stdin (only one `-` per command). Requires a single-record input.
- `--patch` — treat each input record as an [RFC 7396 JSON Merge Patch](https://datatracker.ietf.org/doc/html/rfc7396). Path-template fields auto-derive the query; remaining fields merge into the matched record. Can't combine with `--delete-missing` or `--attachment`.

TOML input supports three layouts: a `[[records]]` array of tables (recommended for multi-record files), a top-level table where every value is itself a table, or a single-record document.

CSV input: the first row is the header; cell values stay as strings (type coercion belongs in the schema).

Output (per record): `<blob-hash> <rendered-path>`. For `--delete-missing` deletes: `- <path>`. For `--attachment` adds: `+ <path>/<name>`.

## query

Read records. Newline-delimited JSON by default.

```bash
gitsheets query users
gitsheets query users --filter email=jane@x.org
gitsheets query users --filter status=active --filter project_id=p1
gitsheets query users --fields slug email --limit 100
gitsheets query users --format=csv --fields slug email
gitsheets query users --format=toml > users.toml
gitsheets query posts --no-body --format=csv          # markdown sheet, body-less
gitsheets query posts --filter 'publishedAt>=2026-01-01' --filter 'publishedAt<2026-04-01'   # range (quote the > / <)
```

### Flags

- `--filter <field>=<value>` (repeatable) — equality filter. `field>=value`, `field<=value`, `field>value`, `field<value` build a **range** on the field (two clauses on one field merge into one range; v2.7+). Values are strings: an ISO 8601 value compares chronologically against datetime fields, and on a date-bucket path field (`${{ field: YYYY/MM/DD }}`) the range prunes the walk to the matching partitions. Quote clauses containing `<` / `>` so the shell doesn't redirect.
- `--fields <name>...` — output column subset (order preserved)
- `--limit <n>`
- `--format <json|csv|tsv|toml>` — default `json` (newline-delimited)
- `--headers` / `--no-headers` — emit a header row for CSV/TSV (default true)
- `--body` / `--no-body` — for content-typed (markdown/mdx) sheets, include or suppress the body field. Default `true`. No effect on TOML sheets.

TOML output emits a `[[records]]` array round-trippable through `upsert --format=toml`.

## aggregate

```bash
gitsheets aggregate transactions --agg count=count --agg total=sum:amountCents
gitsheets aggregate transactions --filter 'postedAt>=2026-01-01' --agg total=sum:amountCents --group-by status
gitsheets aggregate repos --agg teams=distinct:targetTeam --format toml
```

- `--agg <name>=<form>[:<field>]` (repeatable, at least one) — `count`, or `sum` / `min` / `max` / `avg` / `distinct` with a field
- `--filter` — as on `query`
- `--group-by <field>` — groups every aggregate; each result becomes an object keyed by the field's string form
- `--format <json|toml>` — default `json`: one object with a key per `--agg` name

Computed in the core, body-less, canonical path order. Empty aggregates are omitted except `count` / `sum` (`0`). `reduce` is library-only. Mixed value kinds under `min` / `max` / `distinct` exit `23` (`AggregationError`); a malformed `--agg` exits `2`.

## rollup

```bash
gitsheets rollup transactions-monthly           # recompute stale/missing, delete orphans — one commit (none if fresh)
gitsheets rollup transactions-monthly --check   # list stale / missing / orphaned, write nothing, exit 1 if any
```

Prints `<status> <partition>` per line (`recomputed` / `deleted`, or with `--check` `stale` / `missing` / `orphaned`). Honors the transaction flags and `--prefix`. Use `--check` as the CI gate on data branches other tools write to; writes to a rollup sheet fail with exit `69` (`sheet_derived`).

## read

Read a single record by its rendered path.

```bash
gitsheets read users jane
gitsheets read users jane --format=toml
```

Flags:

- `--format <json|toml|csv|tsv>` — default: pretty JSON.

## edit

Open a record in `$EDITOR` for interactive editing. On save: re-parse, validate, upsert in a transaction. If the saved file is byte-identical to what was opened, no commit. If validation fails, abort with a clear message (no editor re-open).

```bash
gitsheets edit users jane
```

Editor resolution: `$VISUAL` → `$EDITOR` → `vi`. The editor is spawned through a shell, so `EDITOR="code --wait"` works.

## check

Verify a record file in the working tree is parseable, schema-valid, and canonical. Doesn't commit; operates on the file at the path you provide.

```bash
gitsheets check posts posts/hello.md            # report-only; exit 1 if not canonical
gitsheets check posts posts/hello.md --fix      # rewrite to canonical; exit 0
```

### Two use cases

**Post-edit hook for agents.** An agent edits a record file directly; the hook normalizes + validates in place:

```jsonc
// .claude/settings.json (Claude Code) — pseudocode; check your tooling's syntax
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit", "command": "gitsheets check <sheet> $FILE --fix" }
    ]
  }
}
```

Or as a git pre-commit hook:

```bash
#!/bin/sh
# .git/hooks/pre-commit
git diff --cached --name-only --diff-filter=ACM 'posts/*.md' \
  | xargs -I{} gitsheets check posts {} --fix
git add $(git diff --cached --name-only --diff-filter=ACM 'posts/*.md')
```

**CI verification.** Drop the `--fix` to fail the build when a file isn't canonical:

```bash
gitsheets check posts posts/hello.md
```

### merge (v2.8+)

```bash
gitsheets merge <theirs> [--into <ours>] [--prefer ours|theirs] [--message m] [--dry-run]
```

Sheet-aware merge: record files changed on both sides are field-merged and written canonically (no mixed serializations); non-record files merge as git would. Conflicts (field / delete-modify / blob) are listed on stderr and exit 1 with nothing written unless `--prefer` picks a side. `--dry-run` prints the merged tree hash and moves nothing. Prefer this over a plain `git merge` of a data repo — or run `gitsheets merge --install-driver` once per clone so `git merge` / `rebase` / `cherry-pick` do it: it sets the `merge.gitsheets.*` git-config keys and adds a `<root>/**/*<ext> merge=gitsheets` line per sheet to `.gitattributes` (idempotent; commit the file). Fresh clones need the config step again — put `--install-driver` in the project's setup script.

## Exit codes

- `0` — file is canonical and valid (or `--fix` rewrote it)
- `1` — file is parseable + valid but not canonical (without `--fix`)
- `22` — `ValidationError` (schema)
- `64` — `ConfigError` (parse failed)

## normalize

Re-write **every** record in the sheet through the canonical-normalization pipeline in one transaction. Use after upgrading `[gitsheet.fields.<name>.sort]` rules or after a manual edit that didn't preserve canonical key order.

```bash
gitsheets normalize users
```

For one-file normalization use `check --fix` instead — it's the working-tree-only counterpart that doesn't commit.

## init

Scaffold `.gitsheets/<sheet>.toml` with sensible defaults (`root = <sheet>`, `path = '${{ id }}'`).

```bash
gitsheets init users
gitsheets init users --path='${{ slug }}'
gitsheets init users --schema=./schemas/user.schema.json
```

Flags:

- `--path <tpl>` — override the path template
- `--schema <file>` — embed a JSON Schema file under `[gitsheet.schema]`
- `--force` — overwrite an existing config

## submodule init

`gitsheets submodule init <path> [--url <url>] [--branch <b>]` — set up a data submodule with **no record checkout**. With `--url`: adds the `.gitmodules` entry, clones into `.git/modules/<path>` without a checkout, puts the submodule `HEAD` on the branch (default: the remote's default branch; an empty remote needs `--branch`), sets `submodule.<name>.ignore = dirty`, stages `.gitmodules` + the pointer. Without `--url` (fresh clone of the superproject): fetches and puts `HEAD` on the `.gitmodules` branch at the pinned commit. Idempotent; never commits.

```bash
gitsheets submodule init data --url git@github.com:org/app-data.git --branch main
git commit -m "Add data submodule" && git config gitsheets.submodule data
gitsheets upsert users '{"slug":"jane"}'   # superproject: modified: data (new commits)
git add data && git commit -m "Add jane"   # pin the data snapshot with the code
```

Set `push.recurseSubmodules = check` (or `on-demand`) in the superproject so a pointer never reaches the remote before its data commit.

## infer

Scan every record in the sheet and write a conservative starter `[gitsheet.schema]` block into `.gitsheets/<sheet>.toml`. Captures observed types, `minimum`/`maximum` for numeric fields, `items.type` for arrays, and fields present in every record become `required`.

```bash
gitsheets infer users
```

Output is a starting point — review and tighten (add `pattern`, `format`, etc.) before relying on it.

## migrate-config

Convert a pre-v1.0 `[gitsheet.fields]` config to a v1.0 `[gitsheet.schema]` config in one transaction.

```bash
gitsheets migrate-config orders
```

Migration mapping: `type` → `[gitsheet.schema.properties.<name>].type`, `enum` → `enum`, `default` → `default`, `sort` stays under `[gitsheet.fields.<name>.sort]` (different concept). `trueValues` / `falseValues` emit a warning pointing at the CSV-ingest helper.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic / unknown error (or `check` reporting not-canonical) |
| 2 | Argument-parsing error, incl. a malformed `--filter` / `--agg` / `--trailer` / `--attachment` value or an invalid flag combination |
| 22 | `ValidationError` |
| 23 | `AggregationError` |
| 64 | `ConfigError` |
| 65 | `RefError` |
| 66 | `NotFoundError` |
| 67 | `ContractError` |
| 69 | `TransactionError` |
| 70 | `IndexError` |

Stable from v1.0 onward.

## Error output

Errors print to stderr in this shape (plus the non-zero exit code from the table above):

```text
gitsheets: ValidationError: record failed JSON Schema validation
  code:   validation_failed
  issue:  email: must match format "email" (json-schema)
```
