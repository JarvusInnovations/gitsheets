// The contract identity primitive — `canonical_contract_hash` exposed to JS.
// See specs/behaviors/contracts.md "Canonical form" / "Contract identity".
//
// This is deliberately the ONLY new public API surface this layer adds for
// schema contracts: `implements` declaration and composed enforcement ride
// the existing `openSheet`/`upsert` write path (the core resolves and
// composes contracts internally at sheet-open) and need no new binding
// entry point. The identity primitive is the one piece a consumer calls
// directly — to compute a contract document's identity for vendoring or for
// rung-1 (declared-identity) verification.

import { addon, callCore } from './core.js';
import type { ValidationIssue } from './errors.js';

/** Text format for a `string` input to {@link canonicalContractHash}. */
export type ContractDocumentFormat = 'json' | 'toml';

/**
 * Consumer verification modes — the two-rung ladder in
 * specs/behaviors/contracts.md "Consumer verification":
 *
 * - `'verify'` (default) — rung 1 (declared identity), falling back to rung 2
 *   (structural) on a miss.
 * - `'declared'` — rung 1 only; never reads records. A miss throws
 *   immediately.
 * - `'structural'` — rung 2 only (duck typing; ignores any declaration).
 */
export type ContractVerificationMode = 'verify' | 'declared' | 'structural';

/**
 * The result of a successful consumer verification — `sheet.contractVerification`
 * (specs/api/repository.md `opts.contract`). `rung` names which guarantee was
 * actually obtained; `tree` is the read-snapshot tree hash it's pinned to.
 */
export interface ConformanceReport {
  readonly name: string;
  readonly rung: 'declared' | 'structural';
  readonly tree: string;
  readonly conforming: boolean;
  readonly issues: readonly ValidationIssue[];
}

/**
 * `openSheet(name, { contract })` options — consumer-side contract
 * verification per specs/behaviors/contracts.md "Consumer verification".
 */
export interface OpenSheetContractOptions {
  /** The contract document the consumer holds: parsed data, or JSON/TOML text. */
  readonly schema: unknown;
  /**
   * Required when `schema` is a string — matches {@link canonicalContractHash}:
   * there is no format auto-detection.
   */
  readonly format?: ContractDocumentFormat;
  /** Default `'verify'`. */
  readonly mode?: ContractVerificationMode;
  /**
   * Advisory drift signal for rung-2 (structural) verified sheets: invoked
   * with a regressed conformance report when a rebind to a changed tree
   * (specs/behaviors/freshness.md) finds the sheet no longer conforms. Reads
   * are never blocked by drift — this is a signal, not a gate. Not invoked
   * for rung-1 (declared) verified sheets — write-time enforcement makes
   * that guarantee good going forward, by construction.
   */
  readonly onDrift?: (report: ConformanceReport) => void;
}

export interface CanonicalContractHashOptions {
  /**
   * Which text format `input` is, when `input` is a `string`. Required in
   * that case — there is no format auto-detection, so omitting it throws a
   * `ConfigError`.
   */
  readonly format?: ContractDocumentFormat;
}

/**
 * The contract identity primitive: canonicalize a contract document —
 * supplied as already-parsed data (an object/array/etc.), JSON text, or TOML
 * text — through the canonical TOML encoder, then return the SHA-256 hex
 * digest of the resulting bytes.
 *
 * Two parties computing this over the same logical document get the
 * identical hash regardless of which of the three input forms they hold it
 * in (specs/behaviors/contracts.md "Canonical form": "Byte-equality ≡
 * data-equality") — this is what makes rung-1 consumer verification (byte
 * identity against the vendored copy) and the git-blob-OID equivalence work.
 *
 * @example
 * ```ts
 * canonicalContractHash({ $id: 'https://example.com/c/v1', type: 'object' });
 * canonicalContractHash(jsonText, { format: 'json' });
 * canonicalContractHash(tomlText, { format: 'toml' });
 * ```
 */
export function canonicalContractHash(
  input: unknown,
  options?: CanonicalContractHashOptions,
): string {
  return callCore(() => addon.canonicalContractHash(input as never, options?.format));
}
