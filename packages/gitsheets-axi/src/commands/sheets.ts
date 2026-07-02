import { AxiError } from 'axi-sdk-js';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderListResponse, renderObject } from '../output/render.js';
import { display, field } from '../output/schema.js';
import { countRecords } from '../output/sheet-schema.js';
import { Template } from 'gitsheets';

export const SHEETS_HELP = `usage: gitsheets-axi sheets [<subcommand>] [flags]
subcommands[2]:
  list                  List sheets configured in this repository (default)
  view <name>           Show a single sheet's config + summary
examples:
  gitsheets-axi sheets
  gitsheets-axi sheets list
  gitsheets-axi sheets view users
`;

export async function sheetsCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 1 && args[0] === '--help') return SHEETS_HELP;

  const sub = args[0] ?? 'list';
  if (sub === 'list') return sheetsList(ctx);
  if (sub === 'view') return sheetsView(args.slice(1), ctx);
  if (sub === '--help') return SHEETS_HELP;

  throw new AxiError(`Unknown subcommand: ${sub}`, 'VALIDATION_ERROR', [
    'Subcommands: list, view',
  ]);
}

async function sheetsList(ctx: GitsheetsContext): Promise<string> {
  const repo = await ctx.repo();
  let sheets: Awaited<ReturnType<typeof repo.openSheets>>;
  try {
    sheets = await repo.openSheets();
  } catch (error) {
    throw translateError(error);
  }

  const summaries: Array<Record<string, unknown>> = [];
  for (const [name, sheet] of Object.entries(sheets)) {
    let format = 'toml';
    let root = '.';
    let records = 0;
    try {
      const config = await sheet.readConfig();
      format = config.format.type ?? 'toml';
      root = (config as { root?: string }).root ?? '.';
      records = await countRecords(sheet);
    } catch {
      // skip count on malformed config
    }
    summaries.push({ name, format, records, root });
  }
  summaries.sort((a, b) =>
    String(a['name']).localeCompare(String(b['name'])),
  );

  const help =
    summaries.length === 0
      ? ['No sheets — add `.gitsheets/<name>.toml` to declare one']
      : [
          'Run `gitsheets-axi sheets view <name>` to inspect a config',
          'Run `gitsheets-axi query <sheet>` to list records',
        ];

  return renderListResponse({
    name: 'sheets',
    items: summaries,
    schema: [
      field('name'),
      display('format'),
      field('records'),
      field('root'),
    ],
    suggestions: help,
    emptyMessage: 'no sheets configured in this repository',
  });
}

async function sheetsView(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  const name = args[0];
  if (!name || name.startsWith('-')) {
    throw new AxiError('sheets view requires a sheet name', 'VALIDATION_ERROR', [
      'Run `gitsheets-axi sheets view <name>`',
    ]);
  }
  const repo = await ctx.repo();
  let sheet;
  try {
    sheet = await repo.openSheet(name);
  } catch (error) {
    throw translateError(error);
  }

  let config;
  try {
    config = await sheet.readConfig();
  } catch (error) {
    throw translateError(error);
  }

  const template = Template.fromString(config.path);
  const pathFields = template.getFieldNames();

  const schemaProps = schemaPropertyList(config);
  const records = await countRecords(sheet);

  const output: Record<string, unknown> = {
    sheet: {
      name,
      root: (config as { root?: string }).root ?? '.',
      format: config.format.type ?? 'toml',
      path: config.path,
      records,
      path_fields: pathFields.length > 0 ? pathFields.join(', ') : '(none)',
    },
  };

  if (config.format.body) {
    (output['sheet'] as Record<string, unknown>)['body_field'] = config.format.body;
  }

  if (schemaProps.length > 0) {
    const schemaObj = (config as { schema?: Record<string, unknown> }).schema;
    const requiredList = schemaObj?.['required'];
    const required = new Set<string>(Array.isArray(requiredList) ? (requiredList as string[]) : []);
    output['schema'] = renderSchemaProperties(schemaProps, required);
  }

  output['help'] = [
    `Run \`gitsheets-axi query ${name}\` to list records`,
    `Run \`gitsheets-axi read ${name} <path>\` to view one record`,
  ];

  return renderObject(output);
}

function schemaPropertyList(
  config: { schema?: unknown },
): Array<[string, Record<string, unknown>]> {
  const schema = config.schema as Record<string, unknown> | undefined;
  if (!schema || typeof schema !== 'object') return [];
  const props = schema['properties'];
  if (!props || typeof props !== 'object') return [];
  return Object.entries(props as Record<string, Record<string, unknown>>);
}

function renderSchemaProperties(
  props: Array<[string, Record<string, unknown>]>,
  required: Set<string>,
): Record<string, string> {
  // Flat name → "type [required] enum: a|b|c" map for token-efficient display.
  // Surfacing the enum options lets an agent see allowed values before it
  // writes, instead of learning them from a rejected upsert.
  const out: Record<string, string> = {};
  for (const [name, schema] of props) {
    const type = String(schema['type'] ?? 'any');
    const format = schema['format'] ? ` (${String(schema['format'])})` : '';
    const req = required.has(name) ? ' [required]' : '';
    const enumVals = Array.isArray(schema['enum'])
      ? ` enum: ${(schema['enum'] as unknown[]).map(String).join('|')}`
      : '';
    out[name] = `${type}${format}${req}${enumVals}`;
  }
  return out;
}
