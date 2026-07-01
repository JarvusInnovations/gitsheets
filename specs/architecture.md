# Architecture

Foundational tech decisions for gitsheets v1.0.

## Goal

A git-backed document store for low-volume, high-touch, human-scale data — readable through the JavaScript/TypeScript API and the `git sheet` CLI. The substrate is git itself: each record is a TOML file at a templated path; each mutation is a commit.

Concrete v1.0 ship list lives across [GitHub issues #128–#141 in the 1.0.0 milestone](https://github.com/JarvusInnovations/gitsheets/milestone/1).

## Stack

| Layer | Choice | Why |
| ------- | -------- | ----- |
| Engine | **Rust `gitsheets-core`** (via **`@gitsheets/core-napi`**, napi-rs) | The bytes-authority engine. TOML parse+serialize, canonical normalization/key-sort, path-template rendering, JSON-Schema validation, the embedded boa JS engine for escape-hatch snippets, native ICU locale collation, native `dprint-plugin-markdown` body normalization, record CRUD, query/index, diff/patch with rename detection, attachment/blob staging, and the `Sheet`/`Transaction`/`Store` state machine all live in the Rust core (`rust/gitsheets-core`). Anything that determines on-disk bytes lives here so every binding produces byte-identical commits. Shipped by [#127](https://github.com/JarvusInnovations/gitsheets/issues/127); see [rust-core.md](rust-core.md). |
| Language binding (Node) | **`gitsheets`** — thin marshalling shell | The published npm package is a thin TypeScript binding over `@gitsheets/core-napi`: it preserves the idiomatic JS API, marshals native objects ↔ the core value type, runs the consumer-supplied Standard Schema validator host-side, and maps core error variants to the typed error classes. It no longer owns serialization/validation/normalization. |
| Language binding (Python) | **`rust/gitsheets-py`** (pyo3) | A second thin binding over the same core, byte-identical to the Node binding — the bytes-authority-in-the-core thesis, proven across two bindings. |
| Consumer language | **TypeScript** (strict) | Discoverability for consumers; type-flow from `.gitsheets/<sheet>.toml` JSON Schema through to typed `Store.<sheet>.upsert(...)` |
| Module format | **ESM-only** | Modern Node + Bun + edge runtimes all handle ESM. Dual CJS/ESM build deferred until a concrete consumer needs it. |
| Runtime | **Node.js ≥ 20**, **Bun ≥ 1** | Both have native ESM, both can host the CLI. No Deno target in v1.0. |
| Tree primitives | **`holo-tree`** (gitoxide), inside `gitsheets-core` | Mutable in-memory git trees over [gitoxide](https://github.com/GitoxideLabs/gitoxide) — deep-path writes/reads/deletes, blob hashing, commit + compare-and-swap ref updates, no `git` subprocess on the tree-mutation path. Tree/blob/commit ops now run inside the Rust core; the JS package reaches them through `gitsheets-core` and no longer depends on `@hologit/holo-tree` directly (the hologit JS dependency was dropped in [#127](https://github.com/JarvusInnovations/gitsheets/issues/127); the direct `@hologit/holo-tree` binding was removed at the core cutover, [#216](https://github.com/JarvusInnovations/gitsheets/pull/216)). Pushes still shell out to `git`. |
| TOML parse | **Rust core `toml` crate** | Reads happen in the core (the bytes-authority), which preserves TOML's four datetime kinds and the integer/float distinction across the FFI boundary; the Node binding surfaces datetimes as `Date` (`instanceof Date` preserved). Replaced the JS `smol-toml` parser. |
| TOML serialize | **Rust core `toml` crate** | Writes serialize in the core to the byte-stable canonical form, so bytes are identical across every binding. Replaced the JS `@iarna/toml` serializer; see the [canonical-form re-baseline](behaviors/normalization.md#canonical-form-re-baseline-the-rust-serializer). |
| Canonical key sort | **Rust core** (`toml` `BTreeMap` deep sort) | Deep alphabetical key sorting on every write for byte-stable normalization, native in the core. The JS **`sort-keys`** dependency is retained only for the public `Sheet.normalizeRecord` array-field sort. |
| JSON Schema validation | **Rust core `jsonschema` crate** (strict) | Draft-07, unknown-keyword-rejecting — the core walks the schema at compile and rejects any keyword outside the known vocabulary (and `$data`), restoring the former `ajv` `strict: true` guard. Persisted-shape contract per [behaviors/validation.md](behaviors/validation.md). Replaced the JS `ajv` + `ajv-formats`. |
| Runtime validator (consumer-supplied) | Any **[Standard Schema](https://standardschema.dev)** implementation | Consumer chooses Zod / Valibot / ArkType / Effect Schema. Gitsheets calls `~standard.validate`. |
| JSON Merge Patch | **inline** in `packages/gitsheets/src/patch.ts` (~40 lines) | RFC 7396 semantics — see [behaviors/patch-semantics.md](behaviors/patch-semantics.md). No external dependency; the `json-merge-patch` package was removed during the v1.0 substrate purge. |
| JSON Patch (RFC 6902) | **`rfc6902`** | Generates RFC 6902 ops for `Sheet.diffFrom({ patches: true })` (v1.1). |
| Markdown normalization | **`dprint-plugin-markdown`** (Rust, pinned `=0.22.1` in `rust/gitsheets-core`) | Native body normalization on write for content-typed sheets — embedded in the bytes-authority core (`textWrap: never`, aggressive), so bodies are byte-identical across every binding. Replaced the host-side `markdownlint` pre-pass. See [behaviors/content-types.md](behaviors/content-types.md). |
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
├── rust/                         # the Rust engine + language bindings
│   ├── gitsheets-core/           # the bytes-authority engine crate
│   ├── gitsheets-napi/           # napi-rs binding → @gitsheets/core-napi (Node)
│   └── gitsheets-py/             # pyo3 binding (Python)
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

## What stays cross-cutting in the engine

These belong to the Rust `gitsheets-core` engine (the bytes-authority) and are surfaced through the binding — they are not consumer concerns:

- **TOML serialization** — sorted-key normalization, datetime/int-vs-float fidelity. Bytes on disk are deterministic for byte-stable git diffs, identical across every binding.
- **Path template rendering** — `${{ field }}` and `${{ expression }}` syntax, recursive `${{ field/** }}`, multi-variable per-segment.
- **Tree mutation under the hood** — deep-path tree writes/reads/deletes over `holo-tree`, surfaced via `Sheet` + `Transaction`.
- **Git operations** — commit creation, ref updates. Surfaced via `Transaction`; push is host-side (the optional push daemon shells out to `git`).
- **Validation** — the persisted JSON Schema runs in the core; the optional consumer Standard Schema runs host-side in the binding, before marshalling. Errors bubble up as typed exceptions.

## Distribution

- **npm:** `gitsheets` (current owner: themightychris).
- **Versioning:** semver. v1.0.0 is the cut after all `[1.0]`-tagged issues in the [1.0.0 milestone](https://github.com/JarvusInnovations/gitsheets/milestone/1) close. Patch releases inside 1.x preserve the documented API.
- **Breaking changes** — only at major boundaries. The library's pre-1.0 API does not constrain v1.0 (the legacy `GitSheets` class is purged outright; no migration shim).

## Holo-tree migration (done)

[Issue #127](https://github.com/JarvusInnovations/gitsheets/issues/127) swapped the hologit JS dependency for the Rust `holo-tree` crate via `napi-rs`, for ~100x faster tree operations on the hot path. **This was an internal-engine change with no public-API impact** — consumers saw no difference, only performance. That constraint was load-bearing: the migration sits entirely behind the existing `Repository` / `Sheet` / `Transaction` surface, with no consumer-visible change.

The swap landed in [#203](https://github.com/JarvusInnovations/gitsheets/pull/203), after the [`holo-tree-napi-spike`](../plans/holo-tree-napi-spike.md) validation spike hardened the upstream Rust libs (three dirty-propagation bugs found and fixed upstream) and the [`holo-tree-migration`](../plans/holo-tree-migration.md) plan replaced every tree-mutation site. As of phase 1, gitsheets no longer depended on hologit JS; tree ops ran through the [`@hologit/holo-tree`](https://github.com/JarvusInnovations/hologit/tree/master/holo-tree-napi) binding over a deep-path adapter (`src/working-tree.ts`). **At the later core cutover ([#216](https://github.com/JarvusInnovations/gitsheets/pull/216)) tree ops moved *inside* `gitsheets-core`, and the direct `@hologit/holo-tree` dependency was dropped** — the JS package now reaches tree/blob/commit ops through the core.

The tree-ops migration was **phase 1** of a larger evolution toward a Rust-core
engine with thin per-language bindings (Node, then Python). That evolution has
since **shipped in full** ([#127](https://github.com/JarvusInnovations/gitsheets/issues/127)):
`gitsheets-core` now owns the engine, the Node package is a thin marshalling shell
over `@gitsheets/core-napi`, and a Python binding (`rust/gitsheets-py`) runs over
the same core. What lives in the core vs the binding, the bytes-authority
principle, embedded-code execution, and the canonical-form re-baseline are
specified in [`rust-core.md`](rust-core.md); the build-out is the (now-`done`)
plan DAG in [`plans/`](../plans/).
