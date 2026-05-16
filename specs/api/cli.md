# API: CLI

`git sheet <command>` — the command-line interface. Installs as both `gitsheets` and `git-sheet`.

## Summary

The CLI is a thin wrapper around the JS API. Every command resolves to an operation on a `Repository` (or `Sheet`/`Transaction`); the CLI handles arg parsing, I/O encoding, and output formatting.

## Global flags

These apply to every command unless noted otherwise:

| Flag | Default | Source |
| --- | --- | --- |
| `--git-dir <path>` | discovered | `GIT_DIR` env var |
| `--root <path>` | `/` | `GITSHEETS_ROOT` env var |
| `--prefix <path>` | none | `GITSHEETS_PREFIX` env var |
| `--ref <ref>` | `HEAD` | `GITSHEETS_REF` env var |
| `--commit-to <ref>` | derived from `--ref` (if ref is a branch) | none |
| `--working` | false | none |

`--ref` selects which commit/branch to read from or transact against. `--commit-to` overrides which branch a write-transaction advances. `--working` reads/writes the working tree state (not a committed tree).

These options unify what [#106](https://github.com/JarvusInnovations/gitsheets/issues/106) asked for. Every mutating command implicitly uses `repo.transact` and accepts `--message`, `--author-name`, `--author-email`, and one or more `--trailer Key=Value` flags (repeatable).

## Commands

### `git sheet upsert <sheet> [file]`

Insert or update one or more records.

```bash
git sheet upsert users users.json
git sheet upsert users - < records.csv --format=csv
git sheet upsert users '{"slug":"jane","email":"jane@x.org"}'
```

Flags:

- `--format <json|toml|csv>` — input format (default: inferred from extension, fallback `json`); see [`deferred.md`](../deferred.md) — JSON only in v1.0
- `--encoding <enc>` — default `utf8`; see [`deferred.md`](../deferred.md) — utf-8 only in v1.0
- `--delete-missing` — full-replace mode: records in the sheet but not in the input are deleted; see [`deferred.md`](../deferred.md)
- `--attachment <name>=<source>` (repeatable) — attach a file alongside the (single) upserted record. `<source>` is a file path (relative to the input file's directory, or cwd for stdin input) or `-` for stdin. Requires a single-record input set.
- `--message <msg>`, `--author-name`, `--author-email`, `--trailer Key=Value` (repeatable) — transaction metadata

- `--patch` — treat each input record as an [RFC 7396 JSON Merge Patch](https://datatracker.ietf.org/doc/html/rfc7396). Path-template fields auto-derive the query; remaining fields are merged into the matched record. Cannot be combined with `--delete-missing` or `--attachment`. See [`behaviors/patch-semantics.md`](../behaviors/patch-semantics.md).

Output (per record, to stdout):

```text
<blob-hash> <rendered-path>
```

### `git sheet query <sheet>`

Read records.

```bash
git sheet query users
git sheet query users --filter email=jane@x.org
git sheet query users --filter status=active --filter project_id=p1
git sheet query users --format=csv --headers
```

Flags:

- `--filter field=value` (repeatable) — equality filter
- `--fields <name>...` — output column subset / reorder
- `--limit <n>`
- `--format <json|csv|tsv|toml>` (default: `json`)
- `--headers` (CSV/TSV only; default: true)

### `git sheet read <sheet> <path>`

Read a single record by exact path.

```bash
git sheet read users users/janedoe
```

Output: TOML or JSON to stdout (per `--format`).

### `git sheet edit <sheet> <path>`

Open a record in `$EDITOR`. On save, validate and upsert.

```bash
git sheet edit users users/janedoe
```

Honors the same transaction flags as `upsert`.

### `git sheet normalize <sheet>`

Re-write every record in the sheet through the canonical-normalization pipeline. Commits a single transaction containing all changed records.

```bash
git sheet normalize users
```

Use case: after upgrading the sheet's `sort` config, or after a manual edit that didn't preserve sort order, recanonicalize all records.

### `git sheet infer <sheet>`

Scan existing records and write a starter `[gitsheet.schema]` to `.gitsheets/<sheet>.toml`.

```bash
git sheet infer users
```

Output is conservative — observed types only, no inferred regex/format constraints. The result is a starting point the user edits.

See [#130](https://github.com/JarvusInnovations/gitsheets/issues/130).

### `git sheet migrate-config <sheet>`

Convert a pre-v1.0 `[gitsheet.fields]` config to a v1.0 `[gitsheet.schema]` config. Lossless for `type`/`enum`/`default`; surfaces `trueValues`/`falseValues` as a warning suggesting the CSV-ingest helper.

```bash
git sheet migrate-config users
```

See [#130](https://github.com/JarvusInnovations/gitsheets/issues/130).

### `git sheet init <sheet>`

Scaffold `.gitsheets/<sheet>.toml` with defaults `root = <sheet>` and `path = '${{ id }}'`. Flags:

- `--path <tpl>` — override the path template.
- `--schema <file>` — embed a JSON Schema file at `[gitsheet.schema]`.
- `--force` — overwrite an existing config.

```bash
git sheet init users --path='${{ slug }}' --schema=./schemas/user.schema.json
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic error (unhandled exception) |
| 2 | Argument-parsing error |
| 22 | `ValidationError` |
| 64 | `ConfigError` |
| 65 | `RefError` (not-found) |
| 66 | `NotFoundError` |
| 69 | `TransactionError` |
| 70 | `IndexError` |

Following loose [`sysexits.h`](https://man.openbsd.org/sysexits.3) precedent where useful, otherwise improvised. Stable from v1.0.

## Streaming behavior

`upsert` and `query` stream records when possible. Large CSV inputs / outputs do not need to fit in memory.

## Error output

Errors print to stderr in this shape:

```text
gitsheets: <error-class>: <message>
  code:   <code>
  cause:  <optional cause>
```

Plus a non-zero exit code per the table above.

## Coordinates with

- [api/repository.md](repository.md)
- [api/sheet.md](sheet.md)
- [api/transaction.md](transaction.md)
- [api/errors.md](errors.md)
- All [behaviors/](../behaviors/) specs — the CLI surfaces them through flags
