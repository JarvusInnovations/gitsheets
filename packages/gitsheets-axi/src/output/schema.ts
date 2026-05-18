/**
 * Schema builders for TOON table rendering. Each FieldDef projects from a
 * source object (a gitsheets record or library response shape) onto a named
 * column in the output table. Modeled after the gws-axi pattern.
 *
 * Usage:
 *   const schema = [
 *     field('slug'),
 *     truncated('title', 60),
 *     computed('size', (r) => Buffer.byteLength(String(r.body ?? ''), 'utf-8')),
 *   ];
 *   renderList('records', items, schema);
 */

export interface FieldDef {
  name: string;
  extract: (item: Record<string, unknown>) => unknown;
}

export function field(name: string): FieldDef {
  return { name, extract: (item) => item[name] };
}

export function computed(
  name: string,
  fn: (item: Record<string, unknown>) => unknown,
): FieldDef {
  return { name, extract: fn };
}

/**
 * Truncate a string to `max` chars with ellipsis. Pass-through for non-strings.
 */
export function truncated(name: string, max: number, alias?: string): FieldDef {
  return {
    name: alias ?? name,
    extract: (item) => {
      const value = item[name];
      if (typeof value !== 'string') return value;
      return value.length > max ? `${value.slice(0, max - 1)}…` : value;
    },
  };
}

/**
 * Coerce a value to its display string. Empty for null/undefined; otherwise
 * `String(value)`. Useful when a column might hold numbers, dates, or strings.
 */
export function display(name: string, alias?: string): FieldDef {
  return {
    name: alias ?? name,
    extract: (item) => {
      const value = item[name];
      if (value === null || value === undefined) return '';
      if (value instanceof Date) return value.toISOString();
      return String(value);
    },
  };
}
