import { scalarString } from './filter.js';

export interface Facet {
  value: string;
  count: number;
}

/**
 * Faceted counts of a field across records — the `--group-by` / `distinct`
 * primitive. Sorted by count descending, then value ascending, so the biggest
 * buckets read first. A missing field counts under the empty-string key.
 */
export function facetCounts(
  records: Array<Record<string, unknown>>,
  field: string,
): Facet[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const key = scalarString(r[field]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || compareStrings(a.value, b.value));
}

/** Sort records by a field. Undefined/null sort last regardless of direction. */
export function sortRecords(
  records: Array<Record<string, unknown>>,
  field: string,
  desc: boolean,
): Array<Record<string, unknown>> {
  const dir = desc ? -1 : 1;
  return [...records].sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    const am = av === undefined || av === null;
    const bm = bv === undefined || bv === null;
    if (am && bm) return 0;
    if (am) return 1; // missing always last
    if (bm) return -1;
    return dir * compareScalars(av, bv);
  });
}

function compareScalars(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b);
  if (a instanceof Date && b instanceof Date) return Math.sign(a.getTime() - b.getTime());
  return compareStrings(scalarString(a), scalarString(b));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
