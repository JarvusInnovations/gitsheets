# gitsheets-axi

`gitsheets-axi` is the agent-facing companion to `gitsheets`. Same library underneath, different ergonomics: TOON output by default, errors on stdout, idempotent mutations, format-aware schemas, and opt-in session hooks installed via `gitsheets-axi setup hooks`.

```bash
npm install -g gitsheets-axi
gitsheets-axi              # session-aware home view in a gitsheets-managed repo
```

`gitsheets-axi` ships lockstep on minor with `gitsheets` (`gitsheets-axi@1.3.x` ↔ `gitsheets@1.3.x`). Patch versions are independent.

## When to use which

The two packages are intentionally separate because the AXI contract disagrees with a human-CLI contract on too many defaults to coexist in one binary without conditional logic at every output site.

| Scenario | Use |
| --- | --- |
| Agent reads/writes records via shell execution | `gitsheets-axi` |
| Writing TypeScript that imports the library | [`gitsheets`](api.md) library |
| Authoring `.gitsheets/<name>.toml` configs | Either (configs are shared) |
| Building a long-running consumer service | `gitsheets` library (with push daemon) |
| Post-edit / pre-commit hook for record files | `gitsheets-axi check` |
| Interactive human workflow | `gitsheets` (human CLI) |

Sheet configs are the shared substrate — both tools read the same `.gitsheets/*.toml` files. Whichever way you read/write the data, the schema, path template, normalization rules, and format are the same.

## What's different from the human CLI

Every difference is in service of agents talking to the CLI through shell execution rather than humans driving it interactively.

| Convention | `gitsheets` (human) | `gitsheets-axi` (agent) |
| --- | --- | --- |
| Errors | stderr, non-zero exit | **stdout** (agents read it), non-zero exit |
| `$ <bin>` with no args | usage / help | **live content** (sheets + counts + suggested actions) |
| Duplicate / no-op mutation | throws `NotFoundError` / similar | **idempotent**, exit 0 with `result: "no-op"` |
| Default output | JSON / pretty per `--format` | **TOON** (~40% fewer tokens); no `--format` flag — `query` has `--json-out` / `--ndjson-out` / `--csv-out` side-channel exports |
| Default schema | every field a human might want | **minimal**, `--fields` opts in to more |
| `--help` | full manual per command | concise reference + 2-3 examples |
| Session-hook install | doesn't touch agent config | **opt-in** SessionStart hooks via `setup hooks` |

## Output: TOON

[TOON](https://toonformat.dev/) (Token-Oriented Object Notation) is the default output format on stdout:

```text
count: 2 of 2 total
records[2]{slug,email,name,path}:
  bob,bob@x.org,Bob Smith,bob
  jane,jane@x.org,Jane Doe,jane
help[1]: Run `gitsheets-axi read users <path>` to view a single record
```

The `records[2]{slug,email,name,path}:` header declares the schema; each subsequent line is a row. Object detail views use `key: value` shape. Suggestions arrive as `help[N]:` lists. TOON saves ~40% on tokens compared to equivalent JSON while staying readable.

stdout is always TOON; there is no `--format` flag. A pipeline that wants
JSON, NDJSON, or CSV uses `query`'s side-channel exports (`--json-out[=path]`,
`--ndjson-out[=path]`, `--csv-out[=path]`), which write the verbatim records
while stdout keeps the TOON summary.

## Idempotency

Every mutation pre-flights against the current on-disk state. When the resulting bytes would match what's already there, the command exits `0` with `result: "no-op"` and **produces no commit**.

```text
$ gitsheets-axi upsert users --data '{"slug":"jane","email":"jane@x.org"}'
result: committed
sheet: users
path: jane
commit: a1b2c3...

$ gitsheets-axi upsert users --data '{"slug":"jane","email":"jane@x.org"}'
result: no-op
sheet: users
path: jane
```

Same goes for `patch`, `delete`, `check --fix`, `normalize`, `init`, `infer`, `migrate-config`, `attachment set`, `attachment delete`, and `push` — re-runs with unchanged input produce no commit.

Under the hood, mutations use the library's [`Sheet.willChange()`](api.md) (added in v1.3) to check whether the canonical bytes would differ from what's already at the rendered path. Re-runnable workflows can safely retry on disconnects without bookkeeping.

## Session hooks

Hooks are **opt-in** (AXI principle 7 — explicit consent, never implicit). Nothing is installed until you run the explicit installer:

```bash
gitsheets-axi setup hooks
```

This installs `SessionStart` hooks into:

- **Claude Code** — `~/.claude/settings.json`
- **Codex** — `~/.codex/hooks.json` + `[features].hooks = true` in `config.toml`
- **OpenCode**

