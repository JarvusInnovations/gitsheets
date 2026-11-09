# API: gitsheets-axi (agent-facing CLI)

## Summary

`gitsheets-axi` is the agent-facing companion CLI to the `gitsheets` library, published as its own npm package (`packages/gitsheets-axi/`) in lockstep with `gitsheets` on the `v*` track ([behaviors/distribution.md](../behaviors/distribution.md)). It drives the same library and the same `.gitsheets/*.toml` configs as the human `git sheet` CLI ([api/cli.md](cli.md)), but follows the [AXI](https://github.com/kunchenguid/axi) conventions for tools an agent calls through a shell:

- **TOON on stdout.** Every result, list, and error is [TOON](https://toonformat.dev/) (Token-Oriented Object Notation): `key: value` objects, `name[N]{col,…}:` tables, and a trailing `help[N]:` list of suggested next commands.
- **Errors on stdout** as `error:` / `code:` / `help[N]:`, with a stable code and a non-zero exit.
- **Idempotent mutations.** Every write pre-flights through `Sheet.willChange` (or an equivalent bytes comparison). When nothing would change, the command exits `0` with `result: no-op` and produces no commit.
- **Minimal default schemas.** List views show a few format-aware columns; `--fields` opts in to more.
- **Live content on bare invocation.** `gitsheets-axi` with no command renders the home view, not usage.

Mutations commit to the repository's default branch through `repo.transact`; they never write the working tree, except `check --fix`, which rewrites a working-tree file and never commits.

## Signature

```text
gitsheets-axi [command] [args] [flags]
gitsheets-axi --help | -v | -V | --version
gitsheets-axi <command> --help
```

The binary is `gitsheets-axi`. A command's `--help` prints a short reference with 2–3 examples; `--help` anywhere in a command's arguments wins over running it. An unknown command is `VALIDATION_ERROR`. The SDK's reserved `update` built-in (self-update) is also available.

### Global flags

Accepted on any command, in any position (before or after the command name), as `--flag value` or `--flag=value`:

| Flag | Meaning |
| --- | --- |
| `--branch <name>` | Bind the repository to this default branch ([behaviors/default-branch.md](../behaviors/default-branch.md)); else `GITSHEETS_BRANCH`, else `gitsheets.branch` git config, else `HEAD`'s branch. A tag, commit, or malformed name is `CONFIG_INVALID` |
| `--submodule <path>` | Submodule mode: read and write this data submodule; each write advances its `HEAD` (the superproject's pointer). Else `GITSHEETS_SUBMODULE`, else `gitsheets.submodule`. A path that is not a submodule is `CONFIG_INVALID`; one not set up yet is `CONFIG_MISSING`, naming `git sheet submodule init <path>` |
| `--stage-pointer` / `--no-stage-pointer` | Submodule mode: also stage the moved gitlink in the superproject index after each commit ([behaviors/default-branch.md](../behaviors/default-branch.md#submodule-mode)). Else `GITSHEETS_STAGE_POINTER`, else the superproject's `gitsheets.stagePointer` git config, else off. A non-boolean value is `CONFIG_INVALID` |
| `--at <superproject-ref>` | Submodule mode: read every sheet pinned at the data snapshot that superproject commit gitlinks; writes are refused. Else `GITSHEETS_AT`. Outside submodule mode it is `CONFIG_INVALID`; a ref with no gitlink for the submodule is `REF_ERROR` |

Per-command flags shared by most commands:

| Flag | Commands | Meaning |
| --- | --- | --- |
| `--prefix <p>` | every command that opens a sheet (`query`, `count`, `distinct`, `aggregate`, `read`, `upsert`, `patch`, `delete`, `rename`, `diff`, `normalize`, `rollup`, `check`, `infer`, `attachment`) | Tenant sub-tree scope, as `openSheet({ prefix })` ([api/repository.md](repository.md#repoopensheetname-opts)) |
| `--message <m>` | every committing command | Commit message; each command has a default naming the sheet and operation |
| `--json-out[=path]`, `--ndjson-out[=path]`, `--csv-out[=path]` | `query` | Side-channel export; see [`query`](#query) |

There is no `--format` flag: stdout is always TOON. A malformed value for any global flag is `VALIDATION_ERROR` (exit 2).

## Semantics

### Sheet resolution

Commands read sheet configs from the **committed** tree of the default branch, never the working tree. When `.gitsheets/<name>.toml` is missing from the committed tree but present in the working tree, the error is `CONFIG_INVALID` with a hint to commit the config first.

### The `--filter` mini-DSL

`query`, `count`, `distinct`, `aggregate`, and bulk `delete` take repeatable `--filter <expr>` clauses, ANDed together. Forms, matched in this order:

| Form | Matches when |
| --- | --- |
| `k:present` | the field is present and non-empty (not absent, `null`, `''`, or `[]`) |
| `k:empty` | the opposite of `k:present` |
| `k in (a,b,c)` | the field's string form is one of the listed values |
| `k!=v`, `k=v` | inequality / equality — numeric for number fields, `true`/`false` for booleans, ISO string for datetimes, string otherwise; an absent field equals `''` |
| `k>=v`, `k<=v`, `k>v`, `k<v` | ordered comparison — numeric for numbers, chronological for datetimes (`v` parsed as a date), lexical otherwise; an absent field never matches |
| `k~regex` | the field's string form matches the JS regular expression |

An unparseable clause or an invalid regex is `VALIDATION_ERROR`. The filter runs host-side as the authoritative predicate over the records the library returns.

**Date-bucket pushdown.** When the sheet's path template partitions by a date bucket (`${{ field: YYYY }}`, `YYYY/MM`, `YYYY/MM/DD`, `YYYY/WW`), ordered clauses on that field whose bound is a date-only ISO string or a datetime with an explicit offset or `Z` are also passed to `Sheet.query` as a range filter, so the core prunes the walk to the bounded span of partitions ([behaviors/path-templates.md § Range-pruned traversal](../behaviors/path-templates.md#range-pruned-traversal)). An offset-less datetime bound is not pushed down (host and core would read it in different zones). At most one bound per side is pushed down. Pushdown never changes results: the host predicate still filters what comes back.

### Body-less reads on content-typed sheets

On a markdown or mdx sheet, `query`, `count`, and `distinct` read records **body-less** (frontmatter only — [behaviors/content-types.md § Lazy body loading](../behaviors/content-types.md#lazy-body-loading)) unless a `--filter` clause targets the body field, `--fields` names it, or an export flag is set (an export's contract is the verbatim record). `aggregate` is always body-less; a filter on the body field there is `VALIDATION_ERROR`. `read` loads one record with its body.

### The materialize hint

After a commit from `upsert`, `patch`, `delete`, or `rename`, the output carries a hint when the write left the working tree behind: the default branch is the branch `HEAD` points at, no submodule mode, and the command ran inside a working tree. The hint leads with the lasting fix (a headless layout: `--branch data` or `--submodule data`) and offers `git checkout HEAD -- .` as the stopgap. A write to a bound data branch or a data submodule shows no hint, since it touched no checked-out branch.

### Commands

#### Home (bare invocation)

`gitsheets-axi` with no command lists the repository (`repo:`) and a `sheets` table (`name`, `format`, `records`, `root`), sorted by name, with suggested next commands. A sheet whose config fails to load still gets a row (with a zero count). Outside a git repository it prints `status: no gitsheets repo here` with hints and exits `0`. This is the view the session hooks inject.

#### `sheets`

- `sheets` / `sheets list` — every configured sheet, as in the home view.
- `sheets view <name>` — one sheet's `name`, `root`, `format`, `path` template, `path_fields`, record count, and `body_field` (content-typed sheets), plus its schema properties with types, formats, enums, and required markers.

#### `query`

`query <sheet> [--filter expr …] [--fields a,b] [--sort f [--desc]] [--limit n] [--group-by f] [--prefix p] [export flags]`

- Lists matching records as a `records` table, `count: <shown> of <matched> total`, plus each record's `path`.
- Default columns are format-aware: on TOML sheets the path-template fields plus the first scalar fields (capped at 4); on markdown sheets the path fields, the title field, and `body_size`. `--fields` appends columns.
- `--sort` orders by a field (missing values last); `--desc` reverses.
- `--limit` caps the stdout preview (default 100, clamped to 1–10000). Rows hidden by the limit are reported in a hint.
- `--group-by <field>` replaces the record list with `{value,count}` facets over the whole matched set, biggest first. It is computed host-side, not through `aggregate`: any value kind groups (datetimes by ISO string), and records missing the field count under the empty value.
- **Export.** `--json-out`, `--ndjson-out`, or `--csv-out` additionally writes **every** matched record (ignoring `--limit`; sorted when `--sort` is given) to a file and reports `wrote`, `rows`, `cols`, and `columns`. A bare flag writes an owner-only (`0600`) file under the OS temp dir; `=path` writes there. JSON and NDJSON are verbatim records with no injected fields, so they round-trip into `upsert`; CSV is flat (nested values JSON-encoded) and lossy. Stdout stays the TOON preview.

#### `count`

`count <sheet> [--filter expr …] [--prefix p]` — the number of matching records. With no filter it counts candidate record paths without parsing records (`sheet.count()`); with a filter it scans body-less records.

#### `distinct`

`distinct <sheet> <field> [--filter expr …] [--prefix p]` — each distinct value of `<field>` over the matched records with its count, sorted alphabetically by value. (`query --group-by` gives the same facets by count.)

#### `aggregate`

`aggregate <sheet> --agg <name>=<form>[:<field>] … [--group-by f] [--filter expr …] [--prefix p]` — named aggregates computed in the core by `sheet.aggregate` ([behaviors/aggregation.md](../behaviors/aggregation.md)). Forms: `count`, or `sum` / `min` / `max` / `avg` / `distinct` over a field. `--agg` is repeatable and at least one is required; a name given twice is `VALIDATION_ERROR`. `--group-by` applies `groupBy` to every aggregate. The `--filter` clauses pick the records host-side (with date-bucket pushdown as above); the core folds over exactly those. `reduce` is library-only. A malformed spec or a body-field clause is `VALIDATION_ERROR`; a data-dependent failure (mixed kinds under `min` / `max` / `distinct`) is `AGGREGATION_FAILED`. Output: `sheet` and a `results` object.

#### `read`

`read <sheet> <path> [--full] [--prefix p]` — one record by its rendered path (a trailing `.toml` / `.md` / `.mdx` is stripped), as a single blob read through `sheet.get` with no scan. All fields are shown; on a content-typed sheet the body is truncated to about 500 characters unless `--full`. No record at the path is `NOT_FOUND`.

#### `upsert`

`upsert <sheet> [--data <json>] [--delete-missing] [--dry-run] [--allow-missing-body] [--prefix p] [--message m]`

- Input is `--data` or stdin: a single JSON object, a JSON array, or NDJSON (auto-detected). Unparseable input is `INVALID_JSON`.
- A batch upserts in **one** commit. Unchanged records are skipped; a batch where nothing changed is `result: no-op` with no commit.
- One invalid record aborts the whole batch (nothing committed) and names the row; `--dry-run` reports every row's outcome (`will-change`, `no-op`, `invalid`, and `delete` with `--delete-missing`) without committing.
- `--delete-missing` also deletes existing records not in the input set, in the same commit (an exact re-sync).
- `--allow-missing-body` maps to `upsert`'s `allowMissingBody` ([api/sheet.md](sheet.md#sheetupsertrecord-opts)).

#### `patch`

- **Single:** `patch <sheet> <query-json> [--patch <json>]` (the patch from stdin when `--patch` is omitted) applies an RFC 7396 merge patch to the record matching the query ([behaviors/patch-semantics.md](../behaviors/patch-semantics.md)). No match is `NOT_FOUND`; an unchanged result is `result: no-op`.
- **Bulk:** `patch <sheet> [--data <json>]` with no query reads a JSON array or NDJSON of combined records: the sheet's path-template fields form each row's query, the remaining fields its patch. Every row runs in **one** transaction and one commit, preflighted inside it with pruned lookups on the transaction's tree. `--on-missing abort` (default) aborts the batch when a row matches nothing (`NOT_FOUND`), `skip` drops such rows, `insert` upserts them as new records. `--delete-missing` deletes records no row targeted. `--dry-run` reports `will-change`, `no-op`, `missing`, `invalid`, and `delete` counts and discards the transaction. Batches over 200 rows print progress to stderr every 100 rows.

#### `delete`

- **Single:** `delete <sheet> <path>`. An already-missing record is `result: no-op`, not an error.
- **Bulk:** `delete <sheet> --filter expr …` (every match) or `delete <sheet> --stdin` (one id or path per line), never both. All deletions land in **one** commit; `--dry-run` reports the count without committing; nothing to delete is `result: no-op`.

#### `rename`

`rename <sheet> <old-path> <new-path>` re-keys a record — reads it at `<old-path>`, writes it at `<new-path>`, and deletes the old one in one commit (`result: renamed`). Supported only for a bare single-field path template (`${{ field }}`); any other template is `VALIDATION_ERROR` pointing at `patch`. A missing `<old-path>` is `NOT_FOUND`; an existing `<new-path>` is `VALIDATION_ERROR` (never overwrites).

#### `diff`

`diff <sheet> [<src-ref>] [--patches] [--limit n] [--prefix p]` — `sheet.diffFrom(<src-ref>)` as a table of `status` (`added` / `modified` / `deleted` / `renamed`), `path`, `srcHash`, `dstHash`; `--patches` adds RFC 6902 ops per change. `<src-ref>` defaults to the empty tree (every record `added`). `--limit` defaults to 1000. An unresolvable ref is `REF_ERROR`.

#### `normalize`

`normalize <sheet>` re-validates and re-serializes every record and writes back those whose canonical bytes differ, in one commit; all already canonical (or an empty sheet) is `result: no-op`.

#### `rollup`

`rollup <sheet> [--check] [--prefix p] [--message m]` maintains a [rollup sheet](../behaviors/rollups.md). Without `--check` it runs `materialize()` in one transaction and lists each partition as `recomputed` or `deleted` (`result: committed` with the commit, or `result: no-op` when everything was fresh). With `--check` it writes nothing: fresh is `result: fresh`, exit `0`; otherwise `ROLLUP_STALE` (exit `1`) naming each `stale` / `missing` / `orphaned` partition (`sheet.rollupStatus()` — [api/sheet.md](sheet.md#sheetrollupstatus)). A non-rollup sheet is `VALIDATION_ERROR`. Any write to a rollup sheet through another command is `SHEET_DERIVED`.

#### `init`

`init <sheet> [--path <template>] [--schema <file>] [--force] [--message m]` commits a starter `.gitsheets/<sheet>.toml` with `root = <sheet>`, the path template (default `${{ id }}`), and the JSON schema file's contents as `[gitsheet.schema]`. A config with identical bytes is `result: no-op`; a differing existing config is `CONFIG_EXISTS` unless `--force` (then `result: overwritten`; a new one is `result: created`). A missing schema file is `NOT_FOUND`; one that is not JSON is `INVALID_JSON`.

#### `infer`

`infer <sheet>` walks every record, infers each field's type, marks fields present in every record `required`, and commits the result as the config's `[gitsheet.schema]`. A sheet with no records is `NO_RECORDS`; no config is `NOT_FOUND`; an identical inferred schema is `result: no-op`.

#### `migrate-config`

`migrate-config <sheet>` rewrites a pre-v1.0 `[gitsheet.fields]` block into `[gitsheet.schema]` (type / enum / default move into JSON Schema properties; sort rules stay on the field; `trueValues` / `falseValues` are dropped with a warning) and commits it. No `[gitsheet.fields]` block, or identical bytes, is `result: no-op`.

#### `attachment`

- `attachment list <sheet> <path>` — the record's attachments (`name`, `mime_type`, `hash`).
- `attachment get <sheet> <path> <name>` — metadata plus base64-encoded content, capped at 64 KiB unless `--full`. Missing is `NOT_FOUND`.
- `attachment set <sheet> <path> <name> [--file f | --data <text>]` (or bytes on stdin) — sets the attachment in one commit; identical bytes are `result: no-op`.
- `attachment delete <sheet> <path> [<name>]` — deletes one attachment, or all of the record's when `<name>` is omitted; nothing to delete is `result: no-op`.

See [behaviors/attachments.md](../behaviors/attachments.md).

#### `contracts`

Read-only views of [contracts](../behaviors/contracts.md); adopting, syncing, or pruning vendored contracts stays with the human `git sheet contracts` CLI.

- `contracts` / `contracts list` — every vendored contract under `.gitsheets/contracts/` (name, canonical hash, declaring sheets) and every sheet's `implements`.
- `contracts verify [<sheet>…]` — the offline producer gate: for each sheet declaring `implements` (default: every sheet), resolve every named contract and validate every record against it and the sheet's own schema. Per-sheet outcome `ok` / `warning` / `failed` / `skipped`; any `failed` is `CONTRACT_UNSATISFIED` (exit `1`).
- `contracts test <sheet> --against <file-or-name>` — rung-2 (structural) consumer verification of every record against a JSON / TOML schema file or a vendored contract name, whether or not the sheet declares it. Conforming is `result: conforms`; failure is `CONTRACT_UNSATISFIED`.

#### `check`

`check <sheet> <file> [--fix] [--prefix p]` verifies a **working-tree** record file: parse it with the sheet's format, validate it against the schema, and compare it with its canonical serialization. Canonical is `result: ok`; with `--fix` a non-canonical file is rewritten in place (`result: fixed`); without it, `NOT_CANONICAL`. Never commits. Built as a post-edit hook for agents that wrote a record file directly. A file that fails to parse is `CONFIG_INVALID`; a schema failure is `VALIDATION_FAILED`; an unreadable file is `NOT_FOUND`; a failed rewrite is `WRITE_ERROR`.

#### `push`

`push [--remote r]` runs `git push <remote> <default branch>` once (remote default `origin`). Already up to date is `result: no-op`; success is `result: pushed`. A rejected non-fast-forward is `NON_FAST_FORWARD` (never force-pushes); any other failure is `PUSH_FAILED`; a detached-`HEAD` binding is `REF_ERROR`. Not a daemon: retry-with-backoff belongs to `repo.startPushDaemon` ([behaviors/push-sync.md](../behaviors/push-sync.md)).

#### `setup hooks`

`setup hooks` installs or repairs **opt-in** `SessionStart` hooks for Claude Code, Codex, and OpenCode that run the home view at session start. Idempotent; re-running repairs a stale executable path. Nothing is installed implicitly. A failed install is `HOOK_INSTALL_FAILED`. Any other `setup` action is `VALIDATION_ERROR`.

### Exit codes

| Exit | When |
| --- | --- |
| `0` | Success, including `result: no-op`, `result: fresh`, `check` ok / fixed, and home outside a repository |
| `2` | `VALIDATION_ERROR` — a usage error: unknown command or flag, missing argument, malformed `--filter` / `--agg`, a command applied to the wrong kind of sheet |
| `1` | Every other error code |

## Errors

Every error prints `error: <message>`, `code: <CODE>`, and an optional `help[N]:` list to **stdout**. Codes are stable; agents switch on `code`, never on the message.

| Code | Source |
| --- | --- |
| `VALIDATION_ERROR` | Usage errors (exit `2`) — see [Exit codes](#exit-codes) |
| `VALIDATION_FAILED` | `ValidationError` — a record failed the sheet's JSON Schema or contract; the first issue is in the message, the rest in `help` |
| `NOT_FOUND` | `NotFoundError`, or a command's own missing record / attachment / file |
| `CONFIG_MISSING` | Submodule mode: the data submodule is not set up |
| `CONFIG_INVALID` | Any other `ConfigError`: a malformed or missing sheet config, a config committed nowhere but the working tree, a bad `--branch` / `--submodule` binding |
| `CONFIG_EXISTS` | `init` would overwrite a differing config without `--force` |
| `INVALID_JSON` | Unparseable `--data` / stdin / `--patch` / `--schema` input |
| `NO_RECORDS` | `infer` on an empty sheet |
| `NOT_A_REPOSITORY` | No git repository at the working directory |
| `NOT_CANONICAL` | `check` without `--fix` on a non-canonical file |
| `INDEX_CONFLICT` | `IndexError` |
| `PATH_TEMPLATE_ERROR` | `PathTemplateError` |
| `REF_ERROR` | `RefError`; `push` on a detached-`HEAD` binding |
| `SHEET_DERIVED` | A write to a rollup sheet (`TransactionError` `sheet_derived`) |
| `TRANSACTION_ERROR` | Any other `TransactionError` |
| `ROLLUP_STALE` | `rollup --check` found partitions that are not fresh |
| `AGGREGATION_FAILED` | `AggregationError` |
| `CONTRACT_MISSING`, `CONTRACT_INVALID`, `CONTRACT_UNSATISFIED` | `ContractError`, by its code |
| `WRITE_ERROR` | `check --fix` could not write the file |
| `NON_FAST_FORWARD`, `PUSH_FAILED` | `push` |
| `HOOK_INSTALL_FAILED` | `setup hooks` |
| `UNKNOWN_ERROR` | An unexpected non-gitsheets error |

A `GitsheetsError` with no dedicated mapping surfaces its library code upper-cased ([api/errors.md](errors.md)).

## Examples

```text
$ gitsheets-axi query repos --filter status=unclassified --sort slug --limit 2
count: 2 of 37 total
records[2]{slug,status,path}:
  alpha,unclassified,alpha
  beta,unclassified,beta
help[2]:
  Run `gitsheets-axi read repos <path>` to view a single record
  35 records hidden by --limit 2; raise --limit or use --json-out to capture all

$ gitsheets-axi upsert users --data '{"slug":"jane","email":"jane@x.org"}'
result: no-op
sheet: users
path: jane
hash: 5e1c…

$ jq -c '.[]' classify.json | gitsheets-axi patch repos --on-missing skip
$ gitsheets-axi rollup transactions-monthly --check
$ gitsheets-axi --branch data aggregate tx --agg total=sum:amountCents --group-by status
```

## Coordinates with

- [api/cli.md](cli.md) — the human `git sheet` CLI over the same configs
- [api/sheet.md](sheet.md) — `query`, `count`, `get`, `willChange`, `aggregate`, `materialize`, `rollupStatus`, `diffFrom`
- [api/repository.md](repository.md) — `openRepo` bindings, `transact`, `openSheet({ prefix })`
- [api/errors.md](errors.md) — the library codes the AXI codes translate
- [behaviors/default-branch.md](../behaviors/default-branch.md) — `--branch`, `--submodule`, the materialize hint's premise
- [behaviors/path-templates.md](../behaviors/path-templates.md) — date-bucket range pruning
- [behaviors/content-types.md](../behaviors/content-types.md) — body-less reads
- [behaviors/aggregation.md](../behaviors/aggregation.md), [behaviors/rollups.md](../behaviors/rollups.md)
- [behaviors/patch-semantics.md](../behaviors/patch-semantics.md), [behaviors/attachments.md](../behaviors/attachments.md), [behaviors/contracts.md](../behaviors/contracts.md)
- [behaviors/distribution.md](../behaviors/distribution.md) — lockstep publishing on `v*`
- `docs/axi.md` — the user guide
