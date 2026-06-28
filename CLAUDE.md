# gitsheets

A git-backed document store for low-volume, high-touch, human-scale data. Library + CLI.

## Spec-driven development (specops)

This project uses spec-driven development. `specs/` is the source of truth for what
*should be true*; `plans/` is the work-in-flight DAG that bridges specs to merged code.
The **specops** skill carries the full methodology — invoke it (the skill triggers on
"spec", "plan", starting a feature, etc.) before writing specs, planning, or building.

- **Specs lead.** Before changing behavior, change the spec; bring code into conformance
  after. Spec↔code drift is a bug, not debt. If the spec doesn't cover what you're about
  to do, update the spec first.
- **`plans/` is the planning system — not your built-in plan mode.** Every chunk of work
  lands as a file in `plans/` that freezes to `done` as the durable record of what got
  built. Don't let an ephemeral plan substitute for it, and don't skip it for "small"
  changes. (Classic trap: an ad-hoc plan of "write spec X, then build it" that ends with
  neither a reviewed spec nor a plan file — split those into the two real artifacts.)
- **When to author a plan depends on intent:** mapping out a batch of specs → finish the
  batch first, then propose a *set* of plans; speccing one bounded feature in a mature
  project → draft the spec change and its plan in tandem; intent unclear → ask. The skill
  details each mode.
- **A spec change ripples to its plans.** After editing a spec, review the plans that
  implement it (`grep -l '<spec-path>' plans/*.md`) and offer to update them.

Query the DAG: `.claude/skills/specops/scripts/specops next` (what to work on next) and
`.claude/skills/specops/scripts/specops dag` (graph). Run `/audit-spec-drift` to compare
specs against the implementation (before major work, after large refactors, and as part
of the release checklist).

Start at [specs/README.md](specs/README.md). The spec index:

- [specs/architecture.md](specs/architecture.md) — stack, packaging, foundational decisions
- [specs/concepts.md](specs/concepts.md) — vocabulary: Repository, Sheet, Record, Transaction, Store, Index
- [specs/deferred.md](specs/deferred.md) — features intentionally out of scope for v1.0 (do NOT silently implement these)
- [specs/api/](specs/api/) — per-symbol API contracts (Repository, Sheet, Transaction, Store, Errors, CLI)
- [specs/behaviors/](specs/behaviors/) — cross-cutting rules (path templates, validation, normalization, transactions, indexing, push sync, attachments, patch semantics)

Plans live in [plans/](plans/) — see [plans/README.md](plans/README.md).

## v1.0 milestone

The active work scope is [the 1.0.0 milestone](https://github.com/JarvusInnovations/gitsheets/milestone/1) — see issues #128 through #141 (excluding the few backlog ones). The [holo-tree (Rust) migration](https://github.com/JarvusInnovations/gitsheets/issues/127) is v1.1; v1.0 stays on the JS hologit substrate.

## Stack

- **Language** — TypeScript (strict). ESM-only.
- **Runtime** — Node.js ≥ 20 or Bun ≥ 1.
- **Tree primitives** — hologit (JS) for v1.0; holo-tree (Rust via napi-rs) for v1.1.
- **TOML** — `smol-toml` for parse (lean memory), `@iarna/toml` for serialize (byte-stable canonical form). Date types preserved (`instanceof Date`). See [specs/architecture.md](specs/architecture.md).
- **JSON Schema validation** — `ajv`.
- **Runtime consumer-validator interface** — [Standard Schema](https://standardschema.dev) (any compliant validator: Zod, Valibot, ArkType, Effect Schema).
- **JSON Merge Patch** — RFC 7396 via `json-merge-patch`.
- **Tests** — Vitest (or `node --test`; chosen during #137).

See [specs/architecture.md](specs/architecture.md) for the full stack rationale.

## Authorship conventions

- TypeScript everywhere. `strict: true`. No `.js` in `packages/gitsheets/src/`.
- Field naming: `camelCase` in code, in TOML records, and on `Sheet.<field>` config — no casing translation.
- IDs: consumer's choice (gitsheets doesn't impose UUID/string/numeric). Path templates render whatever the field holds.
- Timestamps: TOML datetime types preserved across parse (`smol-toml` → `instanceof Date`) and serialize (`@iarna/toml`); consumers can also use ISO 8601 strings.
- Use the typed error classes from [specs/api/errors.md](specs/api/errors.md) — never throw plain `Error` from public surfaces.
- Mutations go through `repo.transact` or via the permissive Sheet methods documented in [specs/behaviors/transactions.md](specs/behaviors/transactions.md).

## Source control

- **Conventional commits** — `type(scope): description` (e.g., `feat(sheet): add patch method`, `fix(path-template): handle multi-variable segments`, `docs(specs): clarify trailer conventions`).
- **Logical sets per commit** — group related changes together; commit often. When multiple uncommitted change-sets exist, commit them separately in a logical order.
- **Always `git status` before staging.** Stage specific files or directories — never `git add -A` or `git add .`.
- **Generated changes commit first.** When a command modifies files (`npm install`, codegen), commit those in a dedicated commit with the exact command in the body. Then make manual edits in a separate commit.
- **Don't commit suspected secrets** — `.env`, anything in `*.local.*`, credentials, private keys.

## Tooling

- **`gh-axi`** (or `gh`) for all GitHub operations.
- **GitHub Actions** — when authoring or modifying a workflow, run `gh-axi repo view <owner>/<repo>` on each action's repo to confirm the latest recommended version.
- **`jq`** for processing JSON in any shell pipeline. No inline Python/Node to filter JSON.
- **`npm`** for packages. Never hand-edit `package.json` or `package-lock.json` — use `npm install <pkg>`, `npm uninstall <pkg>`, etc. Commit `package-lock.json`.
- **`asdf`** for tool versions when available. Never edit `.tool-versions` directly.

## Commands (post-1.0)

The repo is an npm workspaces monorepo — the published package lives at `packages/gitsheets/`. Run scripts from the repo root; root proxies (`npm test`, `npm run build`, `npm run type-check`) forward to the `gitsheets` workspace via `-w gitsheets`.

```bash
npm install
npm run build         # tsc → packages/gitsheets/dist/
npm test              # vitest
npm run type-check
```

Single-workspace operations also work directly: `npm install -w gitsheets <pkg>`, `npm test -w gitsheets`.

CLI usage:

```bash
git sheet upsert <sheet> [file]
git sheet query <sheet> [--filter.<field>=<value>]
git sheet read <sheet> <path>
git sheet edit <sheet> <path>
git sheet normalize <sheet>
git sheet infer <sheet>
git sheet migrate-config <sheet>
```

See [specs/api/cli.md](specs/api/cli.md).

## When in doubt

Pick the spec that mentions what you're working on. If multiple specs apply (e.g., `Sheet.patch` involves [api/sheet.md](specs/api/sheet.md), [behaviors/patch-semantics.md](specs/behaviors/patch-semantics.md), [behaviors/validation.md](specs/behaviors/validation.md)), read each. If you can't find a spec, the answer is to write one — not to make up behavior.
