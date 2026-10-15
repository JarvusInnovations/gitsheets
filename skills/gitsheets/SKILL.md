---
name: gitsheets
description: Use this skill whenever the user is working with `gitsheets` — the git-backed document store on npm. Trigger on mentions of `gitsheets`, `.gitsheets/<name>.toml` configs, sheet path templates with `${{ field }}` syntax, content-typed records (markdown with TOML frontmatter), the `git sheet` / `gitsheets` CLI, `openRepo` / `openSheet` / `openStore` / `repo.transact` API calls, or push-daemon setup. Also trigger when the user shows a TOML record file, asks about validating records with JSON Schema layered with Zod/Valibot, mentions canonical TOML normalization, or asks how to model document-style records (blog posts, knowledge bases) in a git repo. Reach for this skill *before* improvising — gitsheets has a specific API shape and config grammar that's easy to get subtly wrong.
---

# gitsheets

`gitsheets` is a git-backed document store for low-volume, high-touch, human-scale data. Records are TOML files in a git repo (one record per file); the library provides typed reads/writes, validation, transactions, and async push-to-remote. Records can also be **content-typed** (markdown with TOML frontmatter) for documents-as-records.

This skill helps you assist a developer who consumes the published `gitsheets` package — writing TypeScript that calls the library, authoring `.gitsheets/<name>.toml` configs, using the `gitsheets` CLI.

## Routing

Four reference files cover the surface. Read the relevant one(s) for the user's question:

| User is asking about… | Read |
| --- | --- |
| The `gitsheets` / `git sheet` CLI (commands, flags, exit codes) | `references/cli.md` |
| The TypeScript API (`openRepo`, `Sheet`, `Transaction`, `Store`, push daemon, errors) | `references/api.md` |
| Authoring `.gitsheets/<name>.toml` configs (path template, **date-bucket partitioning**, schema, fields, format, indices) | `references/sheet-config.md` |
| The **agent-facing** `gitsheets-axi` CLI (TOON output, idempotent mutations, session hooks) | `references/axi.md` |

If unsure or the question spans multiple surfaces, read all four. They're sized to fit comfortably in context together.

If the user is working *inside an agent session* and wants to read/mutate gitsheets data via shell, prefer `gitsheets-axi` (`references/axi.md`). If they're writing application code, prefer the library API. If they're authoring configs or asking conceptual questions, sheet-config or api references are right.

**Bootstrapping the CLI.** `gitsheets-axi` may not be on `PATH` in a fresh environment where only this skill is installed — that's fine. Run it with no install via `npx -y gitsheets-axi <args>` (e.g. `npx -y gitsheets-axi query users`), or `npm install -g gitsheets-axi` once for a persistent command. Check with `command -v gitsheets-axi`. The human `gitsheets` CLI bootstraps the same way (`npx -y gitsheets …`). So "just install the skill" is a complete starting point — the tools are one `npx` away.

## Always-true facts

These don't change between releases and are worth keeping in mind regardless of the user's question:

