# gitsheets

A git-backed document store for low-volume, high-touch, human-scale data.

> **v1.0 docs under construction.** The pages here cover the post-1.0 surface.
> For the full contract, [`specs/`](https://github.com/JarvusInnovations/gitsheets/tree/develop/specs)
> is the source of truth.

## Sections

- [Quick start](quick-start.md) — `npm i gitsheets`, fresh TS project, first
  typed write inside a transaction in ≤5 minutes
- [CLI reference](cli.md) — `git sheet <command>` surface
- [API reference](api.md) — pointer into the `specs/` directory
- [Path templates](path-templates.md) — declaring where records live

## Install

```bash
npm install gitsheets
```

`gitsheets` is a TypeScript-first ESM package targeting Node.js ≥ 20 and
Bun ≥ 1. The CLI installs as both `gitsheets` and `git-sheet`.

## Concepts at a glance

- **Repository** — a git directory holding gitsheets data
- **Sheet** — a typed collection declared by `.gitsheets/<name>.toml`
- **Path template** — `${{ slug }}` / `${{ field/** }}` — where each record's
  TOML file lives in the tree
- **Transaction** — one commit per scope; multiple sheet mutations atomic
- **Store** — typed wrapper over sheets, binds Standard Schema validators
- **Push daemon** — async fast-forward push to a remote with retry/backoff

See [`specs/concepts.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/concepts.md)
for the full vocabulary.

## Why git as a substrate

Every mutation is a commit. The commit log is the audit log. Sheets diff
cleanly because gitsheets writes records in a canonical, byte-stable form
(deep-sorted TOML keys, optional array sort rules). Branches give you
proposal / review workflows for free.
