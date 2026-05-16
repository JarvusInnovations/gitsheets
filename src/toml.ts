// TOML serialization helpers with canonical key sorting.
// See specs/behaviors/normalization.md for the byte-stable normalization rules.

import * as TOML from '@iarna/toml';
import sortKeys from 'sort-keys';

import { ConfigError } from './errors.js';

export type RecordLike = Record<string, unknown>;

// The hologit package augments '@iarna/toml' with only `parse`, so the
// `stringify` export isn't seen by tsc. Wrap once here.
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
  return toml.parse(content);
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
