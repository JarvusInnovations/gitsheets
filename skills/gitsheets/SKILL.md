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
| Authoring `.gitsheets/<name>.toml` configs (path template, schema, fields, format, indices) | `references/sheet-config.md` |
| The **agent-facing** `gitsheets-axi` CLI (TOON output, idempotent mutations, session hooks) | `references/axi.md` |

If unsure or the question spans multiple surfaces, read all four. They're sized to fit comfortably in context together.

If the user is working *inside an agent session* and wants to read/mutate gitsheets data via shell, prefer `gitsheets-axi` (`references/axi.md`). If they're writing application code, prefer the library API. If they're authoring configs or asking conceptual questions, sheet-config or api references are right.

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
- **Push is push-only.** The optional push daemon (`repo.startPushDaemon`) pushes new commits to a remote with retry/backoff. It never pulls — the consumer process is the single writer.
- **All gitsheets errors extend `GitsheetsError`** and carry a stable `code` field. Consumers switch on `instanceof` or `err.code`, never on `err.message`. The error classes are: `ConfigError`, `ValidationError`, `TransactionError`, `IndexError`, `RefError`, `PathTemplateError`, `NotFoundError`.

## Common patterns to recommend

When the user is building something, these idioms are usually the right shape:

- **Typed sheets**: combine `openStore(repo, { validators: { users: UserSchema } })` (Standard Schema — Zod / Valibot / ArkType) with a `[gitsheet.schema]` block in the sheet config. The Zod schema flows TS types; the persisted JSON Schema is the on-repo contract.
- **Per-request transactions** in HTTP handlers: open one `repo.transact` per request with the user's identity in `author` + structured `trailers`. Errors thrown from the handler discard the transaction.
- **Bulk reads + lazy bodies**: on content-typed (markdown) sheets, pass `{ withBody: false }` to `query` for listing/filtering, then `await sheet.loadBody(record)` when the body is actually needed.
- **Secondary indices**: `sheet.defineIndex('byEmail', { unique: true }, r => r.email.toLowerCase())`. Built lazily on first `findByIndex` call; rebuilt when the underlying tree hash changes. For markdown sheets, index builds always use body-less reads — don't index on body content (returns `undefined` → record excluded).
- **CSV import**: `gitsheets upsert <sheet> records.csv --format=csv` — first row is the header, each subsequent row becomes one record. Cell values stay strings; type coercion belongs in the schema.
- **Bulk ingest a databank**: build a JSON array or NDJSON stream with `jq` (never hand-serialize TOML), then pipe it into **one** `upsert` — `jq -c '.[]' raw.json | gitsheets-axi upsert repos`. The whole batch commits once. To reshape existing data, `gitsheets-axi query <sheet> --ndjson-out`, transform the file, and pipe it back in (exports round-trip verbatim). See `references/axi.md` → "Bulk data engineering".

## Anti-patterns to redirect

If the user is heading toward one of these, gently steer them back:

- **Treating `Sheet` like a SQL table.** Records are *files* with structured filenames. Path templates uniquely identify a record by its fields; there's no surrogate primary key. If the user wants a stable identifier, design it into the path template.
- **Stuffing huge text bodies into a TOML field** when they actually want a markdown document. Switch to content-typed records (`[gitsheet.format] type = 'markdown'`) so the body is a proper file with editor affordances.
- **Indexing on body content.** Indexes always build with body-less reads on markdown sheets — `keyFn(record).body` is `undefined`. Index on frontmatter fields.
- **Calling `pull` then `push`** to sync. The library has no pull. The single-writer model is non-negotiable; "pull elsewhere, restart consumer" is the canonical reconciliation path.
- **Using `Sheet.upsert(partial)` to update a single field.** `upsert` is a full-record replace. To mutate fields without overwriting the rest, use `sheet.patch(query, partial)` (RFC 7396 — `null` deletes a field, arrays replace).
- **Looping `upsert` once per record for a bulk load.** That produces one commit per record (hundreds of junk commits). `upsert` autodetects a JSON array or NDJSON and imports the whole batch in a single commit — pass the stream, don't loop.
- **Hand-serializing TOML to write records.** Never build TOML strings (or reach for a TOML library) to produce records. gitsheets owns serialization, key-sorting, canonical form, and validation. Produce JSON and let `upsert` write the bytes.

## Editing record files directly (post-edit hook)

If you're going to edit gitsheets record files (`.toml` or `.md`) directly on disk rather than through the API, install a post-edit hook that runs `gitsheets-axi check <sheet> $FILE --fix` after each edit. This re-canonicalizes the file (deep-sorted keys, normalized markdown body) and validates against the sheet's schema, catching mistakes immediately rather than at the next git commit. Hook examples in `references/axi.md`.

`gitsheets-axi` is preferred for hook use because its output is TOON on stdout with stable error codes (`VALIDATION_FAILED`, `CONFIG_INVALID`, `NOT_CANONICAL`, etc.) — an agent reading the hook's stdout can switch on the outcome. The human `gitsheets check` works too and is documented in `references/cli.md`; pick it when `gitsheets-axi` isn't installed in the environment.

For CI / pre-commit verification, drop the `--fix`: `gitsheets-axi check <sheet> $FILE` exits non-zero if the file isn't already canonical, without touching it.

## When you genuinely don't know

If the user asks something this skill doesn't cover (an obscure edge case, a behavior across releases, internal mechanics), say so and recommend they check [the gitsheets specs](https://github.com/JarvusInnovations/gitsheets/tree/develop/specs) or [docs site](https://jarvusinnovations.github.io/gitsheets/). Don't guess at API shapes.
