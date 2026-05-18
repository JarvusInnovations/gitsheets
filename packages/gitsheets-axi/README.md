# gitsheets-axi

Agent-facing CLI for [`gitsheets`](https://www.npmjs.com/package/gitsheets) — designed with the [AXI](https://github.com/kunchenguid/axi) (Agent eXperience Interface) ergonomic standards.

Same underlying library as the human `gitsheets` CLI, different ergonomics:

- **TOON output** by default — ~40% fewer tokens than equivalent JSON
- **Idempotent mutations** — re-running with unchanged state returns `result: "no-op"`, no commit
- **Errors on stdout** with stable codes and actionable hints
- **Self-installing session hooks** for Claude Code and Codex

```bash
npm install -g gitsheets-axi
gitsheets-axi              # session-aware home view
```

Requires Node.js ≥ 20 and a `gitsheets`-managed git repository. Lockstep-versioned with the `gitsheets` library on minor (`gitsheets-axi@1.3.x` ↔ `gitsheets@1.3.x`).

## When to use this vs. `gitsheets`

| Scenario | Use |
|---|---|
| Agent reading or mutating records via shell | `gitsheets-axi` |
| Writing TypeScript that imports the library | [`gitsheets`](https://www.npmjs.com/package/gitsheets) |
| Authoring `.gitsheets/<name>.toml` configs | Either (configs are shared) |
| Post-edit / pre-commit hook for record files | `gitsheets-axi check` |
| Interactive human workflow | `gitsheets` (human CLI) |

## Commands

```text
gitsheets-axi                            # home view (bare invocation)
gitsheets-axi sheets [list|view <name>]
gitsheets-axi query <sheet> [--filter k=v ...] [--fields ...] [--limit n]
gitsheets-axi read <sheet> <path> [--full]
gitsheets-axi upsert <sheet> [--data <json>] [--allow-missing-body]
gitsheets-axi patch <sheet> <query-json> [--patch <json>]
gitsheets-axi delete <sheet> <path>
gitsheets-axi check <sheet> <file> [--fix]
gitsheets-axi diff <sheet> [<src-ref>] [--patches]
gitsheets-axi normalize <sheet>
gitsheets-axi init <sheet> [--path <template>] [--schema <file>] [--force]
gitsheets-axi infer <sheet>
gitsheets-axi migrate-config <sheet>
gitsheets-axi attachment <list|get|set|delete> <sheet> <path> [<name>]
gitsheets-axi push [--remote r] [--branch b]
```

Run any command with `--help` for its flags + examples. Every command runs `--help` against itself, not the top-level manual.

## Idempotency contract

Every mutation pre-flights against the current on-disk state. When the resulting bytes would match what's already there, the command exits `0` with `result: "no-op"` and **produces no commit**. Agents can re-run workflows after disconnects, retries, or partial failures without double-committing.

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

## Session hooks

On first invocation, `gitsheets-axi` installs `SessionStart` hooks into:

- **Claude Code** — `~/.claude/settings.json`
- **Codex** — `~/.codex/hooks.json` + `[features].hooks = true` in `config.toml`

The hook runs the bare home view at every session start, so the agent sees the current repo's sheets in its initial context. The install **self-heals** — every invocation re-checks the hook's binary path and updates it if the executable moved.

Set `GITSHEETS_AXI_DISABLE_HOOKS=1` to suppress installation.

## Output: TOON

[TOON](https://toonformat.dev/) (Token-Oriented Object Notation) is the default output:

```text
count: 2 of 2 total
records[2]{slug,email,name,path}:
  bob,bob@x.org,Bob Smith,bob
  jane,jane@x.org,Jane Doe,jane
help[1]: Run `gitsheets-axi read users <path>` to view a single record
```

The leading `records[2]{slug,email,name,path}:` line declares the column schema; each subsequent line is a row. Object detail views use `key: value` shape. Help suggestions arrive as `help[N]: ...` lists, one per useful next command.

## Errors

Errors go to **stdout** (not stderr — agents typically don't read stderr), in the same TOON shape:

```text
error: Record failed validation: slug: must NOT have fewer than 1 characters
code: VALIDATION_FAILED
help[1]: Run `gitsheets-axi sheets view users` to see the schema
```

Stable codes: `VALIDATION_FAILED`, `NOT_FOUND`, `CONFIG_INVALID`, `NOT_CANONICAL`, `INDEX_CONFLICT`, `NOT_A_REPOSITORY`, `INVALID_JSON`, `PATH_TEMPLATE_ERROR`, `REF_ERROR`, `TRANSACTION_ERROR`, `CONFIG_EXISTS`, `NO_RECORDS`, `WRITE_ERROR`, `NON_FAST_FORWARD`, `PUSH_FAILED`.

Exit codes: `0` for success (incl. no-ops), `2` for validation/usage errors, `1` for everything else.

## See also

- [gitsheets on npm](https://www.npmjs.com/package/gitsheets) — the underlying library
- [gitsheets docs](https://jarvusinnovations.github.io/gitsheets/) — concepts, library API, sheet config grammar
- [AXI specification](https://github.com/kunchenguid/axi) — the 10 ergonomic principles this CLI implements
- [TOON specification](https://toonformat.dev/) — the output format

## License

Apache-2.0.
