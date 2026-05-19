import { AxiError } from 'axi-sdk-js';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderListResponse } from '../output/render.js';
import { field } from '../output/schema.js';
import {
  defaultSheetSchema,
  fieldsWithExtras,
} from '../output/sheet-schema.js';

export const QUERY_HELP = `usage: gitsheets-axi query <sheet> [--filter k=v ...] [--fields a,b,c] [--limit n]
flags[4]:
  --filter <k>=<v>     Equality match against record field (repeatable)
  --fields <list>      Extra columns beyond the default schema (comma-separated)
  --limit <n>          Cap results (default: 100, max: 10000)
  --prefix <p>         Tenant sub-tree scope (see gitsheets --prefix)
examples:
  gitsheets-axi query users
  gitsheets-axi query users --filter status=active --limit 50
  gitsheets-axi query posts --fields title,published
output:
  Default schema is format-aware:
    TOML sheets    — path-template fields + first scalar properties (cap 4)
    Markdown/MDX   — path-template fields + title + body_size (never body content)
  --fields appends additional columns.
`;

interface QueryFlags {
  filters: Array<[string, string]>;
  extras: string[];
  limit: number;
  prefix: string | undefined;
}

function parseQueryFlags(args: string[]): { sheetName: string; flags: QueryFlags } {
  const sheetName = args[0];
  if (!sheetName || sheetName.startsWith('-')) {
    throw new AxiError('query requires a sheet name', 'VALIDATION_ERROR', [
      'Run `gitsheets-axi query <sheet>`',
    ]);
  }

  const flags: QueryFlags = {
    filters: [],
    extras: [],
    limit: 100,
    prefix: undefined,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '--filter': {
        if (!next || !next.includes('=')) {
          throw new AxiError(
            '--filter expects key=value',
            'VALIDATION_ERROR',
            ['Example: --filter status=active'],
          );
        }
        const eq = next.indexOf('=');
        flags.filters.push([next.slice(0, eq), next.slice(eq + 1)]);
        i++;
        break;
      }
      case '--fields':
        if (!next) {
          throw new AxiError('--fields expects a comma-separated list', 'VALIDATION_ERROR');
        }
        flags.extras = next.split(',').map((s) => s.trim()).filter(Boolean);
        i++;
        break;
      case '--limit':
        if (!next) {
          throw new AxiError('--limit expects an integer', 'VALIDATION_ERROR');
        }
        flags.limit = Math.min(10_000, Math.max(1, parseInt(next, 10) || 100));
        i++;
        break;
      case '--prefix':
        if (!next) {
          throw new AxiError('--prefix expects a path', 'VALIDATION_ERROR');
        }
        flags.prefix = next;
        i++;
        break;
      default:
        throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
          'Run `gitsheets-axi query --help` to see supported flags',
        ]);
    }
  }

  return { sheetName, flags };
}

export async function queryCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return QUERY_HELP;
  }

  const { sheetName, flags } = parseQueryFlags(args);
  const repo = await ctx.repo();

  let sheet;
  try {
    sheet = await repo.openSheet(
      sheetName,
      flags.prefix !== undefined ? { prefix: flags.prefix } : {},
    );
  } catch (error) {
    throw translateError(error);
  }

  const config = await sheet.readConfig();
  const filter: Record<string, unknown> = {};
  for (const [k, v] of flags.filters) {
    filter[k] = v;
  }

  // Load bodies for content-typed sheets so the body_size column renders
  // correctly. We never put body content itself into the default schema —
  // per AXI's "long-form content belongs in detail views, not lists" — but
  // the size is the cheap, agent-actionable summary.
  const withBody = config.format.body !== undefined;

  let records;
  try {
    records = await sheet.queryAll(filter, { withBody });
  } catch (error) {
    throw translateError(error);
  }

  const total = records.length;
  const limited = records.slice(0, flags.limit);

  const baseSchema = defaultSheetSchema(config);
  const schema = fieldsWithExtras(baseSchema, flags.extras);

  const suggestions: string[] = [];
  if (limited.length === 0 && flags.filters.length > 0) {
    suggestions.push(
      'No records match the filter — try `gitsheets-axi query ' +
        sheetName +
        '` without filters',
    );
  } else if (limited.length > 0) {
    suggestions.push(
      `Run \`gitsheets-axi read ${sheetName} <path>\` to view a single record`,
    );
    if (config.format.body) {
      suggestions.push(
        `Add \`--full\` on \`read\` to see untruncated body content`,
      );
    }
  }
  if (total > limited.length) {
    suggestions.push(
      `${total - limited.length} records hidden by --limit ${flags.limit}; raise --limit to see more`,
    );
  }

  return renderListResponse({
    summary: { count: `${limited.length} of ${total} total` },
    name: 'records',
    items: limited.map((r) => ({
      ...r,
      // Surface the record's source path as a top-level "path" so default
      // schemas that include it work without callers needing to know the
      // RECORD_PATH_KEY symbol.
      path: (r as Record<symbol, unknown>)[Symbol.for('gitsheets-path')] ?? '',
    })) as Array<Record<string, unknown>>,
    schema: [...schema, field('path')],
    suggestions,
    emptyMessage: `no records in ${sheetName}`,
  });
}
