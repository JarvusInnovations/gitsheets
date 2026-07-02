# gitsheets-axi reference

`gitsheets-axi` is the **agent-facing** companion to `gitsheets`. Same underlying library, different ergonomics: TOON output by default, errors on stdout, idempotent mutations, format-aware schemas, and opt-in session hooks installed via `gitsheets-axi setup hooks`.

**Use `gitsheets-axi` when an agent is reading or mutating gitsheets data via shell execution.** Use the `gitsheets` library (TypeScript imports) when authoring code that runs inside an application.

**Getting the tool.** If `gitsheets-axi` isn't already on `PATH`, don't stop — you don't need to install anything to start:

```bash
gitsheets-axi query users            # if it's already installed
npx -y gitsheets-axi query users     # zero-install: runs the published package on demand
npm install -g gitsheets-axi         # optional: install once for a persistent global command
```

`npx -y gitsheets-axi <args>` runs the latest published package with no install step, so a fresh environment that has **only this skill** can use every command below by prefixing `npx -y`. For repeated use in a session, `npm install -g gitsheets-axi` once (then drop the prefix). To check availability: `command -v gitsheets-axi`. Every example in this reference writes the bare `gitsheets-axi` — prefix `npx -y` when it isn't installed.

`gitsheets-axi` shares the gitsheets minor version (1.3.x ↔ 1.3.x). Major and minor stay in lockstep; patch versions are independent. Run `gitsheets-axi setup hooks` once to install opt-in `SessionStart` hooks for Claude Code, Codex, and OpenCode — once installed, every new agent session sees a TOON home view of the current repo's sheets.

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

Single-sheet detail: config summary (root, format, path template), schema property types, record count. Surfaces `body_field` for content-typed sheets. Each schema field renders as `type [required] enum: a|b|c`, so you see allowed enum values (and which fields are required) **before** writing rather than from a rejected upsert.

### `gitsheets-axi query <sheet> [flags]`

List records.