The hook runs the bare home view at every session start, so the agent's initial context already includes a compact view of the current repo's sheets. `setup hooks` is **idempotent and self-repairing** — re-running re-checks each hook's binary path and updates it if the executable moved (reinstall, asdf version change, etc.). Restart your agent session afterward to pick up the ambient context.

## Commands

```text
gitsheets-axi                            # home view (bare invocation)
gitsheets-axi sheets [list|view <name>]  # sheets in this repo
gitsheets-axi query <sheet> [filters]    # list records
gitsheets-axi count <sheet> [filters]    # count matching records
gitsheets-axi distinct <sheet> <field>   # distinct values of a field, with counts
gitsheets-axi aggregate <sheet> --agg …  # count/sum/min/max/avg/distinct, --group-by
gitsheets-axi read <sheet> <path>        # single record detail
gitsheets-axi upsert <sheet>             # create or replace (idempotent)
gitsheets-axi patch <sheet> <q> <p>      # RFC 7396 merge patch (idempotent)
gitsheets-axi rename <sheet> <old> <new> # move a record (and its attachments) to a new path
gitsheets-axi delete <sheet> <path>      # remove a record (idempotent)
gitsheets-axi check <sheet> <file>       # verify + optionally --fix
gitsheets-axi diff <sheet> [<src-ref>]   # TOON change summary
gitsheets-axi normalize <sheet>          # bulk re-canonicalize
gitsheets-axi init <sheet>               # commit a starter config
gitsheets-axi infer <sheet>              # observe records → schema
gitsheets-axi migrate-config <sheet>     # pre-v1.0 [fields] → [schema]
gitsheets-axi attachment <list|get|set|delete> <sheet> <path> [<name>]
gitsheets-axi contracts [list|verify|test] # schema contracts
gitsheets-axi push                       # one-shot git push
gitsheets-axi setup hooks                # install opt-in SessionStart hooks
gitsheets-axi rollup <sheet> [--check]   # materialize / check a rollup sheet
```

Every command supports `--help` with its specific flags and 2-3 examples.
The full contract — every command, flag, and error code — is specified in
[`specs/api/axi.md`](../specs/api/axi.md).

### Default branch

Every command reads and writes the repository's **default branch**: the
global `--branch <name>` flag (accepted on any command, e.g.
`gitsheets-axi query users --branch data`), else `GITSHEETS_BRANCH`, else
the clone's `gitsheets.branch` git config, else the branch `HEAD` points at.
`push` pushes that branch. A tag or malformed name is `CONFIG_INVALID`. See
[Headless data](recipes/headless-data.md) for keeping records on a branch
you never check out.

`--submodule <path>` (any command, any position; else `GITSHEETS_SUBMODULE`,
else `gitsheets.submodule`) reads and writes a data submodule instead. Each
write advances the submodule's `HEAD`, so the superproject's `git status`
shows `modified: data (new commits)` and nothing else. A submodule that is
not set up yet is `CONFIG_MISSING`, with `git sheet submodule init <path>`
as the fix.

`--no-submodule` and `--no-branch` (any command, any position, no value)
opt out of an inherited binding for one run: `--no-submodule` reads and
writes the superproject itself, `--no-branch` the branch `HEAD` points at,
and neither consults the environment variable or git config
(`GITSHEETS_SUBMODULE=data gitsheets-axi query users --no-submodule`). An
empty `GITSHEETS_SUBMODULE=` counts as unset, so the flag is the opt-out.

Two more global flags work with `--submodule` (any command, any position):

