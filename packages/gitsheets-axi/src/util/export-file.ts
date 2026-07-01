import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { stringify as csvStringify } from 'csv-stringify/sync';

export type ExportFormat = 'json' | 'ndjson' | 'csv';

export interface ExportResult {
  path: string;
  rows: number;
  cols: number;
  columns: string[];
}

/**
 * Write the full record set to a side-channel file — the metabase-axi export
 * pattern (see kunchenguid/axi#32). This is purely additive: stdout keeps the
 * agent-optimized TOON preview; the file carries the complete payload only when
 * an export flag is passed. A bare flag auto-generates an owner-only (0600)
 * file under the OS temp dir (which the OS prunes); an explicit `=path`
 * persists wherever the caller points it.
 *
 * The JSON/NDJSON files are written verbatim (no injected fields), so they
 * round-trip straight back into `gitsheets-axi upsert` — JSON array for `json`,
 * one object per line for `ndjson`. CSV is flat: nested values are JSON-encoded
 * into their cell, so it's a lossy view for reporting, not a round-trip format.
 */
export function exportRecords(
  records: Array<Record<string, unknown>>,
  format: ExportFormat,
  explicitPath: string | undefined,
  sheetName: string,
): ExportResult {
  const path = explicitPath ?? autoPath(sheetName, format);
  mkdirSync(dirname(path), { recursive: true });

  const columns = unionColumns(records);
  const body = serialize(records, format, columns);
  writeFileSync(path, body, { mode: 0o600 });

  return { path, rows: records.length, cols: columns.length, columns };
}

function serialize(
  records: Array<Record<string, unknown>>,
  format: ExportFormat,
  columns: string[],
): string {
  if (format === 'ndjson') {
    return (
      records.map((r) => JSON.stringify(r)).join('\n') +
      (records.length > 0 ? '\n' : '')
    );
  }
  if (format === 'csv') {
    // Flat CSV: a stable header (union of keys) + one row per record. Nested
    // values (arrays / tables) are JSON-encoded so cells never read as
    // "[object Object]"; this makes CSV a lossy reporting view, not lossless.
    return csvStringify(records, {
      header: true,
      columns,
      cast: {
        object: (v) => JSON.stringify(v),
        boolean: (v) => (v ? 'true' : 'false'),
      },
    });
  }
  return JSON.stringify(records);
}

function autoPath(sheetName: string, format: ExportFormat): string {
  const dir = join(tmpdir(), 'gitsheets-axi');
  const ext = format;
  const safe = sheetName.replace(/[^A-Za-z0-9_.-]/g, '_') || 'sheet';
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return join(dir, `${safe}-${stamp}.${ext}`);
}

/** Keys across all records, first-seen order — the exported file's columns. */
function unionColumns(records: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }
  return cols;
}
