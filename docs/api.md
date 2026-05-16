# API reference

The authoritative API contract lives in [`specs/`](https://github.com/JarvusInnovations/gitsheets/tree/develop/specs).
This page indexes those specs and adds short usage notes; for the full
contract, click through.

## Top-level exports

```typescript
import {
  openRepo,
  openStore,
  Repository,
  Sheet,
  Transaction,
  PushDaemon,
  Template,
  // errors
  GitsheetsError,
  ConfigError,
  ValidationError,
  TransactionError,
  IndexError,
  RefError,
  PathTemplateError,
  NotFoundError,
  // patch
  mergePatch,
  // symbols
  RECORD_PATH_KEY,
  RECORD_SHEET_KEY,
} from 'gitsheets';
```

## Surface

| Spec | Symbol | What it does |
| --- | --- | --- |
| [`api/repository.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/repository.md) | `openRepo`, `Repository` | Open a git repo; orchestrate transactions, push daemon, sheet discovery |
| [`api/sheet.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/sheet.md) | `Sheet` | Per-sheet handle: query, upsert, delete, patch, defineIndex, findByIndex, attachments |
| [`api/transaction.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/transaction.md) | `Transaction` | Commit-scoped mutations; tx.sheet(name) yields tx-bound Sheets |
| [`api/store.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/store.md) | `openStore`, `Store` | Typed wrapper binding Standard Schema validators per sheet |
| [`api/errors.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/errors.md) | error classes | Typed exception hierarchy with stable codes |
| [`api/cli.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/api/cli.md) | CLI | `git sheet <command>` surface |

## Behaviors

| Spec | Topic |
| --- | --- |
| [`behaviors/path-templates.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/path-templates.md) | `${{ field }}` / `${{ expression }}` / `${{ field/** }}`; query tree pruning |
| [`behaviors/validation.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/validation.md) | JSON Schema + optional Standard Schema layering |
| [`behaviors/normalization.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/normalization.md) | Canonical key sort + per-field array sort rules |
| [`behaviors/transactions.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/transactions.md) | Single-writer mutex, commit-on-success, trailers |
| [`behaviors/patch-semantics.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/patch-semantics.md) | RFC 7396 Merge Patch |
| [`behaviors/indexing.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/indexing.md) | In-memory secondary indexes |
| [`behaviors/push-sync.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/push-sync.md) | Push daemon |
| [`behaviors/attachments.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/attachments.md) | Files colocated with a record |
| [`deferred.md`](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/deferred.md) | Features explicitly out of scope for v1.0 |

## TypeScript

`Sheet<T>` is generic over the record shape. With `openStore` and Standard
Schema validators, types flow from the consumer's schema through to every
read and write. Without validators, `Sheet<Record<string, unknown>>` —
JSON Schema still runs at runtime; only the TS-level shape is loose.

## Stability

Everything documented in [`specs/`](https://github.com/JarvusInnovations/gitsheets/tree/develop/specs)
is stable from v1.0 forward. Internal modules under `dist/` that aren't
re-exported from `gitsheets` are implementation details and may change in
minor releases.
