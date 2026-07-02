import { AxiError } from 'axi-sdk-js';

/**
 * A parsed `--filter` clause: the field it targets and a predicate over that
 * field's value (with the whole record available for completeness).
 */
export interface FilterClause {
  field: string;
  op: string;
  test: (value: unknown, record: Record<string, unknown>) => boolean;
}

/**
 * Parse the axi `--filter` mini-DSL. One clause per `--filter` arg; multiple
 * clauses AND together. Supported forms (checked in this order):
 *
 *   field:present            field exists and is non-empty
 *   field:empty              field is absent / null / '' / []
 *   field in (a,b,c)         value is one of the listed strings
 *   field!=value             not equal
 *   field>=value  field<=value  field>value  field<value   comparison
 *   field~regex              String(value) matches the JS regex
 *   field=value              equality (the original behavior)
 *
 * Comparison is numeric when the field holds a number, time-based for Date
 * fields, else lexical (ISO-8601 date strings sort correctly).
 */
export function parseFilter(expr: string): FilterClause {
  const trimmed = expr.trim();

  // Suffix existence operators.
  let m = /^([\w.]+):(present|empty)$/.exec(trimmed);
  if (m) {
    const field = m[1]!;
    const kind = m[2]!;
    return {
      field,
      op: `:${kind}`,
      test: (v) => (kind === 'present' ? isPresent(v) : !isPresent(v)),
    };
  }

  // Set membership: field in (a, b, c)
  m = /^([\w.]+)\s+in\s+\((.*)\)$/i.exec(trimmed);
  if (m) {
    const field = m[1]!;
    const set = new Set(
      m[2]!
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    return { field, op: 'in', test: (v) => set.has(scalarString(v)) };
  }

  // Binary operators, longest token first so `!=`/`>=`/`<=` beat `=`/`>`/`<`.
  for (const op of ['!=', '>=', '<=', '~', '>', '<', '=']) {
    const idx = trimmed.indexOf(op);
    if (idx <= 0) continue;
    const field = trimmed.slice(0, idx).trim();
    const rhs = trimmed.slice(idx + op.length).trim();
    if (!/^[\w.]+$/.test(field)) break; // not a clean field → malformed
    return { field, op, test: binaryTest(op, rhs, expr) };
  }

  throw new AxiError(
    `Could not parse --filter "${expr}"`,
    'VALIDATION_ERROR',
    [
      'Forms: k=v · k!=v · k<v · k>v · k<=v · k>=v · k~regex · "k in (a,b)" · k:present · k:empty',
    ],
  );
}

/** Compose many `--filter` clauses into one AND predicate over a record. */
export function buildPredicate(
  exprs: string[],
): (record: Record<string, unknown>) => boolean {
  if (exprs.length === 0) return () => true;
  const clauses = exprs.map(parseFilter);
  return (record) => clauses.every((c) => c.test(record[c.field], record));
}

function binaryTest(
  op: string,
  rhs: string,
  expr: string,
): (value: unknown) => boolean {
  if (op === '~') {
    let re: RegExp;
    try {
      re = new RegExp(rhs);
    } catch (error) {
      throw new AxiError(
        `Invalid regex in --filter "${expr}": ${error instanceof Error ? error.message : String(error)}`,
        'VALIDATION_ERROR',
      );
    }
    return (v) => v !== undefined && v !== null && re.test(String(v));
  }
  if (op === '=') return (v) => valueEquals(v, rhs);
  if (op === '!=') return (v) => !valueEquals(v, rhs);
  // Ordered comparisons.
  return (v) => {
    const c = compareValue(v, rhs);
    if (c === undefined) return false;
    if (op === '>') return c > 0;
    if (op === '<') return c < 0;
    if (op === '>=') return c >= 0;
    return c <= 0; // '<='
  };
}

function valueEquals(value: unknown, rhs: string): boolean {
  if (typeof value === 'number') return value === Number(rhs);
  if (typeof value === 'boolean') return String(value) === rhs;
  if (value instanceof Date) return value.toISOString() === rhs || String(value) === rhs;
  if (value === undefined || value === null) return rhs === '';
  return String(value) === rhs;
}

/** -1 / 0 / 1 comparing `value` to the RHS string, or undefined if incomparable. */
function compareValue(value: unknown, rhs: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    const n = Number(rhs);
    if (Number.isNaN(n)) return undefined;
    return Math.sign(value - n);
  }
  if (value instanceof Date) {
    const t = Date.parse(rhs);
    if (Number.isNaN(t)) return undefined;
    return Math.sign(value.getTime() - t);
  }
  const a = String(value);
  return a < rhs ? -1 : a > rhs ? 1 : 0;
}

function isPresent(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

/** Stable string form for set membership / grouping keys. */
export function scalarString(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
