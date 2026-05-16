# gitsheets

A git-backed document store for low-volume, high-touch, human-scale data.

> **v1.0 under heavy development.** The library is being rewritten as a
> TypeScript-only ESM package. The current `develop` (and `1.0-substrate`)
> branches do not yet expose the documented API. Track progress in the
> [1.0.0 milestone](https://github.com/JarvusInnovations/gitsheets/milestone/1).

## Spec-driven

[`specs/`](specs/) is the source of truth. Start at [`specs/README.md`](specs/README.md).

- [`specs/architecture.md`](specs/architecture.md) — stack and packaging
- [`specs/concepts.md`](specs/concepts.md) — Repository, Sheet, Record, Transaction, Store, Index
- [`specs/api/`](specs/api/) — per-symbol API contracts
- [`specs/behaviors/`](specs/behaviors/) — cross-cutting rules

## License

[Apache-2.0](LICENSE).
