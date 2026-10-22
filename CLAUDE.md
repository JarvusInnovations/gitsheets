# gitsheets

A git-backed document store for low-volume, high-touch, human-scale data. Library + CLI.

## Spec-driven development (specops)

This project uses spec-driven development. `specs/` is the source of truth for what
*should be true*; `plans/` is the work-in-flight DAG that bridges specs to merged code.
The **specops** skill carries the full methodology — invoke it (the skill triggers on
"spec", "plan", starting a feature, etc.) before writing specs, planning, or building.

- **Specs lead.** Before changing behavior, change the spec; bring code into conformance
  after. Spec↔code drift is a bug, not debt. If the spec doesn't cover what you're about
  to do, update the spec first. Specs merge implemented-or-planned; a spec still being
  designed rides a draft planning PR, not `develop`.
- **Never a spec-only PR.** Open the branch and PR for the *feature*, start it with the
  `docs(specs):` commits and the plan (draft PR is fine), add the implementation on the same
  branch, and merge only when the plan is complete. The one exception is a draft planning PR
  for a whole design arc, which merges with its plan set and is then drained promptly.
- **`plans/` is the planning system — not your built-in plan mode.** Every chunk of work
  lands as a file in `plans/` that freezes to `done` as the durable record of what got
  built. One feature branch carries spec → plan → code → closeout and merges with the plan
  complete; the issue tracker, not `plans/`, is the backlog. Don't let an ephemeral plan
  substitute for a plan file, and don't skip it for "small" changes. (Classic trap: an
  ad-hoc plan of "write spec X, then build it" that ends with neither a reviewed spec nor a
  plan file — split those into the two real artifacts.)
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

The active work scope is [the 1.0.0 milestone](https://github.com/JarvusInnovations/gitsheets/milestone/1) — see issues #128 through #141 (excluding the few backlog ones). The [Rust-core migration](https://github.com/JarvusInnovations/gitsheets/issues/127) is **done**: the engine lives in the Rust `gitsheets-core` crate (`rust/gitsheets-core`), the published `gitsheets` npm package is a **thin marshalling shell** over it (via the `@gitsheets/core-napi` addon), and a parallel **Python** binding (`rust/gitsheets-py`, pyo3) runs over the same core, byte-identical. Tree/blob/commit ops now run on `holo-tree` (gitoxide) *inside* the core — the direct `@hologit/holo-tree` JS dependency was dropped at the cutover ([#216](https://github.com/JarvusInnovations/gitsheets/pull/216)). The architecture is specced in [specs/rust-core.md](specs/rust-core.md) and was built out via the (now-`done`) [`plans/`](plans/) DAG.

## Stack

- **Engine** — Rust `gitsheets-core` crate (`rust/gitsheets-core`), the bytes-authority: TOML parse+serialize, canonical normalization/key-sort, path templates, JSON-Schema validation (strict), the embedded boa JS engine, native ICU collation, native `dprint-plugin-markdown` normalization, record CRUD, query/index, diff/patch, attachments, and the `Sheet`/`Transaction`/`Store` state machine. Tree/blob/commit via `holo-tree` (gitoxide) inside the core.
- **Bindings** — Node (`gitsheets` npm package, a thin marshalling shell over the `@gitsheets/core-napi` addon) and Python (`rust/gitsheets-py`, pyo3), byte-identical over the same core.
- **Language** — TypeScript (strict). ESM-only.
- **Runtime** — Node.js ≥ 20 or Bun ≥ 1.
- **Retained JS deps** — `sort-keys` (public `Sheet.normalizeRecord` array-field sort), `node:vm` (exported `Template` render + raw-JS sort comparators), `rfc6902` (public `DiffChange.patch` type + markdown `diffFrom`), `yargs`, `csv-*`. Dropped at the cutover: `@iarna/toml`, `smol-toml`, `ajv`, `ajv-formats`, `markdownlint`, `@hologit/holo-tree`.
- **Runtime consumer-validator interface** — [Standard Schema](https://standardschema.dev) (any compliant validator: Zod, Valibot, ArkType, Effect Schema), run host-side in the binding.
- **JSON Merge Patch** — RFC 7396, inline in `packages/gitsheets/src/patch.ts`.
- **Tests** — Vitest.

See [specs/architecture.md](specs/architecture.md) for the full stack rationale.

## Authorship conventions

- TypeScript everywhere. `strict: true`. No `.js` in `packages/gitsheets/src/`.
- Field naming: `camelCase` in code, in TOML records, and on `Sheet.<field>` config — no casing translation.
- IDs: consumer's choice (gitsheets doesn't impose UUID/string/numeric). Path templates render whatever the field holds.
- Timestamps: TOML datetime types are preserved by the Rust core across parse and serialize; the Node binding surfaces them as `instanceof Date`, and consumers can also use ISO 8601 strings.
- Use the typed error classes from [specs/api/errors.md](specs/api/errors.md) — never throw plain `Error` from public surfaces.
- Mutations go through `repo.transact` or via the permissive Sheet methods documented in [specs/behaviors/transactions.md](specs/behaviors/transactions.md).

## Source control

- **Conventional commits** — `type(scope): description` (e.g., `feat(sheet): add patch method`, `fix(path-template): handle multi-variable segments`, `docs(specs): clarify trailer conventions`).
- **Logical sets per commit** — group related changes together; commit often. When multiple uncommitted change-sets exist, commit them separately in a logical order.
- **Always `git status` before staging.** Stage specific files or directories — never `git add -A` or `git add .`.
- **Generated changes commit first.** When a command modifies files (`npm install`, codegen), commit those in a dedicated commit with the exact command in the body. Then make manual edits in a separate commit.
- **Don't commit suspected secrets** — `.env`, anything in `*.local.*`, credentials, private keys.

## Releases

Three release tracks (two npm, one PyPI) ship from this repo on **separate,
prefix-namespaced git-tag tracks** — keep them distinct, and mind the ordering rule.
`specs/behaviors/distribution.md` is the source of truth for the tracks and their
deliberately-different version-source rules:

- **`gitsheets`** (the JS package) — released on **`v*`** tags via the develop→main
  Release-PR flow (`release-prepare`/`-validate`/`-publish` workflows; use the
  **`release-flow`** skill). Merging the `Release: vX.Y.Z` PR cuts the tag;
  `publish-npm.yml` then builds, tests, and publishes from that tag.
- **`@gitsheets/core-napi`** (+ its 6 platform packages) — released on
  **`core-napi-v*`** tags via `core-napi.yml`: native per-platform builds + npm
  trusted publishing (OIDC). Never tag the addon with a bare `v*` — that namespace
  belongs to the JS package.
- **`gitsheets` on PyPI** (the Python binding) — released on **`py-v*`** tags via
  `python-publish.yml`: abi3 wheels + sdist, PyPI trusted publishing (OIDC).
  **The version is COMMITTED in `rust/gitsheets-py/Cargo.toml`** (maturin reads it)
  and the tag must match it exactly — the workflow's guard job fails the run on
  mismatch. This deliberately inverts the napi track's tag-stamped rule (see
  `specs/behaviors/distribution.md`): bump the committed version on develop first,
  then tag `py-v<that-version>` from a commit where `rust-core.yml` is green (the
  cross-binding byte-parity gate). Never tag the binding with a bare `v*`.

