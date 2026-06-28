// TOML serialization helpers with canonical key sorting.
// See specs/behaviors/normalization.md for the byte-stable normalization rules.
//
// We deliberately use two different TOML libraries, split by direction:
//
//   parse     → smol-toml   (reads — the hot, memory-sensitive path)
//   stringify → @iarna/toml (writes — preserves the byte-stable canonical form)
//
// Why: @iarna/toml's parser emits string values as V8 sliced/cons-strings that
// transitively pin large parser buffers — each parsed record retains ~12x its
// source size, so a consumer holding a full dataset in memory pays a ~5–6x heap
// blowup (observed: a 31.8k-record store needed >500 MB of heap for ~25 MB of
// TOML). smol-toml's parser produces flat strings and retains ~2x source size,
// eliminating that leak at the root. It is also actively maintained and full
// TOML 1.0 (vs @iarna's frozen 1.0.0-rc.1).
//
// We keep @iarna/toml for stringify because its output is what the on-disk
// canonical form already is: it preserves human-readable multiline strings
// (triple-quoted markdown bodies) and literal-quoted strings, where smol-toml
// would escape both to single-line — a ~32% cosmetic byte-churn across a real
// corpus, with no data change. Serialization isn't memory-sensitive (one record
// at a time), so there's no reason to take that churn. Verified: smol parse →
// @iarna stringify round-trips losslessly, and TOML date types stay
// `instanceof Date` with identical serialized output.

import * as TOML from '@iarna/toml';
import { parse as smolParse } from 'smol-toml';
import sortKeys from 'sort-keys';

import { ConfigError } from './errors.js';

export type RecordLike = Record<string, unknown>;

// The hologit package augments '@iarna/toml' with only `parse`, so the
// `stringify` export isn't seen by tsc. Wrap once here. (We only use its
// `stringify`; parsing goes through smol-toml — see the module header.)
interface TomlModule {
  parse: (content: string) => Record<string, unknown>;
  stringify: (obj: Record<string, unknown>) => string;
}
const toml = TOML as unknown as TomlModule;

/**
 * Serialize a record to canonical TOML — deep-sorted keys for byte-stable output.
 *
 * Array fields are NOT sorted here; sheet-level normalization rules
 * (`[gitsheet.fields.<name>.sort]`) handle that before this is called.
 */
export function stringifyRecord(record: RecordLike): string {
  const sorted = sortKeys(record, { deep: true }) as Record<string, unknown>;
  return toml.stringify(sorted);
}

export function parseToml(content: string): RecordLike {
  // `integersAsBigInt: 'asNeeded'` mirrors @iarna's behavior: integers within
  // the safe range stay `number`, larger ones become `BigInt` (lossless).
  return smolParse(content, { integersAsBigInt: 'asNeeded' }) as RecordLike;
}

export function parseConfigToml(content: string, sourcePath: string): RecordLike {
  try {
    return parseToml(content);
  } catch (err) {
    throw new ConfigError(
      'config_invalid',
      `failed to parse TOML at ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
