# CLI reference

`git sheet <command>` — the command-line interface. Installs as both
`gitsheets` and `git-sheet`.

The CLI is a thin wrapper around the JS API. Every command resolves to an
operation on a `Repository` (or `Sheet`/`Transaction`).

## Global flags

| Flag | Default | Env |
|---|---|---|
| `--git-dir <path>` | discovered from cwd | `GIT_DIR` |
| `--root <path>` | `/` | `GITSHEETS_ROOT` |
| `--ref <ref>` | `HEAD` | `GITSHEETS_REF` |
| `--commit-to <ref>` | derived from `--ref` | — |
| `--message <msg>` | auto-generated | — |
| `--author-name <name>`, `--author-email <email>` | git config | — |
| `--trailer <Key>=<value>` (repeatable) | none | — |

## Commands

### `gitsheets upsert <sheet> [input]`

Insert or update one or more records.

```bash
gitsheets upsert users users.json
gitsheets upsert users - < records.jsonl
gitsheets upsert users '{"slug":"jane","email":"jane@x.org"}'
```

`input` is inline JSON (single record `{...}` or array `[{...}, ...]`),
a file path, or `-` for stdin.

Flags:

- `--patch` — apply RFC 7396 merge patch instead of replacing

Output (per record):

```text
<blob-hash> <rendered-path>
```

### `gitsheets query <sheet>`

Read records. Output is newline-delimited JSON.

```bash
gitsheets query users
gitsheets query users --filter email=jane@x.org
gitsheets query users --filter status=active --filter project_id=p1
gitsheets query users --fields slug email --limit 100
```

Flags:

- `--filter <field>=<value>` (repeatable) — equality filter
- `--fields <name>...` — output column subset
- `--limit <n>`

### `gitsheets read <sheet> <path>`

Read a single record by its rendered path.

```bash
gitsheets read users jane
```

Output: pretty-printed JSON.

### `gitsheets normalize <sheet>`

Re-write every record in the sheet through canonical normalization in one
transaction. Use case: after upgrading `[gitsheet.fields.<name>.sort]` rules,
or after a manual edit that didn't preserve canonical key order.

```bash
gitsheets normalize users
```

## Exit codes

| Code | Meaning |
|---|---|
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

## Deferred commands

These are documented in [`specs/api/cli.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/cli.md)
but not shipped in the v1.0 substrate; they land in follow-up PRs:

- `gitsheets edit <sheet> <path>` — open in `$EDITOR`
- `gitsheets infer <sheet>` — generate a starter JSON Schema from records
- `gitsheets migrate-config <sheet>` — convert legacy `[gitsheet.fields]`
- `gitsheets init <sheet>` — scaffold a new sheet config (#139)
