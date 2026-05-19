import { encode } from '@toon-format/toon';

import type { FieldDef } from './schema.js';

/**
 * Render a list of items as a TOON table.
 *
 * Output:
 *   <name>[N]{col1,col2,col3}:
 *     val1,val2,val3
 *     val1,val2,val3
 */
export function renderList(
  name: string,
  items: Array<Record<string, unknown>>,
  schema: FieldDef[],
): string {
  const projected = items.map((item) =>
    Object.fromEntries(schema.map((f) => [f.name, f.extract(item) ?? ''])),
  );
  return encode({ [name]: projected });
}

export function renderObject(value: Record<string, unknown>): string {
  return encode(value);
}

export function renderHelp(suggestions: string[]): string {
  if (suggestions.length === 0) return '';
  return encode({ help: suggestions });
}

export function joinBlocks(...blocks: string[]): string {
  return blocks.filter((b) => b.length > 0).join('\n');
}

/**
 * Compose a list response with optional header, summary, items, and help.
 * Empty results collapse to a scalar message under the list's field name —
 * matches the AXI "definitive empty state" convention.
 */
export function renderListResponse(options: {
  header?: Record<string, unknown>;
  name: string;
  items: Array<Record<string, unknown>>;
  schema: FieldDef[];
  summary?: Record<string, unknown>;
  suggestions?: string[];
  emptyMessage?: string;
}): string {
  const blocks: string[] = [];
  if (options.header) blocks.push(renderObject(options.header));
  if (options.summary) blocks.push(renderObject(options.summary));

  if (options.items.length === 0) {
    blocks.push(
      renderObject({
        [options.name]: options.emptyMessage ?? `0 ${options.name} found`,
      }),
    );
  } else {
    blocks.push(renderList(options.name, options.items, options.schema));
  }

  if (options.suggestions?.length) {
    blocks.push(renderHelp(options.suggestions));
  }

  return joinBlocks(...blocks);
}