- `--stage-pointer` also stages the moved gitlink in the superproject's
  index after each write, so `git commit -a` carries it
  (`--no-stage-pointer` turns it off; else `GITSHEETS_STAGE_POINTER`, else
  the superproject's `gitsheets.stagePointer`, else off).
- `--at <superproject-ref>` (else `GITSHEETS_AT`) reads the data snapshot
  that superproject ref pins (`gitsheets-axi query users --submodule data
  --at v1.2.0`); writes are refused. It is a per-run pin, so it has no git
  config.

A malformed global flag (`--branch` with no value, `--stage-pointer=yes`,
`--no-submodule=data`) is
a `VALIDATION_ERROR` (exit 2), like any other usage error.

After a write, the materialize hint (`git checkout HEAD -- .`) appears only
when the records live on the checked-out branch, where the working tree now
lags the commit. It leads with the lasting fix, a headless layout
(`--branch data` or `--submodule data`). Writes to a bound data branch or a
data submodule show no hint: they touched no checked-out branch.

`query`, `count`, and `distinct` share a `--filter` mini-DSL (`k=v`, `k!=v`,
`k<v`, `k>v`, `k<=v`, `k>=v`, `k~regex`, `k in (a,b)`, `k:present`,
`k:empty`). Ordered comparisons on a **date-bucket path field** (a sheet
whose `path` uses `${{ field: YYYY/MM/DD }}` or another bucket format) with a
date-only or offset-qualified ISO bound are pushed down to the core, which
prunes the tree walk to the bounded span of partitions instead of scanning
every record; results are identical, just faster on large partitioned sheets.

On content-typed (markdown / mdx) sheets the read commands are **body-less by
default**: the TOON preview never shows bodies, so `query`, `count`, and
`distinct` read only frontmatter unless a `--filter` clause targets the body
field, `--fields` names it, or an export flag (`--json-out` / `--ndjson-out`,
whose contract is the verbatim record) is set. `read <sheet> <path>` is a
single blob read by path, not a scan. Bulk `patch` preflights every row inside
the one transaction it commits (pruned lookups on the private tree), prints
progress to stderr every 100 rows for batches over 200, and a `--dry-run`
discards that transaction without committing.

`aggregate <sheet> --agg <name>=<form>[:<field>] … [--group-by f] [--filter …]`
computes named aggregates in the gitsheets core (the same fold as the
library's `sheet.aggregate`): `count`, or `sum` / `min` / `max` / `avg` /
`distinct` over a field, each optionally grouped. Records without a string,
integer, or boolean value for the `--group-by` field don't land in any group.
The `--filter` DSL keeps its exact semantics: the clauses run as one host
predicate that picks the records, and ordered clauses on a date-bucket path
field are also pushed down so the walk prunes; then the core folds over the
picked records. A clause on a markdown sheet's body field is a
`VALIDATION_ERROR` (aggregates read body-less). A field with mixed kinds
under `min`/`max`/`distinct` fails with `AGGREGATION_FAILED`.

`rollup <sheet> [--check] [--prefix p] [--message m]` maintains a
[rollup sheet](recipes/rollups.md). Without `--check` it recomputes every
stale or missing rollup record and deletes orphans in one commit (`result:
no-op`, no commit, when everything is fresh), listing each partition as
`recomputed` or `deleted`. With `--check` it writes nothing and fails with
`ROLLUP_STALE` (exit 1), naming each `stale` / `missing` / `orphaned`
partition. A write to a rollup sheet fails with `SHEET_DERIVED`; a
non-rollup sheet is a `VALIDATION_ERROR`.

`query --group-by <field>` is a separate TOON view, not an `aggregate`
call: `{value,count}` facets biggest-first, computed host-side over the
matched records — any value kind (Dates as ISO strings), records missing the
field counted under the empty value.

## Errors

Errors go to **stdout** (not stderr — agents typically don't read stderr), in the same structured shape:

```text
error: Record failed validation: slug: must NOT have fewer than 1 characters
code: VALIDATION_FAILED
help[1]: Run `gitsheets-axi sheets view users` to see the schema
```

Stable codes the agent can switch on (agents switch on `code`, never on the message):

- `VALIDATION_ERROR` — a usage error: unknown command or flag, missing argument, malformed `--filter` / `--agg` or global flag, a command applied to the wrong kind of sheet. The only code that exits `2`.
- `VALIDATION_FAILED` — a record failed the sheet's JSON Schema or a contract (a data error, not a usage error).
- `NOT_FOUND`, `CONFIG_MISSING` (the data submodule is not set up), `CONFIG_INVALID`, `CONFIG_EXISTS`, `INVALID_JSON`, `NO_RECORDS`, `NOT_A_REPOSITORY`, `NOT_CANONICAL`, `INDEX_CONFLICT`, `PATH_TEMPLATE_ERROR`, `REF_ERROR`, `SHEET_DERIVED`, `TRANSACTION_ERROR`, `ROLLUP_STALE`, `AGGREGATION_FAILED`, `CONTRACT_MISSING` / `CONTRACT_INVALID` / `CONTRACT_UNSATISFIED`, `WRITE_ERROR`, `NON_FAST_FORWARD`, `PUSH_FAILED`, `HOOK_INSTALL_FAILED`, `UNKNOWN_ERROR`.

Exit codes are stable: `0` for success (incl. no-ops), `2` for `VALIDATION_ERROR`, `1` for every other code. See [`specs/api/axi.md`](../specs/api/axi.md#errors) for what raises each code.

## See also

- [API reference](api.md) — the library both tools share
- [CLI reference](cli.md) — the human `gitsheets` / `git sheet` CLI
- [Concepts](concepts.md) — Repository, Sheet, Path Template, Transaction
- [AXI specification](https://github.com/kunchenguid/axi) — the 10 ergonomic principles
- [TOON specification](https://toonformat.dev/) — the output format
