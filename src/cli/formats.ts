// Input/output format adapters for the CLI (#145).
//
// `upsert` accepts JSON | TOML | CSV input.
// `query` and `read` produce JSON | TOML | CSV | TSV output.
// Encoding (`--encoding`) controls how on-disk inputs are decoded.

import { parse as csvParse } from 'csv-parse/sync';
import { stringify as csvStringify } from 'csv-stringify/sync';

import { stringifyRecord, parseToml } from '../toml.js';
import { RECORD_PATH_KEY, RECORD_SHEET_KEY } from '../sheet.js';
import type { RecordLike } from '../path-template/index.js';

export type InputFormat = 'json' | 'toml' | 'csv';
export type OutputFormat = 'json' | 'toml' | 'csv' | 'tsv';

/** Map a file extension (without the dot) to an input format. */
export function inferInputFormat(input: string | undefined): InputFormat {
  if (!input || input === '-') return 'json';
  const lower = input.toLowerCase();
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.csv')) return 'csv';
  return 'json';
}

/**
 * Parse input text into an array of records, given the format.
 *
 * - JSON: a single object, an array, or JSONL (one object per line).
 * - TOML: either a single record (the document maps to one record), an array
 *   of records under `[[records]]`, or any top-level table where every value
 *   is itself a table (each becomes a record keyed by table name).
 * - CSV: the first row is the header. Each subsequent row is one record.
 *   Numeric strings stay as strings — type coercion belongs in the consumer
 *   schema, not in CSV parsing.
 */
export function parseRecords(text: string, format: InputFormat): RecordLike[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (format === 'json') {
    if (trimmed.startsWith('[')) {
      const arr = JSON.parse(trimmed);
      if (!Array.isArray(arr)) throw new Error('expected JSON array of records');
      return arr as RecordLike[];
    }
    if (trimmed.startsWith('{')) {
      return [JSON.parse(trimmed) as RecordLike];
    }
    // JSONL fallback
    return trimmed
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RecordLike);
  }

  if (format === 'toml') {
    const parsed = parseToml(text);
    // [[records]] convention: an array of tables under the key "records"
    if (
      'records' in parsed &&
      Array.isArray((parsed as { records?: unknown }).records)
    ) {
      return (parsed as { records: RecordLike[] }).records;
    }
    // If every top-level value is a table, treat each as a record
    const entries = Object.entries(parsed);
    const allTables =
      entries.length > 0 &&
      entries.every(
        ([, v]) =>
          typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date),
      );
    if (allTables) {
      return entries.map(([, v]) => v as RecordLike);
    }
    // Otherwise, treat the document as a single record.
    return [parsed];
  }

  // CSV
  const rows = csvParse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true,
  }) as Record<string, string>[];
  return rows.map((row) => ({ ...row }));
}

/**
 * Stringify a single record into one piece of output text for the given
 * format. For CSV / TSV, the caller drives header emission; this function
 * formats one row only.
 */
export function stringifyRecord_text(
  record: RecordLike,
  format: OutputFormat,
  fields?: readonly string[],
): string {
  const projected = projectRecord(record, fields);
  if (format === 'json') return `${JSON.stringify(projected)}\n`;
  if (format === 'toml') return stringifyRecord(stripGitsheetsSymbols(projected));
  if (format === 'csv' || format === 'tsv') {
    return csvStringify([projected], {
      header: false,
      delimiter: format === 'tsv' ? '\t' : ',',
    });
  }
  throw new Error(`unsupported output format: ${String(format as unknown)}`);
}

/**
 * Emit a CSV / TSV header row from a list of column names.
 */
export function csvHeader(columns: readonly string[], format: 'csv' | 'tsv'): string {
  return csvStringify([columns], {
    header: false,
    delimiter: format === 'tsv' ? '\t' : ',',
  });
}

/**
 * Project a record to a subset of fields (in given order). When `fields` is
 * undefined the record is returned with symbol keys stripped but otherwise
 * unchanged.
 */
function projectRecord(record: RecordLike, fields?: readonly string[]): RecordLike {
  const cleaned = stripGitsheetsSymbols(record);
  if (!fields) return cleaned;
  const out: RecordLike = {};
  for (const field of fields) {
    if (field in cleaned) out[field] = cleaned[field] as unknown as RecordLike[string];
  }
  return out;
}

function stripGitsheetsSymbols(record: RecordLike): RecordLike {
  // Object spread retains string-keyed enumerable props, drops symbols.
  // Defensive: also delete the well-known symbols in case a future change
  // produces them in non-spread ways.
  const out: RecordLike = { ...record };
  delete (out as Record<symbol, unknown>)[RECORD_PATH_KEY];
  delete (out as Record<symbol, unknown>)[RECORD_SHEET_KEY];
  return out;
}

export function validateInputFormat(s: string | undefined): InputFormat | undefined {
  if (s === undefined) return undefined;
  if (s === 'json' || s === 'toml' || s === 'csv') return s;
  throw new Error(`--format must be one of: json, toml, csv (got "${s}")`);
}

export function validateOutputFormat(s: string | undefined): OutputFormat | undefined {
  if (s === undefined) return undefined;
  if (s === 'json' || s === 'toml' || s === 'csv' || s === 'tsv') return s;
  throw new Error(`--format must be one of: json, toml, csv, tsv (got "${s}")`);
}
