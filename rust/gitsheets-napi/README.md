# @gitsheets/core-napi

Node.js native binding for [`gitsheets-core`](../gitsheets-core) — the FFI
marshalling boundary between the published `gitsheets` npm package (a thin
TypeScript shell) and the Rust engine that owns the bytes: TOML parse/serialize,
canonical normalization, path templates, JSON-Schema validation, the embedded
JS engine, ICU collation, record CRUD / query / index, diff/patch, attachments,
and the `Sheet`/`Transaction`/`Store` state machine. Tree/blob/commit ops run on
`holo-tree` (gitoxide) inside the core.

This package exists so that a consumer can `npm install gitsheets` and get a
working native addon **without a Rust toolchain** — the matching prebuilt binary
is pulled in as an `optionalDependency` platform package.

## Building (in-repo development)

Requires a Rust toolchain and `@napi-rs/cli` (a devDependency):

```sh
npm install
npm run build:debug   # or: npm run build   (release)
npm test              # node --test against scratch git repos
```

`napi build` emits `gitsheets-core.<triple>.node`. The generated `index.js`
loader, `index.d.ts` types, and `binding.cjs` wrapper **are committed**; only the
`.node` binaries are git-ignored (built per-platform in CI). The `npm/<triple>/`
platform-package manifests are committed too; their `.node` payloads are dropped
in at publish time.

In-repo, the JS package resolves this binding through the npm-workspace symlink
(`node_modules/@gitsheets/core-napi → rust/gitsheets-napi`) and loads the locally
built `.node` next to `index.js`; the `optionalDependencies` platform packages
are only used by external consumers.

## Publishing / prebuilds

Published as the scoped package **`@gitsheets/core-napi`** with per-platform
prebuilt binaries shipped as `optionalDependencies`:

| Platform package | Triple | Built on | Smoke-tested |
| --- | --- | --- | --- |
| `@gitsheets/core-napi-linux-x64-gnu` | `x86_64-unknown-linux-gnu` | ubuntu-latest | ✓ native |
| `@gitsheets/core-napi-linux-arm64-gnu` | `aarch64-unknown-linux-gnu` | ubuntu-24.04-arm | ✓ native |
| `@gitsheets/core-napi-linux-x64-musl` | `x86_64-unknown-linux-musl` | ubuntu-latest (zig cross) | build-only |
| `@gitsheets/core-napi-darwin-arm64` | `aarch64-apple-darwin` | macos-latest | ✓ native |
| `@gitsheets/core-napi-darwin-x64` | `x86_64-apple-darwin` | macos-latest (cross) | build-only |
| `@gitsheets/core-napi-win32-x64-msvc` | `x86_64-pc-windows-msvc` | windows-latest | ✓ native |

Native targets build + smoke-test on a matching runner; cross targets (musl,
darwin-x64) build only, since their `.node` can't run on the host arch/libc (the
logic is covered by the native runs). The `.github/workflows/core-napi.yml`
workflow builds all six on every PR touching `rust/**`, and on a `core-napi-v*`
tag it builds then publishes.

Auth is **npm trusted publishing (OIDC)** — no tokens, matching the repo's
`publish-npm.yml`. Trusted publishing is configured *per package*, and a package
can't get a trusted publisher until it exists — so the seven packages
(the main package + six platform packages) need a **one-time manual bootstrap**
before automated releases work.

### Prerequisite: the `@gitsheets` npm scope

The `@gitsheets` org/scope must exist on npmjs.com and the person running the
bootstrap must be a member with publish rights. (One-time human setup.)

### One-time bootstrap (manual first publish, then configure trusted publishing)

The seven packages all start at an early version (currently `0.1.0`). They must
exist on npm before trusted publishing can be turned on.

1. **Get the prebuilt binaries.** Run the `core-napi` workflow (open a PR
   touching `rust/**`, or trigger `workflow_dispatch`) and download its six
   `bindings-*` artifacts — they hold the `.node` for each platform. A single
   machine can't build all six natively, so use the CI artifacts.

2. **Publish all seven manually**, logged in as a `@gitsheets` org member
   (`npm login`):

   ```sh
   cd rust/gitsheets-napi
   npm install
   npx napi artifacts --dir <downloaded-artifacts-dir>   # → npm/<triple>/*.node
   # platform packages first, then the main package:
   for d in npm/*/ ; do ( cd "$d" && npm publish --access public ); done
   npm publish --access public --ignore-scripts          # main; skip the napi
                                                         # prepublish hook
   ```

3. **Turn on trusted publishing** on npmjs.com for **each** of the seven packages
   → package Settings → Trusted Publisher → GitHub Actions, repo
   `JarvusInnovations/gitsheets`, workflow `core-napi.yml`.

### Releases (after bootstrap — fully automated, tokenless)

```sh
git tag core-napi-v0.1.1 && git push origin core-napi-v0.1.1
```

The tag drives the published version; CI builds all six platforms, then publishes
via OIDC (provenance). No secret needed. The `core-napi-v*` tag is the release
marker — napi runs with `--skip-gh-release` so it does **not** create a bare
`v<version>` GitHub release/tag (which would collide with the `gitsheets`
JS-package `v*` release namespace owned by `publish-npm.yml`).

**Version scheme.** `@gitsheets/core-napi` carries its own semver in its own
`core-napi-v*` tag namespace, decoupled from the `gitsheets` package's `v*` tags.
`packages/gitsheets` depends on it via a caret range (`^0.1.0`) so a compatible
addon release is picked up without a lockstep bump; widen the range deliberately
when the addon takes a breaking major.

To add or drop a platform later, edit `napi.triples.additional` +
`optionalDependencies` in `package.json`, run `npx napi create-npm-dir -t .`,
add the matching matrix entry in the workflow, and (since it's a new package)
bootstrap + trust that one package too.
