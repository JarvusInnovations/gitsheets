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
| `--branch <name>` | `gitsheets.branch` git config, else `HEAD`'s branch | `GITSHEETS_BRANCH` env var |
| `--ref <ref>` | the resolved default branch | `GITSHEETS_REF` env var |
| `--commit-to <ref>` | derived from `--ref` (if ref is a branch) | none |

`--ref` selects which commit/branch to read from or transact against. `--branch` selects the repository's default branch (flag → `GITSHEETS_BRANCH` → `gitsheets.branch` git config → `HEAD`'s branch); `--ref`'s default is that branch, so a project that exports `GITSHEETS_BRANCH=data`, or a clone with `gitsheets.branch` set, needs no flags ([behaviors/default-branch.md](../behaviors/default-branch.md)). `--commit-to` overrides which branch a write-transaction advances.

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
git sheet query posts --filter 'publishedAt>=2026-01-01' --filter 'publishedAt<2026-04-01'
git sheet query users --format=csv --headers
```

Flags:

- `--filter field=value` (repeatable) — equality filter. The comparison forms `field>=value`, `field<=value`, `field>value`, `field<value` build a range entry on the field (several clauses on one field combine into one range); values are passed as strings, so comparisons follow the string-bound rules of [api/sheet.md](sheet.md#sheetqueryfilter-opts) — an ISO 8601 value compares chronologically against datetime fields, and a range on a date-bucket path field prunes the walk. Operators are matched longest-first (`>=` before `>`), and a clause with no operator is an error.
- `--fields <name>...` — output column subset / reorder
- `--limit <n>`
- `--format <json|csv|tsv|toml>` (default: `json`)
- `--headers` (CSV/TSV only; default: true)
- `--no-body` — for content-typed (markdown/mdx) sheets, suppress the body field in the output. No effect on TOML sheets. See [behaviors/content-types.md](../behaviors/content-types.md#lazy-body-loading).

### `git sheet read <sheet> <path>`

Read a single record by exact path — one blob read via [`sheet.get(path)`](sheet.md#sheetgetpath-opts), never a sheet scan.

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

Output is conservative — observed types only, no inferred regex/format constraints. The result is a starting point the user edits. `required` lists every field present on every record **plus the template's static fields** (always, so the written config passes the open-time template check — [behaviors/path-templates.md](../behaviors/path-templates.md#template-fields-must-be-schema-required)).

See [#130](https://github.com/JarvusInnovations/gitsheets/issues/130).

### `git sheet migrate-config <sheet>`

Convert a pre-v1.0 `[gitsheet.fields]` config to a v1.0 `[gitsheet.schema]` config. Lossless for `type`/`enum`/`default`; surfaces `trueValues`/`falseValues` as a warning suggesting the CSV-ingest helper. The written schema's `required` lists the template's static fields (pre-v1.0 configs had no notion of required; the template fields are the one set that must be present — [behaviors/path-templates.md](../behaviors/path-templates.md#template-fields-must-be-schema-required)).

```bash
git sheet migrate-config users
```

See [#130](https://github.com/JarvusInnovations/gitsheets/issues/130).

### `git sheet init <sheet>`

Commit a starter `.gitsheets/<sheet>.toml` with defaults `root = <sheet>` and `path = '${{ id }}'` to the target ref (`--ref` / `--commit-to`, default the default branch) through a transaction. The working tree is not written. Flags:

- `--path <tpl>` — override the path template.
- `--schema <file>` — embed a JSON Schema file at `[gitsheet.schema]`.
- `--force` — overwrite an existing config.
- `--commit` — the explicit spelling of what `init` does: commit the config to the target ref. When that branch does not exist yet, it is created with a root commit holding only the config ([behaviors/default-branch.md](../behaviors/default-branch.md#bootstrapping)). `--no-commit` is rejected — `init` always commits.

Only a plain branch name is bootstrapped: a `--ref` that does not resolve and is `HEAD`, a `refs/*` name outside `refs/heads/`, a name failing `git check-ref-format --branch`, or a branch that exists only as a remote-tracking ref keeps the usual error (`RefError` `ref_not_found`, or `ConfigError` `config_invalid` for the remote-only case) instead of creating a ref.

```bash
git sheet init users --path='${{ slug }}' --schema=./schemas/user.schema.json
```

### `git sheet merge <theirs> [--into <ours>] [--prefer ours|theirs] [--message <m>] [--dry-run]`

Sheet-aware merge ([behaviors/merge.md](../behaviors/merge.md)): record files changed on both sides are field-merged and written canonically. `--into` defaults to the default branch ([behaviors/default-branch.md](../behaviors/default-branch.md)). Without `--prefer`, any conflict lists every conflicting path (and field) on stderr and exits **1** with nothing written; `--prefer ours|theirs` resolves them. `--dry-run` reports the merged tree hash and moves nothing. Prints the outcome and the merge commit on success.

### `git sheet merge --install-driver`

Registers the merge driver ([behaviors/merge.md](../behaviors/merge.md#merge-driver)) so plain `git merge` / `rebase` / `cherry-pick` field-merge record files: sets `merge.gitsheets.name` and `merge.gitsheets.driver` in the repository's git config, and adds a `<root>/**/*<ext> merge=gitsheets` line per sheet discovered at `HEAD` to the working tree's `.gitattributes` (existing lines are kept; re-running adds nothing). Does not commit `.gitattributes`. In a bare repository, sets the config and prints the attribute lines. `<theirs>` is not accepted together with `--install-driver`.

### `git sheet merge-driver <base> <ours> <theirs> <path>`

The git merge driver ([behaviors/merge.md](../behaviors/merge.md#merge-driver)). Resolves the sheet owning `<path>` from `HEAD`'s configs, field-merges the three files, writes the canonical result over `<ours>`, exits 0. On a field conflict it writes git's own text merge (`git merge-file` markers) and exits 1. A `<path>` under no sheet is text-merged the same way. Install with `git config merge.gitsheets.driver "git sheet merge-driver %O %A %B %P"` and a `.gitattributes` `merge=gitsheets` pattern.

### `git sheet contracts <subcommand>`

Manage schema contracts ([behaviors/contracts.md](../behaviors/contracts.md)). All state these commands write lives under `.gitsheets/contracts/`; sheet configs are never rewritten by tooling — adding a name to `implements` is the author's edit.

#### `git sheet contracts adopt <source> [--sheet <name>]...`

Read a contract document from `<source>` (local file path or HTTPS URL; JSON or TOML), enforce the [document requirements](../behaviors/contracts.md#contract-document-requirements), canonicalize, and vendor it at its derived path. Records provenance in `.gitsheets/contracts/sources.toml`. With `--sheet`, also validates **every existing record** of each named sheet against the new effective schema and refuses adoption (per-record issues on stderr) until the data conforms — the author adds the name to `implements` only after adopt succeeds.

```bash
git sheet contracts adopt https://raw.githubusercontent.com/org/contracts/main/meals/v1.schema.json --sheet meal-bank
git sheet contracts adopt ./meals-v1.schema.json
```

#### `git sheet contracts verify [<sheet>]...`

Offline conformance gate (CI-friendly; no network). For the named sheets (default: all declaring sheets): every declared name resolves to a vendored document; each document satisfies the document requirements, is byte-canonical, and its `$id` matches its path; every record validates against the sheet's effective schema. Warns when a declaring sheet's local schema sets `additionalProperties: false`. A sheet whose config fails to open — including a path template naming a field the effective schema does not require ([behaviors/path-templates.md](../behaviors/path-templates.md#template-fields-must-be-schema-required)) — is a failure, reported with the config error. Non-zero exit on any failure.

#### `git sheet contracts test <sheet> --against <file-or-name>`

Consumer-side structural check (rung 2 of [consumer verification](../behaviors/contracts.md#consumer-verification)) from the CLI: validate `<sheet>`'s records against an arbitrary contract document (a file, or the name of a vendored contract). Reports conformance per record; non-zero exit on failure. Works against sheets that declare nothing — duck typing.

#### `git sheet contracts sync [<name>]...`

Re-fetch each contract's recorded source and report drift between upstream and vendored bytes. **Never rewrites a vendored contract** — published versions are immutable; upstream drift is a finding to investigate, not a change to pull.

#### `git sheet contracts export <name>`

Emit the vendored contract as interchange JSON on stdout, for the wider JSON Schema toolchain.

#### `git sheet contracts prune [--dry-run]`

List (and with confirmation, remove) vendored documents no sheet declares.

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
| 67 | `ContractError` |
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