| Flag | Notes |
| --- | --- |
| `--filter <expr>` | Filter clause; repeatable, clauses AND. See the filter DSL below. |
| `--fields <list>` | Extra columns beyond the default schema |
| `--sort <field>` | Sort records by a field (missing values sort last) |
| `--desc` | Sort descending (with `--sort`) |
| `--group-by <field>` | Emit `{value,count}` facets instead of a record list |
| `--limit <n>` | Caps the **stdout preview**. Default 100, max 10000 |
| `--prefix <p>` | Tenant sub-tree scope (matches the library's `prefix` option) |
| `--json-out[=path]` | Also write the **full** result set to a JSON array file |
| `--ndjson-out[=path]` | Also write the full result set to an NDJSON file |
| `--csv-out[=path]` | Also write the full result set to a CSV file (flat, lossy) |

**Filter DSL** (`--filter`, repeatable, AND-combined) — shared by `query`, `count`, `distinct`, and bulk `delete`:

| Form | Meaning |
| --- | --- |
| `k=v` / `k!=v` | equality / inequality |
| `k<v` `k>v` `k<=v` `k>=v` | comparison (numeric for number fields, time for dates, else lexical — ISO dates sort right) |
| `k~regex` | `String(value)` matches the JS regex |
| `"k in (a,b,c)"` | value is one of the listed strings |
| `k:present` / `k:empty` | field exists and is non-empty / is absent, null, `""`, or `[]` |

`--group-by <field>` aggregates over the **filtered** set (ignores `--limit`), biggest bucket first: `groups[K]{value,count}:`.

**Default schema is format-aware:**

- **TOML sheets** — path-template fields + first scalar schema properties, capped at 4 columns.
- **Markdown/MDX sheets** — path-template fields + `title` (if in schema) + `body_size` (byte count). Body content itself never appears in lists — that belongs in `read`.

The summary line `count: N of M total` is always present so agents know when results are paginated.

**Bulk export — the round-trip out of gitsheets.** The `--*-out` flags are a side-channel: stdout stays the token-cheap TOON preview, and the file carries **every matched record** (ignoring `--limit`). A bare flag auto-writes an owner-only (`0600`) file under `$TMPDIR/gitsheets-axi/`; `=path` persists it wherever you point it. At most one export flag per invocation. On write, stdout gains `wrote:` / `columns:` / a `jq` hint so you can compose the follow-up without opening the file:

```
wrote: /tmp/gitsheets-axi/repos-….ndjson
rows: 463
cols: 12
columns[12]: name,visibility,archived,...
help[1]: Run `jq '.name' /tmp/gitsheets-axi/repos-….ndjson` to process all 463 rows
```

`--json-out` and `--ndjson-out` are written **verbatim** (record fields only, no injected keys), so they pipe straight back into `gitsheets-axi upsert` — export → transform → re-import is a clean loop. `--csv-out` is flat (nested values JSON-encoded into their cell): a lossy reporting view, not a round-trip format.

### `gitsheets-axi count <sheet> [--filter expr ...]`

Record count. With no `--filter`, counts candidate tree paths **without parsing** (cheap — the fast path for totals). A filter scans body-less records and reports `count: <matched>` + `of: <total>`. Same filter DSL as `query`. Use this instead of `query … --limit 1 | grep count`.

### `gitsheets-axi distinct <sheet> <field> [--filter expr ...]`

Unique values of `<field>` with counts, sorted alphabetically (`values[K]{value,count}:`). `query --group-by <field>` is the same facets ordered by count. Kills the `--ndjson-out | jq 'group_by'` loop for "what values does this field take?".

### `gitsheets-axi read <sheet> <path> [--full]`

Single-record detail. For markdown/mdx sheets, the body field is truncated to ~500 chars with `(truncated, N chars total)` and a `--full` hint. Surfaces `_path` and `_sheet` as plain fields (the `RECORD_PATH_KEY` / `RECORD_SHEET_KEY` Symbol annotations).

### `gitsheets-axi upsert <sheet> [--data <json>] [flags]`

Create or replace one **or many** records.

| Flag | Notes |
| --- | --- |
| `--data <json>` | Record JSON inline. If omitted, reads stdin. |
| `--delete-missing` | After the batch, delete existing records **not** in the input set (exact re-sync). One commit. |
| `--dry-run` | Preview `{willChange, noOp, invalid, willDelete}` (+ invalid rows) — no commit. |
| `--allow-missing-body` | Content-typed sheets only — opt in to upserting without body field |
| `--prefix <p>` | Tenant scope |
| `--message <m>` | Commit message (default: `<sheet> upsert <path>`) |

**Bulk import — this is the path for loading a databank.** The input shape is autodetected, no flag needed:

- a single JSON object → one record
- a **JSON array** of objects → batch
- **NDJSON** (one compact object per line) → batch

A batch upserts every record in **one transaction that produces ONE commit** — not one commit per record. Feed it a file or a pipe:

```bash
cat repos.array.json | gitsheets-axi upsert repos          # JSON array → one commit
jq -c '.[]' repos.json | gitsheets-axi upsert repos        # NDJSON → one commit
```

**Idempotent, per record.** Each record's canonical bytes are compared against what's on disk; unchanged records are skipped. A batch where nothing changed exits 0 with `result: "no-op"` and no commit. In a batch, a **single invalid record aborts the whole transaction** (nothing committed) and the error names the offending row.

Single-record output on commit:

```
result: committed
sheet: users
path: jane
hash: 4d3f...
commit: a1b2c3...
help[1]: gitsheets committed to the git ref, not your working tree — run `git checkout HEAD -- .` to materialize the record files on disk
```

Batch output:

```
result: committed
sheet: repos
upserted: 5
unchanged: 458
commit: a1b2c3...
help[1]: gitsheets committed to the git ref, not your working tree — run `git checkout HEAD -- .` to materialize the record files on disk
```

Output on no-op mirrors the shape with `result: no-op` and no `commit`.

**`--delete-missing`** makes the sheet exactly match the input set (upsert the batch, delete anything else) — the primitive for a periodic re-sync from a source. **`--dry-run`** validates a whole batch up front and reports `willChange` / `noOp` / `invalid` (with the offending rows) / `willDelete` without committing — use it before a big import instead of finding out about a bad row mid-batch.

> **Working-tree gotcha.** gitsheets writes to the git **ref** via plumbing; it does **not** touch your working tree. Right after a commit, `git status` shows the new records as *deleted* on disk (the ref has them, the working tree doesn't). Run `git checkout HEAD -- .` to materialize them. This surprises every first-time user — it's not data loss.

### `gitsheets-axi patch <sheet> [<query-json>] [flags]`

RFC 7396 JSON Merge Patch — update fields without replacing the whole record. `null` deletes a field, arrays replace, objects merge recursively. Two modes:

| Flag | Notes |
| --- | --- |
| `--patch <json>` | **Single mode**: partial JSON for the record matched by `<query-json>`. If omitted, reads stdin. |
| `--data <json>` | **Bulk mode**: a JSON array / NDJSON of combined records. If omitted, reads stdin. |
| `--on-missing <m>` | Bulk: when a record's query matches nothing — `abort` (default) \| `skip` \| `insert` (upsert it as new). |
| `--delete-missing` | Bulk: delete existing records **not** targeted by the batch (exact re-sync). One commit. |
| `--dry-run` | Bulk: preview `{willChange, insert, noOp, missing, invalid, willDelete}` — no commit. |
| `--prefix <p>` | Tenant scope |
| `--message <m>` | Commit message |

**Single** — explicit query + partial:

```bash
gitsheets-axi patch users '{"slug":"jane"}' --patch '{"name":"Jane O. Doe"}'
```

**Bulk — this is the classification primitive.** Drop the `<query-json>` positional and pass an array / NDJSON of **combined** records. In each record the sheet's **path-template fields** form the query (which record to patch); the **remaining fields** are the merge patch. Every patch runs in **one transaction → one commit**:

```bash
# classify many repos at once — one commit, merge-not-replace
jq -c '.[] | {name, target_team, status}' decisions.json | gitsheets-axi patch repos
```

Prefer bulk `patch` over bulk `upsert` for updates: `upsert` is a full-record *replace* (you must carry every existing field or lose it), while `patch` merges — you emit only the fields you're setting, and untouched fields are safe.

**Idempotent.** Unchanged records are skipped; a batch where nothing changed is a `no-op` with no commit. By default a record whose query matches nothing **aborts the whole transaction** (nothing committed) and names the offending row — but `--on-missing skip` tolerates stale rows (handy re-running a classification pass after new records were ingested) and `--on-missing insert` upserts them as new. Output mirrors bulk `upsert` (`patched:` / `unchanged:` / `skipped:` / the materialize hint).

Single mode throws `NOT_FOUND` if the query matches no record.

### `gitsheets-axi rename <sheet> <old-path> <new-path>`

Re-key a record: read it, write it at `<new-path>`, delete the old one — atomically in **one commit**. Supported for a bare single-field path template (`path = '${{ field }}'`), where `<new-path>` maps directly onto the field's value; refuses to overwrite an existing target, errors on a missing source. For decorated/multi-field templates, use `patch` to change the path fields (or `upsert --delete-missing`). This reads as intent in git history vs. a manual write-new + delete-old.

### `gitsheets-axi delete <sheet> <path> [flags]` · bulk: `delete <sheet> --filter … | --stdin`

Delete the record at `<path>`, or many records at once.

| Flag | Notes |
| --- | --- |
| `--filter <expr>` | Bulk: delete every record matching the filter DSL (repeatable). No `<path>`. |
| `--stdin` | Bulk: delete records named one-per-line on stdin. No `<path>`. |
| `--dry-run` | Bulk: report `willDelete` (of total) — no commit. |
| `--prefix <p>` | Tenant scope |
| `--message <m>` | Commit message |

**Idempotent on already-missing.** Agents can call `delete` without checking existence; an already-absent record exits 0 with `result: "no-op"`. **Bulk delete** removes every matching record in **one commit** (absent ids skipped) — e.g. `delete repos --filter disposition=delete-candidate`. Always `--dry-run` first to confirm the count.

### `gitsheets-axi check <sheet> <file> [--fix]`

Verify a record file in the working tree is parseable, valid against the sheet's schema, and in canonical form. Reads from the working tree (not git). **Never commits.**

| Flag | Notes |
| --- | --- |
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

#### Claude Code post-edit hook

Add to `.claude/settings.json` (project) or `~/.claude/settings.json` (user-wide):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "command": "gitsheets-axi check ${SHEET} \"$FILE\" --fix"
      }
    ]
  }
}
```

Substitute `${SHEET}` with the sheet name. For multi-sheet repos, point the hook at a wrapper script that infers the sheet from `$FILE`'s path (e.g. `users/jane.toml` → `users`).

#### Pre-commit verification

Drop `--fix` for a non-destructive verification — exits non-zero (with structured `NOT_CANONICAL` / `VALIDATION_FAILED` on stdout) when the file isn't already canonical. Suitable for a git pre-commit hook or a CI step that runs over staged record files.

### `gitsheets-axi diff <sheet> [<src-ref>] [--patches]`

TOON change summary between a source ref and the current tree. With no `<src-ref>`, compares against the empty tree — every current record shows as `added`, useful for one-shot snapshots.

Default columns: `status` (added/modified/deleted/renamed), `path`, `src_hash`, `dst_hash`. `--patches` adds an RFC 6902 patch column with the per-change ops as JSON-encoded TOON.

### `gitsheets-axi normalize <sheet>`

Bulk re-canonicalize every record in a sheet. Per-record idempotency via `sheet.willChange` means only records whose canonical bytes differ from disk get rewritten; if every record is already canonical, exits with `result: "no-op"` and no commit.

Use this when migrating sheets to a new schema or after a normalization-rule change in the sheet config. For single-file fixes, `check --fix` is cheaper.

### `gitsheets-axi init <sheet> [--path <template>] [--schema <file>] [--force]`

Scaffold a starter `.gitsheets/<sheet>.toml`. `--path` defaults to `${{ id }}`; `--schema` loads a JSON file and embeds it as the sheet's JSON Schema. Refuses to overwrite an existing config unless `--force` is set; if the rendered config matches the existing one byte-for-byte, returns `result: "no-op"`.

### `gitsheets-axi infer <sheet>`

Walks the sheet's records, observes which fields appear with which types and how often, and writes back a generated `[gitsheet.schema]` block. Fields present in every record become `required`. Idempotent when the inferred schema matches the current config. Errors with `NO_RECORDS` if there's nothing to observe.

### `gitsheets-axi migrate-config <sheet>`

Translates a pre-v1.0 `[gitsheet.fields]` block into the modern `[gitsheet.schema]` block. `type`/`enum`/`default` move into JSON Schema properties; `sort` rules stay on the field (they're a normalization concern, not validation). `trueValues`/`falseValues` are dropped with a warning. No-op when there's no `[gitsheet.fields]` block.

### `gitsheets-axi attachment <subcommand>`

Manage binary blobs colocated with records. Subcommands:

| Subcommand | Flags / Notes |
| --- | --- |
| `list <sheet> <path>` | Table of attachment names + mime types + blob hashes |
| `get <sheet> <path> <name>` | Base64-encoded content + metadata; truncated at ~64 KB unless `--full` |
| `set <sheet> <path> <name> [--file f / --data t / stdin]` | Idempotent on byte-match |
| `delete <sheet> <path> [<name>]` | Delete one (idempotent on already-missing) or all if name omitted |

### `gitsheets-axi push [--remote r] [--branch b]`

One-shot `git push <remote> <branch>` from the repo's git dir. Defaults: `origin`, current HEAD branch. Reports `result: "pushed"` or `result: "no-op"` when the remote is already up to date.

Errors map to:

- `NON_FAST_FORWARD` — remote has work the local doesn't; reconcile externally before retrying
- `PUSH_FAILED` — network/auth/transient; safe to retry

This is **not** a daemon lifecycle command — for retry-with-backoff semantics in a long-running consumer, use `Repository.startPushDaemon` from the library.

### `gitsheets-axi setup hooks`

Explicit, opt-in installer for the agent `SessionStart` hooks (see [Hook installation](#hook-installation)). Installs into Claude Code, Codex, and OpenCode. Idempotent and self-repairing — re-running repairs a stale executable path. `--help` prints usage; any action other than `hooks` exits non-zero with a `VALIDATION_ERROR`. Restart the agent session afterward to pick up the ambient context.

## Bulk data engineering (loading a databank)

Populating a sheet from an external source (a GitHub API dump, a CSV, another system) is the canonical gitsheets job. The path that works:

1. **Author the sheet config, then commit it.** `gitsheets-axi init <sheet>` scaffolds `.gitsheets/<sheet>.toml`; edit the schema, then `git add .gitsheets/<sheet>.toml && git commit`. **You must commit before any record command sees the sheet** — configs are read from the committed tree, not the working tree. (If you skip this, upsert/query return a targeted "commit the config first" error.)
2. **Build a JSON array or NDJSON stream of records** with `jq` — do **not** hand-serialize TOML. gitsheets owns TOML serialization, key-sorting, canonical form, and validation; your job is to produce JSON.
3. **Pipe it into one `upsert`** → one commit for the whole batch:

   ```bash
   jq -c '.[] | {name, visibility, description}' raw.json \
     | gitsheets-axi upsert repos --message "seed repos from GitHub"
   ```

4. **Materialize the working tree** if you want the files on disk: `git checkout HEAD -- .` (gitsheets committed to the ref, not the working tree — see the gotcha under `upsert`).
5. **Round-trip to reshape:** `gitsheets-axi query <sheet> --ndjson-out` → transform the file with `jq` → pipe back into `upsert`. Exported JSON/NDJSON is verbatim, so re-import is clean and idempotent.

**Incrementally classifying / updating records** (adding `target_team`, `status`, etc. to records that already exist) is a **bulk `patch`** job, not upsert:

```bash
# pull the worklist, decide, patch the whole pass in one commit
gitsheets-axi query repos --filter status=unclassified --ndjson-out
# → transform into {name, target_team, status} decisions with jq/logic, then:
jq -c '.[]' decisions.json | gitsheets-axi patch repos --message "classify batch 1"
gitsheets-axi diff repos HEAD~1        # review what changed
gitsheets-axi query repos --filter status=unclassified   # what's left
```

`patch` merges, so you emit only the fields you're setting and the rest of each record is safe — whereas `upsert` would replace the whole record and drop anything you didn't re-send. Idempotency makes each pass re-runnable (already-classified records no-op), and `diff` per batch is your review surface. Re-running a pass after new records were ingested? Add `--on-missing skip`.

**Reviewing / auditing the data** — reach for the analytics commands, not `--ndjson-out | jq`: `count <sheet> --filter …` for totals, `query <sheet> --group-by <field>` for distributions (e.g. `--group-by target_team` → `{archive:110, sencha:49, …}`), `distinct <sheet> <field>` for the value set, and the filter operators (`k<v`, `k!=v`, `"k in (a,b)"`, `k:empty`) for slices like "delete-candidates not pushed since 2022".

**Periodic re-sync from a source** — to make a sheet exactly match an upstream (repos created/archived since last sync), `upsert --delete-missing` (full replace) or `patch --on-missing insert --delete-missing` (merge + insert new + prune gone). Preview with `--dry-run` first. Purge a class of records with `delete --filter <expr>` (again, `--dry-run` first).

Do **not** loop `upsert --data` (or `patch`) once per record — that produces one commit per record (hundreds of junk commits). Pass the whole array/stream to a single `upsert` / `patch`.

## When to use `gitsheets-axi` vs `gitsheets`

| Scenario | Use |
| --- | --- |
| Agent is reading/writing records via shell | `gitsheets-axi` |
| Writing TypeScript that imports `gitsheets` | `gitsheets` library |
| Authoring `.gitsheets/<name>.toml` configs | Either (the configs are the same) |
| Building a long-running consumer service | `gitsheets` library (with push daemon) |
| Post-edit / pre-commit hook for record files | `gitsheets-axi check` |
| Interactive human workflow | `gitsheets` (human CLI) |

When in doubt: `gitsheets-axi` for agent shell invocations; `gitsheets` for everything else. Sheet configs (`.gitsheets/*.toml`) are shared — both tools read the same files.

## Hook installation

Hooks are **opt-in** (AXI principle 7 — explicit consent, never implicit). Nothing is installed until you run the explicit installer:

```bash
gitsheets-axi setup hooks
```

This installs SessionStart hooks into:

- **Claude Code** — `~/.claude/settings.json` SessionStart entry
- **Codex** — `~/.codex/hooks.json` SessionStart entry + `[features].hooks = true` in `config.toml`
- **OpenCode**

The hook runs `gitsheets-axi` (the bare home view), so every new session opens with a compact view of the current repo's sheets already in context. `setup hooks` is **idempotent and self-repairing**: re-running re-checks each hook's binary path and updates it if the executable moved (reinstall, asdf version change). Restart the agent session afterward to pick up the ambient context.

## See also

- `references/cli.md` — the human-facing `gitsheets` / `git sheet` CLI
- `references/api.md` — the TypeScript library API
- `references/sheet-config.md` — `.gitsheets/<name>.toml` grammar (shared)
