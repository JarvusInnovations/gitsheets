# gitsheets CLI reference

`gitsheets <command>` (also aliased as `git sheet <command>`). All commands are thin wrappers around the JS API and inherit the same exit-code conventions.

## Table of contents

- [Global flags](#global-flags)
- [upsert](#upsert) — insert or update records
- [query](#query) — read records
- [read](#read) — read a single record
- [edit](#edit) — open a record in $EDITOR
- [check](#check) — validate + optionally fix a working-tree file
- [normalize](#normalize) — re-canonicalize every record
- [init](#init) — scaffold a sheet config
- [infer](#infer) — scan records → starter JSON Schema
- [migrate-config](#migrate-config) — pre-v1.0 fields → v1.0 schema
- [Exit codes](#exit-codes)
- [Error output](#error-output)

## Global flags

| Flag | Default | Env |
| --- | --- | --- |
| `--git-dir <path>` | discovered from cwd | `GIT_DIR` |
| `--root <path>` | `/` | `GITSHEETS_ROOT` |
| `--prefix <path>` | none | `GITSHEETS_PREFIX` |
| `--ref <ref>` | `HEAD` | `GITSHEETS_REF` |
| `--commit-to <ref>` | derived from `--ref` | — |
| `--message <msg>` | auto-generated | — |
| `--author-name <name>`, `--author-email <email>` | git config | — |
| `--trailer <Key>=<value>` (repeatable) | none | — |

`--prefix` scopes records to a sub-tree under each sheet's configured root — useful for multi-tenant deployments. With `--prefix tenant-a`, a sheet with `root = 'users'` reads/writes records at `users/tenant-a/<path>.toml`. The sheet's config file is unaffected.

A `--working` flag (read/write the working tree's state) is documented but deferred — see issue #165.

> **Working-tree gotcha.** Every mutating command commits to the git **ref** via plumbing and does **not** update your checked-out files. After a write (especially a bulk `upsert`), `git status` shows the new records as *deleted* on disk — the ref has them, the working tree doesn't. Run `git checkout HEAD -- .` to materialize them. This is expected, not data loss, and is what #165's `--working` mode will eventually smooth over.

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
```

### Flags

- `--filter <field>=<value>` (repeatable) — equality filter
- `--fields <name>...` — output column subset (order preserved)
- `--limit <n>`
- `--format <json|csv|tsv|toml>` — default `json` (newline-delimited)
- `--headers` / `--no-headers` — emit a header row for CSV/TSV (default true)
- `--body` / `--no-body` — for content-typed (markdown/mdx) sheets, include or suppress the body field. Default `true`. No effect on TOML sheets.

TOML output emits a `[[records]]` array round-trippable through `upsert --format=toml`.

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

### Exit codes

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
| 2 | Argument-parsing error |
| 22 | `ValidationError` |
| 64 | `ConfigError` |
| 65 | `RefError` |
| 66 | `NotFoundError` |
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
