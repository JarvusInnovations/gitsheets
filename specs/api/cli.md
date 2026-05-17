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

`--ref` selects which commit/branch to read from or transact against. `--commit-to` overrides which branch a write-transaction advances.

A `--working` flag — read/write the working tree state instead of a committed tree — is documented but not yet implemented; it's tracked at [#165](https://github.com/JarvusInnovations/gitsheets/issues/165) and listed in [`deferred.md`](../deferred.md).

These options unify what [#106](https://github.com/JarvusInnovations/gitsheets/issues/106) asked for. Every mutating command implicitly uses `repo.transact` and accepts `--message`, `--author-name`, `--author-email`, and one or more `--trailer Key=Value` flags (repeatable).

## Commands

### `git sheet upsert <sheet> [input]`

Insert or update one or more records.

```bash
git sheet upsert users users.json
git sheet upsert users - < records.csv --format=csv
git sheet upsert users '{"slug":"jane","email":"jane@x.org"}'
```

Flags:

- `--format <json|toml|csv>` — input format. Default: inferred from extension (`*.toml` → TOML, `*.csv` → CSV), otherwise JSON.
- `--encoding <enc>` — encoding for file/stdin input. Default `utf8`.
- `--delete-missing` — full-replace mode: records in the sheet but not in the input are deleted in the same transaction.
- `--attachment <name>=<source>` (repeatable) — attach a file alongside the (single) upserted record. `<source>` is a file path (relative to the input file's directory, or cwd for stdin input) or `-` for stdin. Requires a single-record input set.
- `--patch` — treat each input record as an [RFC 7396 JSON Merge Patch](https://datatracker.ietf.org/doc/html/rfc7396). Path-template fields auto-derive the query; remaining fields are merged into the matched record. Cannot be combined with `--delete-missing` or `--attachment`. See [`behaviors/patch-semantics.md`](../behaviors/patch-semantics.md).
- `--message <msg>`, `--author-name`, `--author-email`, `--trailer Key=Value` (repeatable) — transaction metadata

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
- `--no-body` — for content-typed (markdown/mdx) sheets, suppress the body field in the output. No effect on TOML sheets. See [behaviors/content-types.md](../behaviors/content-types.md#lazy-body-loading).

### `git sheet read <sheet> <path>`

Read a single record by exact path.

```bash
git sheet read users users/janedoe
git sheet read users users/janedoe --format=toml
```

Flags:

- `--format <json|toml|csv|tsv>` — output format. Default: pretty-printed JSON.

### `git sheet edit <sheet> <path>`

Open a record in `$EDITOR`. On save, validate and upsert.

```bash
git sheet edit users users/janedoe
```

Honors the same transaction flags as `upsert`.

### `git sheet check <sheet> <file>`

Verify a record file in the working tree is parseable, schema-valid, and in canonical form. Doesn't commit — works against the working tree only.

```bash
git sheet check posts posts/hello.md             # report-only
git sheet check posts posts/hello.md --fix       # rewrite to canonical if needed
```

Designed for post-edit hooks (`--fix`) and CI verification (no `--fix`):

- `gitsheets check <sheet> $FILE` — for CI / pre-commit verification. Exit 1 if the file isn't already canonical; doesn't touch the file.
- `gitsheets check <sheet> $FILE --fix` — for post-edit auto-formatting. Rewrites the file in canonical form and exits 0.

Exit codes:

- `0` — file is canonical and valid (or `--fix` rewrote it successfully)
- `1` — file is parseable + schema-valid but not canonical (without `--fix`)
- `22` — `ValidationError` (schema)
- `64` — `ConfigError` (file failed to parse as the sheet's format)

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