- **TypeScript, ESM-only.** `import { ... } from 'gitsheets'` — no CJS `require`. Targets Node ≥ 20 or Bun ≥ 1.
- **Rust-core engine (v2+).** Since v2.0.0 the engine (TOML, normalization, path templates, validation, query, markdown, the whole state machine) is a shared Rust core, shipped as a prebuilt addon (`@gitsheets/core-napi`) for Linux/macOS/Windows — a plain `npm install gitsheets` needs no Rust toolchain. The same core backs a Python binding, so writes are byte-identical across languages. The JS API is unchanged from v1; the one migration is a one-time canonical re-baseline of on-disk bytes (re-normalize with `git sheet normalize`).
- **One record = one file.** Records are individual TOML (or markdown-with-frontmatter) files; the sheet's `path` template renders the filename from record fields. The whole sheet's set of records lives under a per-sheet `root`.
- **Validation is on writes only.** Reads return whatever's on disk. If a schema was tightened after some records were written, those reads can return records that wouldn't pass current validation.
- **Canonical normalization is deterministic.** Object keys are deep-sorted on write; array fields can declare a `sort` rule. Logically-equal records produce byte-identical TOML, so git diffs are meaningful.
- **Mutations go through transactions.** `repo.transact(opts, async tx => …)` is the explicit path. Outside a transaction, standalone Sheet methods (`upsert`, `delete`, `patch`) auto-open one — unless the consumer called `repo.requireExplicitTransactions()`, in which case they throw.
- **Writes land in the git ref, not the working tree.** gitsheets commits records via git plumbing directly to the branch ref; it does **not** update your checked-out files. Right after a write, `git status` shows the new records as *deleted* on disk — the ref has them, the working tree doesn't. `git checkout HEAD -- .` materializes them. This is expected, not data loss.
- **Sheet configs are read from the committed tree.** A freshly-authored `.gitsheets/<name>.toml` is invisible to record commands until it's committed. Commit the config first, then upsert/query.
- **The push daemon is push-only; `repo.sync()` is the explicit reverse path.** The daemon (`repo.startPushDaemon`) pushes new commits with retry/backoff and never pulls. To take in commits other writers pushed, call `repo.sync()` (v2.8+) when *you* decide — boot, webhook, timer: it fetches, then fast-forwards / replays your commits / escapes a conflict to a `conflicts/<ts>` branch, under the write lock.
- **A record carries every field needed to render its path.** Every static path-template field is a `required` schema field (v2.8+ enforces this at `openSheet`; there is no exemption list). Never suggest injecting or stripping path fields in consumer code — put them on the record and in the schema; a child keyed by its parent's handle references the parent through that field.
- **A sheet can be opened read-only at any ref** (`openSheet(name, { ref })`, `openStore(repo, { ref })`, v2.8+) for operator reads of another branch; it never auto-refreshes and rejects writes. Two branches of a data repo merge **record by record** with `repo.merge` / `git sheet merge` (or the `git sheet merge-driver` behind a plain `git merge`), never with a bare `git merge` of TOML text.
- **All gitsheets errors extend `GitsheetsError`** and carry a stable `code` field. Consumers switch on `instanceof` or `err.code`, never on `err.message`. The error classes are: `ConfigError`, `ValidationError`, `TransactionError`, `IndexError`, `RefError`, `PathTemplateError`, `NotFoundError`.

## Common patterns to recommend

When the user is building something, these idioms are usually the right shape:

- **Typed sheets**: combine `openStore(repo, { validators: { users: UserSchema } })` (Standard Schema — Zod / Valibot / ArkType) with a `[gitsheet.schema]` block in the sheet config. The Zod schema flows TS types; the persisted JSON Schema is the on-repo contract.
- **Per-request transactions** in HTTP handlers: open one `repo.transact` per request with the user's identity in `author` + structured `trailers`. Errors thrown from the handler discard the transaction.
- **Date-partitioned sheets**: anything time-series-ish (posts, events, logs, daily rollups) should partition by a declarative **date bucket** in the path template — `path = '${{ publishedAt: YYYY/MM/DD }}/${{ slug }}'` (also `YYYY/MM`, `YYYY`, `YYYY/WW`). It's UTC-safe by construction, and it's what makes **range queries** cheap: `queryAll({ publishedAt: { $gte: '2026-01-01', $lt: '2026-04-01' } })` (or `gitsheets-axi query posts --filter 'publishedAt>=2026-01-01'`) walks only the partitions inside the bounds. See `references/sheet-config.md` → "Date-bucket partitioning" and `references/api.md` → "Range filters".
- **Bulk reads + lazy bodies**: on content-typed (markdown) sheets, pass `{ withBody: false }` to `query` for listing/filtering, then `await sheet.loadBody(record)` when the body is actually needed.
- **Secondary indices**: `sheet.defineIndex('byEmail', { unique: true }, r => r.email.toLowerCase())`. Built lazily on first `findByIndex` call; rebuilt when the underlying tree hash changes. For markdown sheets, index builds always use body-less reads — don't index on body content (returns `undefined` → record excluded).
- **CSV import**: `gitsheets upsert <sheet> records.csv --format=csv` — first row is the header, each subsequent row becomes one record. Cell values stay strings; type coercion belongs in the schema.
- **Bulk ingest a databank**: build a JSON array or NDJSON stream with `jq` (never hand-serialize TOML), then pipe it into **one** `upsert` — `jq -c '.[]' raw.json | gitsheets-axi upsert repos`. The whole batch commits once. To reshape existing data, `gitsheets-axi query <sheet> --ndjson-out`, transform the file, and pipe it back in (exports round-trip verbatim). See `references/axi.md` → "Bulk data engineering".
- **Classify / update in bulk**: use bulk `gitsheets-axi patch` (array/NDJSON of `{<path-fields>, <fields-to-set>}` → one commit, merge-not-replace), not `upsert` (which replaces whole records). `--on-missing skip|insert` tolerates or inserts stale rows; `--dry-run` previews; `--delete-missing` makes the sheet exactly match a source.
- **Review / audit without `jq`**: `gitsheets-axi count <sheet> --filter …` for totals, `query --group-by <field>` for distributions, `distinct <sheet> <field>` for the value set. The `--filter` DSL does comparison / `!=` / `in()` / regex / `:present` / `:empty`, not just equality — and comparisons on a date-bucket path field prune the walk instead of scanning.

