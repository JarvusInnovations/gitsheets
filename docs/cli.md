# CLI reference

`git sheet <command>` — the command-line interface. Installs as both
`gitsheets` and `git-sheet`.

The CLI is a thin wrapper around the JS API. Every command resolves to an
operation on a `Repository` (or `Sheet`/`Transaction`).

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

`--prefix` scopes records to a sub-tree under each sheet's configured root —
useful for multi-tenant deployments where one git repo holds many tenants
under `<root>/<tenant>/...`. With `--prefix tenant-a`, a sheet whose config
declares `root = 'users'` reads/writes records at `users/tenant-a/<path>.toml`.
The sheet's `.gitsheets/<name>.toml` config file is unaffected — only the
record data tree is scoped.

## Commands

### `gitsheets upsert <sheet> [input]`

Insert or update one or more records.

```bash
gitsheets upsert users users.json
gitsheets upsert users - < records.jsonl
gitsheets upsert users '{"slug":"jane","email":"jane@x.org"}'
gitsheets upsert users users.csv --format=csv
gitsheets upsert users users.toml --format=toml
```

`input` is inline JSON (single record `{...}` or array `[{...}, ...]`),
a file path, or `-` for stdin.

Flags:

- `--format <json|toml|csv>` — input format. Default: inferred from extension (`*.toml` → TOML, `*.csv` → CSV), otherwise JSON.
- `--encoding <enc>` — encoding for file/stdin input. Default `utf8`. Accepts any Node `BufferEncoding`.
- `--delete-missing` — **DESTRUCTIVE**: full-replace mode. After upserting every input record, deletes any record in the sheet whose path isn't in the input set, in the same transaction. If validation fails on any input record, the whole transaction rolls back and the tree is unchanged.
- `--attachment <name>=<source>` (repeatable) — attach a file alongside the (single) upserted record in the same transaction. `<source>` is a file path (relative to the input file's directory, or cwd when input is stdin) or `-` for stdin (only one `-` per command). Requires a single-record input set.

```bash
gitsheets upsert users '{"slug":"jane"}' \
  --attachment avatar.jpg=./assets/jane.jpg \
  --attachment bio.md=-
```

- `--patch` — treat each input record as an [RFC 7396 JSON Merge Patch](https://datatracker.ietf.org/doc/html/rfc7396). Fields present in the sheet's path template are split out as the query (which existing record to find); the remaining fields are merged into that record. `null` deletes a field. Cannot be combined with `--delete-missing` or `--attachment`.

```bash
# Update jane's email; delete her bio; add a team field.
gitsheets upsert users '{"slug":"jane","email":"new@x.org","bio":null,"team":"eng"}' --patch
```

For sheets whose template uses expressions (e.g., `${{ slug.toLowerCase() }}`), the CLI does a best-effort identifier scan to find the query fields. If that doesn't yield the right split, use the library API `Sheet.patch(query, partial)` directly.

TOML input supports three layouts: a `[[records]]` array of tables (recommended for multi-record files), a top-level table where every value is itself a table (each value becomes one record), or a single-record document.

CSV input uses the first row as a header. Cell values stay as strings — type coercion belongs in the consumer schema, not in CSV parsing.

Output (per record):

```text
<blob-hash> <rendered-path>
```

### `gitsheets query <sheet>`

Read records. Output is newline-delimited JSON by default.

```bash
gitsheets query users
gitsheets query users --filter email=jane@x.org
gitsheets query users --filter status=active --filter project_id=p1
gitsheets query users --fields slug email --limit 100
gitsheets query users --format=csv --fields slug email
gitsheets query users --format=toml > users.toml
```

Flags:

- `--filter <field>=<value>` (repeatable) — equality filter
- `--fields <name>...` — output column subset (order preserved)
- `--limit <n>`
- `--format <json|csv|tsv|toml>` — output format. Default `json` (newline-delimited).
- `--headers` / `--no-headers` — emit a header row for CSV/TSV. Default `true`.

TOML output emits a `[[records]]` array of tables, round-trippable through `upsert --format=toml`.

### `gitsheets read <sheet> <path>`

Read a single record by its rendered path.

```bash
gitsheets read users jane
gitsheets read users jane --format=toml
```

Flags:

- `--format <json|toml|csv|tsv>` — output format. Default: pretty-printed JSON.

### `gitsheets edit <sheet> <path>`

Open a record in `$EDITOR` for interactive editing. On save:

1. The CLI re-reads the tmpfile, parses it as TOML.
2. If the file is byte-identical to what was written out, no commit is made (idempotent — no empty commits).
3. Otherwise the parsed record is upserted in a transaction; validation, normalization, and path rendering all run.

Editor resolution: `$VISUAL` → `$EDITOR` → `vi`. The editor is spawned through a shell, so `EDITOR="code --wait"` and similar wrapped commands work. Exit-code 0 from the editor means "save"; anything else aborts without commit.

```bash
gitsheets edit users jane
```

Validation failures abort with a clear message rather than re-opening the editor — re-edit the input via `gitsheets read users <path> --format=toml` plus `upsert` if you need a second pass.

### `gitsheets normalize <sheet>`

Re-write every record in the sheet through canonical normalization in one
transaction. Use case: after upgrading `[gitsheet.fields.<name>.sort]` rules,
or after a manual edit that didn't preserve canonical key order.

```bash
gitsheets normalize users
```

### `gitsheets infer <sheet>`

Scan every record in the sheet and write a conservative starter `[gitsheet.schema]` block into `.gitsheets/<sheet>.toml`. The committed schema captures observed types per field, plus `minimum`/`maximum` hints for numeric fields and `items.type` for arrays. Fields present in every record are listed under `required`.

```bash
gitsheets infer users
```

Existing `root`, `path`, and any non-schema `fields.<name>.sort` rules are preserved. The result is a starting point — review and tighten (add `pattern`, `format`, etc.) before relying on it.

### `gitsheets migrate-config <sheet>`

Convert a pre-v1.0 `[gitsheet.fields]` config to a v1.0 `[gitsheet.schema]` config in one transaction.

```bash
gitsheets migrate-config orders
```

Migration table (matches [`specs/behaviors/validation.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/validation.md#migration-of-pre-v10-gitsheetfields-config)):

| Pre-v1.0 field | v1.0 placement |
| --- | --- |
| `type: 'number' \| 'string' \| 'boolean'` | `[gitsheet.schema.properties.<name>].type` |
| `enum: [...]` | `[gitsheet.schema.properties.<name>].enum` |
| `default: <value>` | `[gitsheet.schema.properties.<name>].default` |
| `sort: ...` | `[gitsheet.fields.<name>.sort]` (unchanged) |
| `trueValues: [...]`, `falseValues: [...]` | Warning to stderr — move to CSV-ingest helper |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic / unknown error |
| 2 | Argument-parsing error |
| 22 | `ValidationError` |
| 64 | `ConfigError` |
| 65 | `RefError` |
| 66 | `NotFoundError` |
| 69 | `TransactionError` |
| 70 | `IndexError` |

Per [`specs/api/errors.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/errors.md).

## Error output

Errors print to stderr in this shape:

```text
gitsheets: ValidationError: record failed JSON Schema validation
  code:   validation_failed
  issue:  email: must match format "email" (json-schema)
```
