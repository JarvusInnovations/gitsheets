# gitsheets-axi reference

`gitsheets-axi` is the **agent-facing** companion to `gitsheets`. Same underlying library, different ergonomics: TOON output by default, errors on stdout, idempotent mutations, format-aware schemas, self-installing session hooks.

**Use `gitsheets-axi` when an agent is reading or mutating gitsheets data via shell execution.** Use the `gitsheets` library (TypeScript imports) when authoring code that runs inside an application.

```bash
npm install -g gitsheets-axi    # one-time global install
gitsheets-axi                   # session-aware home view
```

`gitsheets-axi` shares the gitsheets minor version (1.3.x ↔ 1.3.x). Major and minor stay in lockstep; patch versions are independent. The binary self-installs `SessionStart` hooks for Claude Code and Codex on first invocation — once installed, every new agent session sees a TOON home view of the current repo's sheets.

## Output: TOON

[TOON](https://toonformat.dev/) is a compact JSON-like format that's ~40% cheaper in tokens. A `gitsheets-axi query users` invocation looks like:

```
count: 2 of 2 total
records[2]{slug,email,name,path}:
  bob,bob@x.org,Bob Smith,bob
  jane,jane@x.org,Jane Doe,jane
help[1]: Run `gitsheets-axi read users <path>` to view a single record
```

The leading row in a list (`records[2]{slug,email,...}`) declares the column schema; subsequent lines are the rows. Object detail views use `key: value` shape. Help suggestions arrive as `help[N]: ...` lists, one per useful next command.

## Idempotency

Every mutation runs a pre-flight check against the current on-disk state. When the resulting bytes would be identical to what's already there, the command exits 0 with `result: "no-op"` and **no commit is produced**. Re-running the same `upsert` ten times produces one commit (or zero, if the record already exists with those bytes).

This makes agent workflows safe to retry without bookkeeping. An agent that wrote a record, lost connection, and reconnected to re-run the same upsert won't double-commit.

## Errors

All errors go to **stdout** (not stderr — agents typically don't read stderr). Format:

```
error: <human-readable message>
code: <STABLE_CODE>
help[N]: <actionable next-step suggestion>
```

The exit code is `0` for success and `(no-op)`, `2` for validation/usage errors, `1` for everything else. Stable codes include `VALIDATION_FAILED`, `NOT_FOUND`, `CONFIG_INVALID`, `NOT_CANONICAL`, `INDEX_CONFLICT`, `NOT_A_REPOSITORY`, `INVALID_JSON`, `PATH_TEMPLATE_ERROR`, `REF_ERROR`, `TRANSACTION_ERROR`.

## Command surface

### `gitsheets-axi` (bare)

Home view. Repo path + table of sheets (name, format, record count, root) + 2-3 suggested next commands. Runs as the SessionStart hook so this state is in agent context from turn 1.

### `gitsheets-axi sheets [list]`

List sheets configured in the current repo. Same data as the home view, separated command for explicit invocation.

### `gitsheets-axi sheets view <name>`

Single-sheet detail: config summary (root, format, path template), schema property types, record count. Surfaces `body_field` for content-typed sheets.

### `gitsheets-axi query <sheet> [flags]`

List records.

| Flag | Notes |
|---|---|
| `--filter <k>=<v>` | Equality match; repeatable |
| `--fields <list>` | Extra columns beyond the default schema |
| `--limit <n>` | Default 100, max 10000 |
| `--prefix <p>` | Tenant sub-tree scope (matches the library's `prefix` option) |

**Default schema is format-aware:**

- **TOML sheets** — path-template fields + first scalar schema properties, capped at 4 columns.
- **Markdown/MDX sheets** — path-template fields + `title` (if in schema) + `body_size` (byte count). Body content itself never appears in lists — that belongs in `read`.

The summary line `count: N of M total` is always present so agents know when results are paginated.

### `gitsheets-axi read <sheet> <path> [--full]`

Single-record detail. For markdown/mdx sheets, the body field is truncated to ~500 chars with `(truncated, N chars total)` and a `--full` hint. Surfaces `_path` and `_sheet` as plain fields (the `RECORD_PATH_KEY` / `RECORD_SHEET_KEY` Symbol annotations).

### `gitsheets-axi upsert <sheet> [--data <json>] [flags]`

Create or replace a record.

| Flag | Notes |
|---|---|
| `--data <json>` | Record JSON inline. If omitted, reads stdin. |
| `--allow-missing-body` | Content-typed sheets only — opt in to upserting without body field |
| `--prefix <p>` | Tenant scope |
| `--message <m>` | Commit message (default: `<sheet> upsert <path>`) |

**Idempotent:** if the canonical bytes match the existing record, exits 0 with `result: "no-op"` and no commit.

Output on commit:

```
result: committed
sheet: users
path: jane
hash: 4d3f...
commit: a1b2c3...
```

Output on no-op:

```
result: no-op
sheet: users
path: jane
hash: 4d3f...
```

### `gitsheets-axi patch <sheet> <query-json> [--patch <json>] [flags]`

RFC 7396 JSON Merge Patch against the record matched by `<query-json>`. `null` deletes a field, arrays replace, objects merge recursively.

| Flag | Notes |
|---|---|
| `--patch <json>` | Partial JSON. If omitted, reads stdin. |
| `--prefix <p>` | Tenant scope |
| `--message <m>` | Commit message |

**Idempotent.** Same no-op semantics as upsert.

Throws `NOT_FOUND` if the query matches no record.

### `gitsheets-axi delete <sheet> <path> [flags]`

Delete the record at `<path>`.

| Flag | Notes |
|---|---|
| `--prefix <p>` | Tenant scope |
| `--message <m>` | Commit message |

**Idempotent on already-missing.** Agents can call `delete` without checking existence; an already-absent record exits 0 with `result: "no-op"`.

### `gitsheets-axi check <sheet> <file> [--fix]`

Verify a record file in the working tree is parseable, valid against the sheet's schema, and in canonical form. Reads from the working tree (not git). **Never commits.**

| Flag | Notes |
|---|---|
| `--fix` | Rewrite the file in canonical form if not already canonical |
| `--prefix <p>` | Tenant scope |

Designed as a post-edit hook for agents that wrote a record directly:

- With `--fix` (post-edit): `gitsheets-axi check users users/jane.toml --fix` lands the file in canonical form
- Without `--fix` (pre-commit): non-zero exit blocks the commit when the file isn't canonical

Outputs:

- `result: ok` — already canonical
- `result: fixed` — rewritten by --fix
- `NOT_CANONICAL` error (exit 1) when not canonical and --fix wasn't passed
- `VALIDATION_FAILED` (exit 2) when the record fails schema validation
- `CONFIG_INVALID` when the file fails to parse as the sheet's format
- `NOT_FOUND` when the target file doesn't exist

## When to use `gitsheets-axi` vs `gitsheets`

| Scenario | Use |
|---|---|
| Agent is reading/writing records via shell | `gitsheets-axi` |
| Writing TypeScript that imports `gitsheets` | `gitsheets` library |
| Authoring `.gitsheets/<name>.toml` configs | Either (the configs are the same) |
| Building a long-running consumer service | `gitsheets` library (with push daemon) |
| Post-edit / pre-commit hook for record files | `gitsheets-axi check` |
| Interactive human workflow | `gitsheets` (human CLI) |

When in doubt: `gitsheets-axi` for agent shell invocations; `gitsheets` for everything else. Sheet configs (`.gitsheets/*.toml`) are shared — both tools read the same files.

## Hook installation

`gitsheets-axi` self-installs SessionStart hooks on first invocation:

- **Claude Code** — `~/.claude/settings.json` SessionStart entry
- **Codex** — `~/.codex/hooks.json` SessionStart entry + `[features].hooks = true` in `config.toml`

The hook runs `gitsheets-axi` (the bare home view), so every new session opens with a compact view of the current repo's sheets already in context. The install is **self-healing**: every invocation re-checks the hook's binary path and updates it if the executable moved (reinstall, asdf version change).

Disable hooks for the current invocation with `GITSHEETS_AXI_DISABLE_HOOKS=1`.

## See also

- `references/cli.md` — the human-facing `gitsheets` / `git sheet` CLI
- `references/api.md` — the TypeScript library API
- `references/sheet-config.md` — `.gitsheets/<name>.toml` grammar (shared)
