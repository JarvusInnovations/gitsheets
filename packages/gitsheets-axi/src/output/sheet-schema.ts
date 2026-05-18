import type { Sheet, SheetConfig } from 'gitsheets';
import { Template } from 'gitsheets';

import { computed, field, truncated, type FieldDef } from './schema.js';

/**
 * Body-size column for content-typed sheets. Reports the configured body
 * field's byte length so agents see at a glance which records are long.
 */
function bodySizeField(bodyField: string): FieldDef {
  return computed('body_size', (item) => {
    const value = (item as Record<string, unknown>)[bodyField];
    if (typeof value !== 'string') return '';
    return `${Buffer.byteLength(value, 'utf-8')}`;
  });
}

/**
 * Build the default TOON schema for `query` against a sheet. Introspects
 * the sheet's path template + format config so:
 *   - TOML sheets show path-template fields plus a couple of scalar fields
 *     from the JSON Schema (whatever's named first).
 *   - Markdown/mdx sheets show path-template fields, `title` (denormalized
 *     from body's H1 once #169 lands; currently a frontmatter field), and
 *     `body_size` — never the body content.
 *
 * Capped at ~4 columns total to stay within the AXI "minimal default schema"
 * budget. Consumers extend via `--fields`.
 */
export function defaultSheetSchema(config: SheetConfig): FieldDef[] {
  const template = Template.fromString(config.path);
  const pathFields = template.getFieldNames();
  const bodyField = config.format.body;
  const fields: FieldDef[] = [];
  const seen = new Set<string>();

  for (const name of pathFields) {
    if (seen.has(name)) continue;
    seen.add(name);
    fields.push(field(name));
  }

  if (bodyField !== undefined) {
    // Markdown/MDX: include `title` if the schema declares it, then body size.
    if (!seen.has('title') && schemaHasProperty(config, 'title')) {
      seen.add('title');
      fields.push(truncated('title', 60));
    }
    if (!seen.has('body_size')) {
      seen.add('body_size');
      fields.push(bodySizeField(bodyField));
    }
    return fields.slice(0, 4);
  }

  // TOML: pad out with the first few non-template scalar properties from the
  // JSON schema, capped at 4 total. Skips array/object properties — those
  // don't tabulate well.
  const props = schemaProperties(config);
  for (const [name, prop] of props) {
    if (fields.length >= 4) break;
    if (seen.has(name)) continue;
    if (!isScalarSchema(prop)) continue;
    seen.add(name);
    fields.push(field(name));
  }

  return fields;
}

function schemaProperties(config: SheetConfig): Array<[string, unknown]> {
  const schema = config.schema as Record<string, unknown> | undefined;
  if (!schema || typeof schema !== 'object') return [];
  const props = schema['properties'];
  if (!props || typeof props !== 'object') return [];
  return Object.entries(props as Record<string, unknown>);
}

function schemaHasProperty(config: SheetConfig, name: string): boolean {
  return schemaProperties(config).some(([n]) => n === name);
}

function isScalarSchema(prop: unknown): boolean {
  if (!prop || typeof prop !== 'object') return false;
  const type = (prop as Record<string, unknown>)['type'];
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') {
    return true;
  }
  return false;
}

/**
 * Resolve the field list for a list-rendering command, optionally extending
 * the default schema with user-supplied `--fields a,b,c` entries.
 */
export function fieldsWithExtras(
  defaults: FieldDef[],
  extras: string[],
): FieldDef[] {
  if (extras.length === 0) return defaults;
  const out = [...defaults];
  const seen = new Set(out.map((f) => f.name));
  for (const name of extras) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(field(name));
  }
  return out;
}

/**
 * Count records in a sheet. Uses queryAll under the hood — fine for repos
 * with thousands of records; cap-checking is the consumer's job if their
 * corpus pushes higher.
 */
export async function countRecords(sheet: Sheet): Promise<number> {
  const rows = await sheet.queryAll({}, { withBody: false });
  return rows.length;
}
