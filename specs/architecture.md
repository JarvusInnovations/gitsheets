# Architecture

Foundational tech decisions for gitsheets v1.0.

## Goal

A git-backed document store for low-volume, high-touch, human-scale data — readable through the JavaScript/TypeScript API and the `git sheet` CLI. The substrate is git itself: each record is a TOML file at a templated path; each mutation is a commit.

Concrete v1.0 ship list lives across [GitHub issues #128–#141 in the 1.0.0 milestone](https://github.com/JarvusInnovations/gitsheets/milestone/1).

## Stack

| Layer | Choice | Why |
| ------- | -------- | ----- |
| Language | **TypeScript** (strict) | Discoverability for consumers; type-flow from `.gitsheets/<sheet>.toml` JSON Schema through to typed `Store.<sheet>.upsert(...)` |
| Module format | **ESM-only** | Modern Node + Bun + edge runtimes all handle ESM. Dual CJS/ESM build deferred until a concrete consumer needs it. |
| Runtime | **Node.js ≥ 20**, **Bun ≥ 1** | Both have native ESM, both can host the CLI. No Deno target in v1.0. |
| Tree primitives | **hologit (JS)** | Provides `TreeObject`, `BlobObject`, repo discovery, in-memory mutable trees, packfile access via the `git` CLI. v1.0–v1.2 stay on the JS substrate; the Rust [holo-tree migration](https://github.com/JarvusInnovations/gitsheets/issues/127) is deferred. |
| TOML | **`@iarna/toml`** | Preserves date types; canonical-sorted keys for byte-stable normalization. |
| Canonical key sort | **`sort-keys`** | Deep alphabetical key sorting on every write for byte-stable normalization. |
| JSON Schema validation | **`ajv`** + **`ajv-formats`** | Industry-standard, well-maintained, fast. Used for the persisted shape contract per [behaviors/validation.md](behaviors/validation.md). `ajv-formats` carries `date-time`, `email`, etc. |
| Runtime validator (consumer-supplied) | Any **[Standard Schema](https://standardschema.dev)** implementation | Consumer chooses Zod / Valibot / ArkType / Effect Schema. Gitsheets calls `~standard.validate`. |
| JSON Merge Patch | **inline** in `src/patch.ts` (~40 lines) | RFC 7396 semantics — see [behaviors/patch-semantics.md](behaviors/patch-semantics.md). No external dependency; the `json-merge-patch` package was removed during the v1.0 substrate purge. |
| JSON Patch (RFC 6902) | **`rfc6902`** | Generates RFC 6902 ops for `Sheet.diffFrom({ patches: true })` (v1.1). |
| Markdown normalization | **`markdownlint`** (pinned `^0.40`) | Body normalization on write for content-typed sheets (v1.2). See [behaviors/content-types.md](behaviors/content-types.md). |
| CSV / TSV I/O | **`csv-parse`** + **`csv-stringify`** | CLI `--format=csv\|tsv` on `upsert` / `query` / `read` (v1.1). |
| Tests | **Vitest** (v4) | TS-native, ESM-native. Replaces Jest + Cypress. |
| CLI argument parsing | **`yargs`** | Clean TS types for command modules. |

### What we deliberately don't use

- **A custom query language.** Records are TOML files; queries are async iterators with in-memory equality predicates. Consumers needing richer filtering iterate and filter in their own code.
- **A built-in HTTP server.** The pre-v1.0 `backend/server.js` is removed. Consumers building APIs around gitsheets build their own HTTP layer.
- **Built-in full-text search.** Out of scope — consumers can build SQLite FTS / Meilisearch / etc. on top.
- **Migration framework.** Schema migrations are one-off scripts that commit to the data repo. Don't generalize.
- **An ORM-style models layer.** `Sheet<T>` is generic over the consumer's record type — no class-based ActiveRecord layer.

## Packaging

- **Single npm package: `gitsheets`** — library + CLI in one. Single `package.json`, single set of dependencies. Splitting into `@gitsheets/core` + `@gitsheets/cli` is deferred until there's a reason.
- **Entry points:**
  - `import { ... } from 'gitsheets'` → public library exports
  - `bin/gitsheets` (also installed as `git-sheet` for the `git sheet <cmd>` invocation)
- **Published artifacts:** built `dist/`, type definitions, source maps. No source TypeScript in the published package.

## Repository layout

```text
gitsheets/
├── src/                      # TypeScript library
│   ├── cli/                  # CLI entry + command modules
│   ├── path-template/        # path template parser + query traversal
│   ├── errors.ts             # exported error classes
│   ├── repository.ts         # Repository class
│   ├── sheet.ts              # Sheet class
│   ├── transaction.ts        # Transaction class
│   ├── store.ts              # openStore + Store type
│   ├── *.test.ts             # Vitest specs co-located with the units they cover
│   └── index.ts              # public re-exports
├── docs/                     # User-facing documentation (mkdocs)
├── specs/                    # ← source of truth, this directory
├── .claude/
│   ├── agents/               # spec-drift-auditor
│   └── commands/             # /audit-spec-drift
├── .github/workflows/        # CI
├── CLAUDE.md
├── package.json
├── tsconfig.json
└── README.md
```

The pre-v1.0 layout (`backend/lib/`, `backend/commands/`, `src/` Vue frontend, `cypress.json`, `vue.config.js`, etc.) is removed during the purge ([issue #128](https://github.com/JarvusInnovations/gitsheets/issues/128)).

## What stays cross-cutting in the library

These belong to the library and are not consumer concerns:

- **TOML serialization** — sorted-key normalization, custom Date handling. Bytes on disk are deterministic for byte-stable git diffs.
- **Path template rendering** — `${{ field }}` and `${{ expression }}` syntax, recursive `${{ field/** }}`, multi-variable per-segment.
- **Tree mutation under the hood** — `tree.writeChild`, `tree.deleteChild`, `tree.getBlobMap` — surfaced via `Sheet` + `Transaction`.
- **Git operations** — commit creation, ref updates, push. Surfaced via `Transaction` + the optional push daemon.
- **Validation orchestration** — JSON Schema → optional Standard Schema → upsert. Errors bubble up as typed exceptions.

## Distribution

- **npm:** `gitsheets` (current owner: themightychris).
- **Versioning:** semver. v1.0.0 is the cut after all `[1.0]`-tagged issues in the [1.0.0 milestone](https://github.com/JarvusInnovations/gitsheets/milestone/1) close. Patch releases inside 1.x preserve the documented API.
- **Breaking changes** — only at major boundaries. The library's pre-1.0 API does not constrain v1.0 (the legacy `GitSheets` class is purged outright; no migration shim).

## Holo-tree migration (deferred post-v1.2)

[Issue #127](https://github.com/JarvusInnovations/gitsheets/issues/127) tracks the swap to a Rust `holo-tree` crate via `napi-rs`. **This is an internal-engine change with no public-API impact** — consumers should not see any difference, only ~100x faster tree operations.

v1.0, v1.1, and v1.2 all shipped on the current JS hologit substrate. The holo-tree migration remains deferred; it's a substantial substrate swap that needs its own focused release. Tracked in [`deferred.md`](deferred.md).