Rules learned the hard way (v2.3.0's failed publish — see
`plans/core-napi-0.2.0-release.md`):

1. **A `gitsheets-core` behavior change requires a core-napi release BEFORE the JS
   release.** `publish-npm` runs the workspace napi tests against the *published*
   platform binaries (resolved via the workspace manifest's `optionalDependencies`),
   so a JS release atop stale binaries fails mid-publish with test assertions
   mismatching old core behavior. If `rust/gitsheets-core` changed since the last
   `core-napi-v*` tag, ship core-napi first.
2. **napi versions are tag-stamped, never pre-committed.** `core-napi.yml` runs
   `npm version $VERSION` from the tag name at publish time and errors ("Version not
   changed") if the manifest already carries that version. Tag `develop` with the
   **un-bumped** manifests; don't bump `rust/gitsheets-napi/package.json` (or
   `npm/*/package.json`) ahead of the tag.
3. **Sync manifests AFTER the core-napi publish.** Once the new version is live, PR
   the sync: `rust/gitsheets-napi` version + platform `optionalDependencies` +
   `npm/*/package.json` to the released version, `packages/gitsheets` dep range,
   and a lockfile refresh. Without this, workspace tests keep resolving the previous
   platform binaries. (Committing the just-released version is safe — the stamp step
   only fails when the committed version equals the tag being stamped.)

Sequence for a batch that touches core: merge the feature PRs → tag `core-napi-v*`
on develop → wait for the 7 packages to land on npm → PR the manifest/lockfile sync →
merge → run the release-flow skill on the auto-opened `Release: v*` PR. The `py-v*`
track is independent of this npm sequencing (it builds the core from source at the
tagged commit) but shares the parity gate: only tag rust-core-green commits.

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
