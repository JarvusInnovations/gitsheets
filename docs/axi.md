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
| Default output | JSON / pretty per `--format` | **TOON** (~40% fewer tokens), `--format=json` opt-out |
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

`--format=json` opts back to JSON for agents / pipelines that prefer it.

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
gitsheets-axi aggregate <sheet> --agg …  # count/sum/min/max/avg/distinct, --group-by
gitsheets-axi read <sheet> <path>        # single record detail
gitsheets-axi upsert <sheet>             # create or replace (idempotent)
gitsheets-axi patch <sheet> <q> <p>      # RFC 7396 merge patch (idempotent)
gitsheets-axi delete <sheet> <path>      # remove a record (idempotent)
gitsheets-axi check <sheet> <file>       # verify + optionally --fix
gitsheets-axi diff <sheet> [<src-ref>]   # TOON change summary
gitsheets-axi normalize <sheet>          # bulk re-canonicalize
gitsheets-axi init <sheet>               # scaffold a starter config
gitsheets-axi infer <sheet>              # observe records → schema
gitsheets-axi migrate-config <sheet>     # pre-v1.0 [fields] → [schema]
gitsheets-axi attachment <list|get|set|delete> <sheet> <path> [<name>]
gitsheets-axi push                       # one-shot git push
gitsheets-axi setup hooks                # install opt-in SessionStart hooks
```

Every command supports `--help` with its specific flags and 2-3 examples.

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

Stable codes the agent can switch on: `VALIDATION_FAILED`, `NOT_FOUND`, `CONFIG_INVALID`, `NOT_CANONICAL`, `INDEX_CONFLICT`, `NOT_A_REPOSITORY`, `INVALID_JSON`, `PATH_TEMPLATE_ERROR`, `REF_ERROR`, `TRANSACTION_ERROR`, `CONFIG_EXISTS`, `NO_RECORDS`, `WRITE_ERROR`, `NON_FAST_FORWARD`, `PUSH_FAILED`, `AGGREGATION_FAILED`.

Exit codes are stable: `0` for success (incl. no-ops), `2` for validation/usage errors, `1` for everything else.

## See also

- [API reference](api.md) — the library both tools share
- [CLI reference](cli.md) — the human `gitsheets` / `git sheet` CLI
- [Concepts](concepts.md) — Repository, Sheet, Path Template, Transaction
- [AXI specification](https://github.com/kunchenguid/axi) — the 10 ergonomic principles
- [TOON specification](https://toonformat.dev/) — the output format
