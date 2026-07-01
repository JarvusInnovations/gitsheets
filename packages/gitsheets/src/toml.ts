// TOML serialization helpers — thin marshalling over the Rust core's
// bytes-authority (`gitsheets-core::canonical`, exposed as the addon's
// `serializeRecords` / `parseRecords`).
//
// The core owns the canonical on-disk form: a value is serialized *fresh* from
// the object with a deep key sort and the `toml` crate's default formatting.
// This is the multi-binding bytes-authority — Node and Python serialize the
// same record to byte-identical TOML. It replaces the former JS split of
// `@iarna/toml` (stringify) + `smol-toml` (parse); see specs/rust-core.md and
// the canonical re-baseline note in specs/behaviors/normalization.md.

import { addon, callCore } from './core.js';
import { ConfigError } from './errors.js';

export type RecordLike = Record<string, unknown>;

/**
 * Serialize a record to canonical TOML — deep-sorted keys, byte-stable output,
 * produced by the core's bytes-authority.
 *
 * Array fields are NOT sorted here; sheet-level normalization rules
 * (`[gitsheet.fields.<name>.sort]`) handle that before this is called.
 */
export function stringifyRecord(record: RecordLike): string {
  return callCore(() => addon.serializeRecords([record]))[0]!;
}

export function parseToml(content: string): RecordLike {
  return callCore(() => addon.parseRecords([content]))[0] as RecordLike;
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
