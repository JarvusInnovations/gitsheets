---
status: done
depends: [node-binding-thin]
specs:
  - specs/rust-core.md
  - specs/architecture.md
issues: [127]
pr: 218
---

# Plan: per-platform addon prebuild + npm publish (release track)

## Scope

Make the published `gitsheets` package installable by consumers without a Rust
toolchain, by shipping the `@gitsheets/core-napi` addon as **per-platform prebuilt
binaries**. **In:** the six-triple napi build matrix, `optionalDependencies`
platform packages, trusted-publishing on tag, and wiring the `gitsheets` package
to depend on the published addon instead of the workspace-linked local `.node`.
**Out:** the Python wheel release matrix (that's `python-binding`'s own follow-up,
same playbook) and any engine changes.

> **Why this exists.** The cutover ([`node-binding-thin`](node-binding-thin.md))
> made the `gitsheets` package hard-depend on the `@gitsheets/core-napi` addon,
> but currently resolves it via the workspace-linked locally-built `.node` — a
> consumer `npm install gitsheets` would have no binary. This closes that.

## Approach

- Mirror the proven **`@hologit/holo-tree`** playbook (`hologit/.github/workflows/holo-tree-napi.yml`
  - its `napi.triples` / `optionalDependencies` / one-time bootstrap): six triples
  (linux gnu x64/arm64, linux musl x64 via zig, darwin x64/arm64, win x64-msvc),
  `napi build --release` per triple, platform `optionalDependencies`, `napi
  prepublish -t npm --skip-gh-release`, trusted publishing (OIDC) on a
  `core-napi-v*` tag.
- One-time bootstrap: manually publish the addon + platform packages at an early
  version, then enable per-package trusted publishing (the addon can't get a
  trusted publisher until it exists — same as holo-tree).
- Repoint `packages/gitsheets/package.json` from the workspace-linked
  `@gitsheets/core-napi` to the published version (with the platform
  `optionalDependencies` resolving the prebuilt binary); keep a clear `ConfigError`
  on an unsupported platform (already present).
- Consider a `postinstall`/`napi`-style build-from-source fallback for platforms
  without a prebuilt binary (optional).

## Validation

- [ ] The six-triple build matrix is green; artifacts published to npm on a
      `core-napi-v*` tag via trusted publishing (no token).
- [ ] `npm install gitsheets` in a clean project on a supported platform resolves
      the prebuilt addon and round-trips an upsert→commit with NO Rust toolchain.
- [ ] Unsupported platforms get the clear `ConfigError`.

## Risks / unknowns

- **Version coupling** — the addon version must track the `gitsheets` package
  release; decide the tagging/version relationship.
- **musl / cross builds** — reuse holo-tree's zig-cc cross path (already solved).

## Notes

**Status: DONE.** Machinery scaffolded + build matrix proven in CI, and the
one-time manual bootstrap is complete: all **7 `@gitsheets/*` packages published
at `0.1.0`** (the `@gitsheets` org was created; the 6 platform packages + the main
`@gitsheets/core-napi` are live on npm) and **per-package trusted publishing is
configured** (repo `JarvusInnovations/gitsheets`, workflow `core-napi.yml`) — so
future releases are tokenless via a `core-napi-v*` tag. **End-to-end verified:** a
clean-room `npm install @gitsheets/core-napi@0.1.0` (no repo / no Rust toolchain /
no workspace) resolved the correct platform prebuilt via `optionalDependencies`,
loaded the addon, and ran the Rust core (`serializeRecords([{b:2,a:1}])` →
`["a = 1\nb = 2\n"]`). Remaining is only the downstream `gitsheets` JS package
release (below) — not this plan.

**Version scheme.** `@gitsheets/core-napi` carries its own semver in its own
`core-napi-v*` git-tag namespace, decoupled from the `gitsheets` JS package's
`v*` tags (mirrors holo-tree's `holo-tree-v*`). Starts at `0.1.0`.
`packages/gitsheets` depends on it via `^0.1.0` — a caret range so a compatible
addon release is picked up without a lockstep bump. In-repo, npm workspaces
resolve the dep to the workspace member (symlink), so dev/CI never touch the
registry; only external `npm install gitsheets` consumers pull the published
platform packages.

**What's scaffolded:**

- `rust/gitsheets-napi/package.json` — version `0.1.0` (was `0.0.0`, private
  removed), six `optionalDependencies` platform packages pinned to `0.1.0`,
  `prepublishOnly: napi prepublish -t npm --skip-gh-release`, `artifacts` +
  `version` (`napi version`) scripts. `napi.triples` unchanged (the 6).
- `rust/gitsheets-napi/npm/<triple>/` — six platform-package manifests generated
  by `napi create-npm-dir -t .` (correct `os`/`cpu`/`libc`/`main`). Committed;
  their `.node` payloads are git-ignored and dropped in at publish time.
- `.github/workflows/core-napi.yml` — 6-triple build matrix (native
  build+smoke-test on matching runners incl. `ubuntu-24.04-arm`; musl via
  `--zig`, darwin-x64 cross → build-only), uploads `bindings-*` artifacts. A
  **tag-gated** `publish` job (`if: startsWith(github.ref,
  'refs/tags/core-napi-v')`) does `napi version` + pins root
  `optionalDependencies` + `napi artifacts` + `npm publish --provenance --access
  public` over **OIDC trusted publishing** (`--skip-gh-release`, no token).
  Triggers: `pull_request` on `rust/**` + `workflow_dispatch` (build only);
  publish only on `core-napi-v*` tags. Action tags pinned to resolvable majors
  (`checkout@v7`, `setup-node@v6`, `upload-artifact@v7`, `download-artifact@v8`,
  `rust-cache@v2`, `rust-toolchain@stable`).
- `packages/gitsheets/package.json` — dep bumped `^0.0.0` → `^0.1.0`; root
  lockfile regenerated (`npm ci` verified green, workspace symlink intact, the
  not-yet-published optional platform deps are skipped gracefully).

## Follow-ups

- **[HUMAN] One-time bootstrap** (see `rust/gitsheets-napi/README.md`
  "Publishing"): (0) ensure the `@gitsheets` npm scope exists and you're a member;
  (1) run the `core-napi` workflow and download the six `bindings-*` artifacts;
  (2) `npm login` as a `@gitsheets` member, `npx napi artifacts --dir <dir>`,
  publish the six `npm/*/` platform packages then the main package
  (`--ignore-scripts`) at `0.1.0`; (3) enable trusted publishing on npmjs.com for
  **each** of the seven packages → GitHub Actions, repo
  `JarvusInnovations/gitsheets`, workflow `core-napi.yml`. After that, releases
  are `git tag core-napi-v<x> && git push` → CI publishes tokenlessly.
- Once the addon is published, confirm a clean `npm install gitsheets` on a
  supported platform resolves the prebuilt addon with NO Rust toolchain and
  round-trips an upsert→commit (Validation item 2).
- Consider a build-from-source fallback (`postinstall`) for platforms without a
  prebuilt binary (optional; unsupported platforms currently get a clear
  `ConfigError` from the loader).
