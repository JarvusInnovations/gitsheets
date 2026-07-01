---
status: in-progress
depends: [node-binding-thin]
specs:
  - specs/rust-core.md
  - specs/architecture.md
issues: [127]
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

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
