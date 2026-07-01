# gitsheets

A git-backed document store for low-volume, high-touch, human-scale data.

Records are TOML (or markdown-with-frontmatter) files in a git repository, laid
out by a per-sheet path template. Every mutation is a commit, so the log is the
audit trail. The engine is a shared **Rust core** with thin per-language
bindings: this repo ships the Node binding (`gitsheets` on npm) and a Python
binding, both running on the same core, so a write from either language produces
byte-identical commits.

The library and CLI live in [`packages/gitsheets`](packages/gitsheets); start
there. The Rust core and its bindings live under [`rust/`](rust/).

## Spec-driven

[`specs/`](specs/) is the source of truth. Start at [`specs/README.md`](specs/README.md).

- [`specs/architecture.md`](specs/architecture.md) — stack and packaging
- [`specs/rust-core.md`](specs/rust-core.md) — the Rust core + thin-binding architecture
- [`specs/concepts.md`](specs/concepts.md) — Repository, Sheet, Record, Transaction, Store, Index
- [`specs/api/`](specs/api/) — per-symbol API contracts
- [`specs/behaviors/`](specs/behaviors/) — cross-cutting rules

## License

[Apache-2.0](LICENSE).
