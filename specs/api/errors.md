# API: Errors

Typed exception classes with stable codes. Consumers switch on `instanceof` or `err.code` — never on `err.message`.

## Hierarchy

```typescript
export class GitsheetsError extends Error {
  readonly code: string;
  readonly status: number;        // HTTP-style hint for consumers building APIs
  readonly cause?: unknown;
}

export class ConfigError extends GitsheetsError {}
export class ValidationError extends GitsheetsError {
  readonly issues: ValidationIssue[];
}
export class TransactionError extends GitsheetsError {}
export class IndexError extends GitsheetsError {
  readonly conflictingPaths?: string[];
}
export class RefError extends GitsheetsError {}
export class PathTemplateError extends GitsheetsError {}
export class NotFoundError extends GitsheetsError {}
```

Every gitsheets exception extends `GitsheetsError`. Consumer catch blocks can typically use:

```typescript
try {
  await sheet.upsert(record);
} catch (err) {
  if (err instanceof ValidationError) {
    // err.issues
  } else if (err instanceof GitsheetsError) {
    // err.code
    // err.status
  } else {
    throw err;
  }
}
```

## Code table

| Class | Code | `status` | Meaning |
|---|---|---:|---|
| `ConfigError` | `config_missing` | 500 | `.gitsheets/<name>.toml` not found |
| `ConfigError` | `config_invalid` | 500 | Sheet config TOML malformed or schema unparseable |
| `ValidationError` | `validation_failed` | 422 | Record failed JSON Schema or Standard Schema validation |
| `TransactionError` | `transaction_in_progress` | 409 | Concurrent `repo.transact` attempt |
| `TransactionError` | `transaction_required` | 409 | Mutation outside a transaction in strict mode |
| `TransactionError` | `parent_moved` | 409 | Optimistic-concurrency conflict at commit |
| `TransactionError` | `commit_failed` | 500 | `git commit-tree` / `update-ref` non-zero |
| `TransactionError` | `push_daemon_running` | 409 | `repo.startPushDaemon` while one is already active |
| `IndexError` | `index_unique_conflict` | 409 | Unique index would be violated |
| `IndexError` | `index_not_defined` | 500 | `findByIndex` for an undeclared index |
| `RefError` | `ref_not_found` | 404 | Resolution of a ref / commit-hash failed |
| `RefError` | `not_an_ancestor` | 409 | Merge-like operation where src is not an ancestor of dst |
| `PathTemplateError` | `path_render_failed` | 422 | Template can't render against the record (missing fields, etc.) |
| `PathTemplateError` | `path_invalid_chars` | 422 | Rendered path contains characters disallowed by the filesystem (Windows, etc.) |
| `NotFoundError` | `record_not_found` | 404 | `delete` / `patch` / etc. against a path that doesn't exist |

The `code` strings are stable. New scenarios get new codes; existing codes never change meaning.

## ValidationIssue

```typescript
interface ValidationIssue {
  path: string[];          // e.g., ['email']
  message: string;         // human-readable
  source: 'json-schema' | 'standard-schema';
  schemaPath?: string;     // JSON Schema pointer when source === 'json-schema'
  code?: string;           // schema-keyword name (e.g., 'required', 'pattern')
}
```

Combined from both validation layers. The `source` field identifies which layer raised the issue.

## Why typed errors

The pre-v1.0 `errors.js` defined a few classes but consumer code (and even `backend/server.js`) routinely string-matched error messages (`err.message.startsWith('invalid tree ref')`). That couples consumers to error text and breaks on phrasing changes. v1.0 eliminates string-matching: every throwsite uses a typed class with a stable `code`.

## Migrating from pre-v1.0 names

| Pre-v1.0 | v1.0 |
|---|---|
| `SerializationError` | `ValidationError` (`validation_failed`) for record-validation cases; `ConfigError` (`config_invalid`) for sheet-config parse cases |
| `ConfigError` | `ConfigError` (with stable `code`) |
| `InvalidRefError` | `RefError` (`ref_not_found`) |
| `MergeError` | `RefError` (`not_an_ancestor`) |

The pre-v1.0 `errors.js` module is removed during the [#128 purge](https://github.com/JarvusInnovations/gitsheets/issues/128).

## Coordinates with

- All API specs throw from this taxonomy.
- [GitHub #136](https://github.com/JarvusInnovations/gitsheets/issues/136) tracks the implementation.
