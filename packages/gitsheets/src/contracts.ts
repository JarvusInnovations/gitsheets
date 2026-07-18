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

/** Text format for a `string` input to {@link canonicalContractHash}. */
export type ContractDocumentFormat = 'json' | 'toml';

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
