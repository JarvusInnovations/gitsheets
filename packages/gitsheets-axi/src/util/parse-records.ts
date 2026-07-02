import { AxiError } from 'axi-sdk-js';

export type RecordInputShape = 'single' | 'array' | 'ndjson';

export interface ParsedRecords {
  records: Array<Record<string, unknown>>;
  /** How the input was interpreted — for messaging only. */
  shape: RecordInputShape;
}

/**
 * Parse upsert input into a list of records, autodetecting the shape:
 *   - a single JSON object (pretty or compact) → one record
 *   - a JSON array of objects                   → batch
 *   - NDJSON (one compact object per line)       → batch
 *
 * Detection is unambiguous and needs no flag. We first try to parse the whole
 * input as one JSON value: an array or object settles it (this covers both
 * pretty-printed and compact forms). Only when whole-input parsing fails do we
 * fall back to NDJSON line-splitting — valid NDJSON is one compact object per
 * line, so a pretty-printed multi-line object never reaches that path.
 */
export function parseRecordsInput(raw: string): ParsedRecords {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new AxiError(
      'upsert needs a record — pass --data <json> or pipe JSON on stdin',
      'VALIDATION_ERROR',
      [
        'Accepts a JSON object, a JSON array of objects, or NDJSON (one object per line)',
      ],
    );
  }

  // Whole-input parse first: catches single object + array, pretty or compact.
  let whole: unknown;
  let wholeOk = true;
  try {
    whole = JSON.parse(trimmed);
  } catch {
    wholeOk = false;
  }

  if (wholeOk) {
    if (Array.isArray(whole)) {
      return { records: whole.map((r, i) => asObject(r, i)), shape: 'array' };
    }
    return { records: [asObject(whole, 0)], shape: 'single' };
  }

  // NDJSON fallback: one JSON object per non-blank line.
  const lines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const records = lines.map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new AxiError(
        `Could not parse input as JSON, a JSON array, or NDJSON — line ${i + 1} is not valid JSON`,
        'INVALID_JSON',
        [
          'Provide a JSON object, a JSON array of objects, or NDJSON (one compact object per line)',
        ],
      );
    }
    return asObject(parsed, i);
  });
  return { records, shape: 'ndjson' };
}

function asObject(value: unknown, index: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AxiError(
      `Record at position ${index + 1} is not a JSON object`,
      'VALIDATION_ERROR',
      ["Each record must be a JSON object with the sheet's fields"],
    );
  }
  return value as Record<string, unknown>;
}

/**
 * Pick a short human/agent-readable label for a record, used to name the
 * offending record when a batch upsert aborts on a bad row. Falls back to the
 * position when no obvious identifier field is present.
 */
export function recordLabel(record: Record<string, unknown>): string {
  for (const key of ['id', 'slug', 'name', 'key', 'path']) {
    const v = record[key];
    if (typeof v === 'string' && v.length > 0) return `${key}=${v}`;
    if (typeof v === 'number') return `${key}=${v}`;
  }
  return 'no id field';
}
