// Core loader — the single seam between the gitsheets JS package and the Rust
// engine (`gitsheets-core`) exposed through the `@gitsheets/core-napi` addon.
//
// This is the whole native dependency of the package: the bytes-authority
// (TOML canonical form, normalization, path rendering, JSON-Schema validation,
// the embedded engine, record CRUD/query/index/diff, markdown codec, and the
// Sheet/Transaction/Store state machine) all live in the core. The JS layer is
// a thin marshalling shell over it. See specs/rust-core.md.
//
// We load the RAW napi addon (`index.js`) rather than the addon's `binding.cjs`
// wrapper, because the wrapper constructs its OWN duplicate `GitsheetsError`
// subclasses. gitsheets maps the core's structured errors onto the canonical
// typed classes from `./errors.ts` here, so consumer `instanceof` checks against
// the package's exported error classes work.

import { createRequire } from 'node:module';

import type * as CoreAddon from '@gitsheets/core-napi';
import {
  ConfigError,
  GitsheetsError,
  IndexError,
  NotFoundError,
  PathTemplateError,
  RefError,
  TransactionError,
  ValidationError,
  type GitsheetsErrorCode,
  type ValidationIssue,
} from './errors.js';

const require = createRequire(import.meta.url);

/**
 * The raw napi addon. Loading the addon (a hard dependency — there is no JS
 * fallback) throws a clear `ConfigError` naming the unsupported platform rather
 * than letting a cryptic native-loader exception escape.
 */
function loadAddon(): typeof CoreAddon {
  try {
    return require('@gitsheets/core-napi/index.js') as typeof CoreAddon;
  } catch (err) {
    throw new ConfigError(
      'config_invalid',
      `gitsheets requires the @gitsheets/core-napi native addon, but it could not be ` +
        `loaded for this platform (${process.platform}-${process.arch}). ` +
        `Original load error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/** The raw addon namespace (functions + `CoreTransaction`/`CompiledDefinition`). */
export const addon: typeof CoreAddon = loadAddon();

// Re-export the stateful classes for the orchestration layer.
export const CoreTransaction = addon.CoreTransaction;
export type CoreTransaction = InstanceType<typeof CoreAddon.CoreTransaction>;

// --- Structured error mapping -------------------------------------------------

/**
 * The structured shape the core sets on every thrown JS `Error`: the stable
 * `code`, HTTP-ish `status`, the `gitsheetsClass` discriminant, and the
 * per-class payloads (`issues` / `conflictingPaths`). Mirrors
 * `rust/gitsheets-napi/src/lib.rs::throw_structured_error`.
 */
interface StructuredCoreError {
  readonly message: string;
  readonly code: GitsheetsErrorCode;
  readonly status: number;
  readonly gitsheetsClass: string;
  readonly issues?: readonly ValidationIssue[];
  readonly conflictingPaths?: readonly string[];
}

function isStructuredCoreError(raw: unknown): raw is StructuredCoreError {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as { gitsheetsClass?: unknown }).gitsheetsClass === 'string' &&
    typeof (raw as { code?: unknown }).code === 'string'
  );
}

/**
 * Map a structured core error onto its canonical typed class (keyed off the
 * `gitsheetsClass` discriminant, never the message) so consumers can
 * `instanceof` and switch on `err.code`. The raw error is carried as `cause`.
 */
export function mapCoreError(raw: StructuredCoreError): GitsheetsError {
  const code = raw.code;
  switch (raw.gitsheetsClass) {
    case 'ConfigError':
      return new ConfigError(code as 'config_missing' | 'config_invalid', raw.message, {
        cause: raw,
      });
    case 'ValidationError':
      return new ValidationError('validation_failed', raw.message, {
        issues: raw.issues ?? [],
        cause: raw,
      });
    case 'TransactionError':
      return new TransactionError(code as never, raw.message, { cause: raw });
    case 'IndexError':
      return new IndexError(
        code as 'index_unique_conflict' | 'index_not_defined',
        raw.message,
        raw.conflictingPaths !== undefined
          ? { conflictingPaths: raw.conflictingPaths, cause: raw }
          : { cause: raw },
      );
    case 'RefError':
      return new RefError(code as 'ref_not_found' | 'not_an_ancestor', raw.message, {
        cause: raw,
      });
    case 'PathTemplateError':
      return new PathTemplateError(
        code as 'path_render_failed' | 'path_invalid_chars',
        raw.message,
        { cause: raw },
      );
    case 'NotFoundError':
      return new NotFoundError('record_not_found', raw.message, { cause: raw });
    default:
      return new GitsheetsError(code, raw.message, { cause: raw });
  }
}

/**
 * Run a core call, translating any structured core error into its typed
 * gitsheets class. Non-structured throws (a genuine JS bug, an addon-load
 * failure) propagate unchanged.
 */
export function callCore<T>(fn: () => T): T {
  try {
    return fn();
  } catch (raw) {
    if (isStructuredCoreError(raw)) throw mapCoreError(raw);
    throw raw;
  }
}
