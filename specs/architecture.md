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
| TOML parse | **`smol-toml`** | Reads — the hot, memory-sensitive path. `@iarna/toml`'s parser pins large parser buffers in each value (~12× source retained per record); `smol-toml` produces flat strings (~2× retained), eliminating a ~5–6× heap blowup for in-memory consumers. Actively maintained, full TOML 1.0. Date types stay `instanceof Date`. |
| TOML serialize | **`@iarna/toml`** | Writes — preserves the byte-stable canonical form: human-readable triple-quoted multiline strings and literal-quoted strings. (`smol-toml` would escape both to single-line — cosmetic churn, no data change.) Serialization isn't memory-sensitive. |
| Canonical key sort | **`sort-keys`** | Deep alphabetical key sorting on every write for byte-stable normalization. |
| JSON Schema validation | **`ajv`** + **`ajv-formats`** | Industry-standard, well-maintained, fast. Used for the persisted shape contract per [behaviors/validation.md](behaviors/validation.md). `ajv-formats` carries `date-time`, `email`, etc. |
| Runtime validator (consumer-supplied) | Any **[Standard Schema](https://standardschema.dev)** implementation | Consumer chooses Zod / Valibot / ArkType / Effect Schema. Gitsheets calls `~standard.validate`. |
| JSON Merge Patch | **inline** in `packages/gitsheets/src/patch.ts` (~40 lines) | RFC 7396 semantics — see [behaviors/patch-semantics.md](behaviors/patch-semantics.md). No external dependency; the `json-merge-patch` package was removed during the v1.0 substrate purge. |
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

- **Single published package: `gitsheets`** — library + CLI in one. One `package.json`, one set of dependencies. Splitting into `@gitsheets/core` + `@gitsheets/cli` is deferred until there's a reason.
- **npm workspaces monorepo.** The repo root is a private workspaces shell (`{"workspaces": ["packages/*"], "private": true}`); the published package lives at `packages/gitsheets/`. This layout is what makes room for sibling packages (e.g., the agent-facing CLI tracked in [#170](https://github.com/JarvusInnovations/gitsheets/issues/170)) without churning the published surface — `gitsheets@1.x` keeps its name, contents, and import paths.
- **Entry points:**
  - `import { ... } from 'gitsheets'` → public library exports
  - `bin/gitsheets` (also installed as `git-sheet` for the `git sheet <cmd>` invocation)
- **Published artifacts:** built `dist/`, type definitions, source maps. No source TypeScript in the published package.

## Repository layout

```text
gitsheets/
├── packages/
│   └── gitsheets/                # the published npm package
│       ├── src/                  # TypeScript library
│       │   ├── cli/              # CLI entry + command modules
│       │   ├── format/           # pluggable record formats (toml/markdown/mdx)
│       │   ├── path-template/    # path template parser + query traversal
│       │   ├── errors.ts         # exported error classes
│       │   ├── repository.ts     # Repository class
│       │   ├── sheet.ts          # Sheet class
│       │   ├── transaction.ts    # Transaction class
│       │   ├── store.ts          # openStore + Store type
│       │   ├── *.test.ts         # Vitest specs co-located with the units they cover
│       │   └── index.ts          # public re-exports
│       ├── bin/                  # CLI entry shim
│       ├── package.json
│       ├── tsconfig.json
│       └── vitest.config.ts
├── docs/                         # User-facing documentation (mkdocs)
├── specs/                        # ← source of truth, this directory
├── skills/                       # bundled Claude Code skill (skills/gitsheets/)
├── .claude/
│   ├── agents/                   # spec-drift-auditor
│   └── commands/                 # /audit-spec-drift
├── .github/workflows/            # CI
├── CLAUDE.md
├── package.json                  # workspaces shell (private, not published)
├── package-lock.json             # single lockfile for the whole monorepo
├── mkdocs.yml
└── README.md
```

Root scripts (`npm run build`, `npm test`, `npm run type-check`) proxy to the `gitsheets` workspace via `-w gitsheets`, so a fresh clone's `npm install && npm test` works without first cd'ing into the package.

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

## Holo-tree migration (deferred)

[Issue #127](https://github.com/JarvusInnovations/gitsheets/issues/127) tracks swapping the hologit JS dependency for a Rust `holo-tree` crate via `napi-rs`, for ~100x faster tree operations on the hot path. **This is an internal-engine change with no public-API impact** — consumers see no difference, only performance. That constraint is load-bearing: the migration must sit entirely behind the existing `Repository` / `Sheet` / `Transaction` surface, with no consumer-visible change.

It stays deferred because the substrate swap is its own substantial track — it touches every tree-mutation site and benefits from a dedicated review cycle. v1.0, v1.1, and v1.2 all shipped on the JS hologit substrate; the migration targets a future minor when scheduled. The work is tracked as plans in [`plans/`](../plans/) — beginning with the [`holo-tree-napi-spike`](../plans/holo-tree-napi-spike.md) validation spike, which hardens the upstream Rust libs before any full swap — rather than as a backlog note.

The tree-ops migration is **phase 1** of a larger evolution toward a Rust-core
engine with thin per-language bindings (Node, then Python). The target
architecture — what lives in the core vs the binding, the bytes-authority
principle, embedded-code execution, and the canonical-form re-baseline — is
specified in [`rust-core.md`](rust-core.md), and the full build-out is the plan
DAG in [`plans/`](../plans/).
