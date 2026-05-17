# gitsheets

A git-backed document store for low-volume, high-touch, human-scale data.

Records are TOML files in a git repo, organized by a per-sheet path template. Every mutation is a commit — the commit log is the audit log. Schemas live alongside the data; validation runs on every write. Branches give you propose-review workflows for free.

```bash
npm install gitsheets
```

Targets Node.js ≥ 20 and Bun ≥ 1. ESM-only. CLI installs as `gitsheets` and `git-sheet`.

## Get started

- **[Quick start](quick-start.md)** — `npm install gitsheets`, declare a sheet, write a record, read it back. ≤ 5 minutes.
- **[Concepts](concepts.md)** — Repository, Sheet, Path Template, Transaction, Store, Index, Push Daemon. The vocabulary every consumer needs.

## Reference

- **[CLI reference](cli.md)** — `git sheet <command>`, global flags, exit codes.
- **[API reference](api.md)** — public exports + pointers into the per-symbol spec.
- **[Path templates](path-templates.md)** — syntax, recursive fields, query pruning, invalid-char handling.
- **[Validation](validation.md)** — JSON Schema in `.gitsheets/<sheet>.toml`, optional Standard Schema layering.

## Recipes

- **[Typed sheet with Zod](recipes/typed-sheet-with-zod.md)** — Standard Schema validator threading, type-safe upsert/query.
- **[Request-bound transactions in Fastify](recipes/request-bound-transactions.md)** — one commit per HTTP request, with structured trailers.
- **[Secondary indices](recipes/secondary-indices.md)** — in-memory `findByEmail` / `findByForeignKey` patterns.
- **[Production push daemon](recipes/production-push-daemon.md)** — backoff config, auth strategies, monitoring.
- **[Markdown CMS pattern](recipes/markdown-cms.md)** — content-typed sheets: records as `.md` with TOML frontmatter; lazy body loading.
- **[Migrating a `[gitsheet.fields]` config](recipes/migrating-config.md)** — pre-v1.0 → v1.0 schema migration.

## Migrating from pre-v1.0

If you're updating from a pre-v1.0 internal install, the [migration guide](migration-guide.md) covers the breaking changes (legacy `GitSheets` class removed, HTTP server removed, ESM-only, validation reshape).

## Where the contracts live

[`specs/`](https://github.com/JarvusInnovations/gitsheets/tree/develop/specs) is the source of truth. The docs you're reading are the consumer-facing tour; the specs are the authoritative API + behavior contract. When in doubt, the spec wins.

## License

Apache-2.0. See [LICENSE](https://github.com/JarvusInnovations/gitsheets/blob/develop/LICENSE).
