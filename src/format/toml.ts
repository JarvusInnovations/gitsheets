// TOML format — the default. Records are stored as canonical TOML in a `.toml`
// file. Identity transform on header-only reads (TOML has no body concept).

import { parseToml, stringifyRecord } from '../toml.js';
import type { RecordLike } from '../path-template/index.js';
import type { Format, FormatConfig } from './index.js';

export const tomlFormat: Format = {
  extension: '.toml',

  serialize(record: RecordLike, _config: FormatConfig): string {
    return stringifyRecord(record);
  },

  parse(text: string, _config: FormatConfig): RecordLike {
    return parseToml(text);
  },

  parseHeaderOnly(text: string, _config: FormatConfig): RecordLike {
    return parseToml(text);
  },
};