## Anti-patterns to redirect

If the user is heading toward one of these, gently steer them back:

- **Treating `Sheet` like a SQL table.** Records are *files* with structured filenames. Path templates uniquely identify a record by its fields; there's no surrogate primary key. If the user wants a stable identifier, design it into the path template.
- **Hand-rolling date partitions with expressions** (`${{ publishedAt.getUTCFullYear() }}/${{ String(publishedAt.getUTCMonth() + 1).padStart(2, '0') }}/…`). Use `${{ publishedAt: YYYY/MM }}` instead: shorter, timezone-safe, and the only form whose range queries prune. Likewise, don't fetch `queryAll({})` and filter dates in consumer code on a partitioned sheet — pass a `{ $gte, $lt }` range so the walk skips the other partitions.
- **Stuffing huge text bodies into a TOML field** when they actually want a markdown document. Switch to content-typed records (`[gitsheet.format] type = 'markdown'`) so the body is a proper file with editor affordances.
- **Indexing on body content.** Indexes always build with body-less reads on markdown sheets — `keyFn(record).body` is `undefined`. Index on frontmatter fields.
- **Shelling out to `git pull` / `fetch` + `update-ref` around gitsheets** to take in another writer's commits. Use `repo.sync({ onConflict })` (v2.8+): it runs under gitsheets' own write lock, replays without a working tree, rebinds live sheets, and reports a structured outcome instead of leaving a half-moved ref.
- **Using `Sheet.upsert(partial)` to update a single field.** `upsert` is a full-record replace. To mutate fields without overwriting the rest, use `sheet.patch(query, partial)` (RFC 7396 — `null` deletes a field, arrays replace).
- **Updating existing records with `upsert` in bulk.** `upsert` replaces the whole record, so a bulk update must re-send every field or silently drop the rest. For updating fields across many records (classifying, tagging, backfilling), use **bulk `gitsheets-axi patch`** (array / NDJSON of combined records → one commit, merge semantics) — emit only the fields you're setting.
- **Looping `upsert` (or `patch`) once per record for a bulk job.** That produces one commit per record (hundreds of junk commits). Both `upsert` and `patch` autodetect a JSON array or NDJSON and process the whole batch in a single commit — pass the stream, don't loop.
- **Merging data branches with a plain `git merge`** (or resolving thousands of delete/modify conflicts by hand with `checkout --theirs`). Line-wise merges leave a mix of serializations; use `git sheet merge <branch> [--prefer ours|theirs]` / `repo.merge()` (v2.8+), or install the merge driver so `git merge` does it.
- **"Injecting" a path field in the service right before upsert** (a tenant key, a parent slug the record "doesn't need"). The field belongs on the record and in the schema's `required` — gitsheets refuses to open a sheet whose template names a non-required field, and there is no exemption list (`injectedFields` was removed in 2.9.0).
- **Hand-serializing TOML to write records.** Never build TOML strings (or reach for a TOML library) to produce records. gitsheets owns serialization, key-sorting, canonical form, and validation. Produce JSON and let `upsert` write the bytes.

## Editing record files directly (post-edit hook)

If you're going to edit gitsheets record files (`.toml` or `.md`) directly on disk rather than through the API, install a post-edit hook that runs `gitsheets-axi check <sheet> $FILE --fix` after each edit. This re-canonicalizes the file (deep-sorted keys, normalized markdown body) and validates against the sheet's schema, catching mistakes immediately rather than at the next git commit. Hook examples in `references/axi.md`.

`gitsheets-axi` is preferred for hook use because its output is TOON on stdout with stable error codes (`VALIDATION_FAILED`, `CONFIG_INVALID`, `NOT_CANONICAL`, etc.) — an agent reading the hook's stdout can switch on the outcome. If it isn't installed, install it (`npm install -g gitsheets-axi`) — a `npx -y` prefix isn't a good fit inside a per-edit hook that fires constantly, so a real install is worth it here. The human `gitsheets check` (`references/cli.md`) is an equivalent fallback when a global install isn't possible.

For CI / pre-commit verification, drop the `--fix`: `gitsheets-axi check <sheet> $FILE` exits non-zero if the file isn't already canonical, without touching it.

## When you genuinely don't know

If the user asks something this skill doesn't cover (an obscure edge case, a behavior across releases, internal mechanics), say so and recommend they check [the gitsheets specs](https://github.com/JarvusInnovations/gitsheets/tree/develop/specs) or [docs site](https://jarvusinnovations.github.io/gitsheets/). Don't guess at API shapes.
