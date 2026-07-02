import { AxiError } from 'axi-sdk-js';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import {
  joinBlocks,
  renderHelp,
  renderListResponse,
  renderObject,
} from '../output/render.js';
import { field } from '../output/schema.js';
import {
  defaultSheetSchema,
  fieldsWithExtras,
} from '../output/sheet-schema.js';
import { openSheetForCommand } from '../util/open-sheet.js';
import { exportRecords, type ExportFormat } from '../util/export-file.js';
import { buildPredicate } from '../util/filter.js';
import { facetCounts, sortRecords } from '../util/aggregate.js';

export const QUERY_HELP = `usage: gitsheets-axi query <sheet> [--filter expr ...] [--fields a,b] [--sort f [--desc]] [--limit n] [--group-by f] [--json-out[=path]] [--ndjson-out[=path]] [--csv-out[=path]]
flags[9]:
  --filter <expr>      Filter clause (repeatable): k=v · k!=v · k<v · k>v ·
                       k<=v · k>=v · k~regex · "k in (a,b)" · k:present · k:empty
  --fields <list>      Extra columns beyond the default schema (comma-separated)
  --sort <field>       Sort records by a field (missing values sort last)
  --desc               Sort descending (with --sort)
  --limit <n>          Cap the stdout preview (default: 100, max: 10000)
  --group-by <field>   Faceted counts by a field instead of a record list
  --prefix <p>         Tenant sub-tree scope
  --json-out[=path]    Also write the FULL matched result to a JSON array file
  --ndjson-out[=path]  Also write the FULL matched result to an NDJSON file
  --csv-out[=path]     Also write the FULL matched result to a CSV file (flat)
examples:
  gitsheets-axi query repos --filter status=unclassified
  gitsheets-axi query repos --filter 'pushed_at<2022-01-01' --sort pushed_at
  gitsheets-axi query repos --group-by target_team
  gitsheets-axi query repos --filter 'target_team in (archive,sencha)' --ndjson-out
output:
  Default schema is format-aware (TOML: path fields + first scalars, cap 4;
  Markdown: path fields + title + body_size). --fields appends columns.
  --group-by emits {value,count} facets (biggest first) over the filtered set.
export (--json-out / --ndjson-out / --csv-out):
  stdout stays the TOON preview; the file carries EVERY matched record (ignores
  --limit). JSON/NDJSON verbatim (round-trip into upsert); CSV flat + lossy.
`;

interface QueryFlags {
  filters: string[];
  extras: string[];
  limit: number;
  prefix: string | undefined;
  sort: string | undefined;
  desc: boolean;
  groupBy: string | undefined;
  exportFormat: ExportFormat | undefined;
  exportPath: string | undefined;
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
    sort: undefined,
    desc: false,
    groupBy: undefined,
    exportFormat: undefined,
    exportPath: undefined,
  };

  const setExport = (format: ExportFormat, arg: string): void => {
    if (flags.exportFormat) {
      throw new AxiError('Only one export flag is allowed per invocation', 'VALIDATION_ERROR', [
        'Pass one of --json-out / --ndjson-out / --csv-out',
      ]);
    }
    flags.exportFormat = format;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      const p = arg.slice(eq + 1);
      if (!p) {
        throw new AxiError(`${arg.slice(0, eq)} was given an empty path`, 'VALIDATION_ERROR', [
          'Use the bare flag for an auto temp path, or --…-out=/real/path',
        ]);
      }
      flags.exportPath = p;
    }
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === '--json-out' || arg.startsWith('--json-out=')) {
      setExport('json', arg);
      continue;
    }
    if (arg === '--ndjson-out' || arg.startsWith('--ndjson-out=')) {
      setExport('ndjson', arg);
      continue;
    }
    if (arg === '--csv-out' || arg.startsWith('--csv-out=')) {
      setExport('csv', arg);
      continue;
    }

    const next = args[i + 1];
    switch (arg) {
      case '--filter':
        if (!next) throw new AxiError('--filter expects an expression', 'VALIDATION_ERROR');
        flags.filters.push(next);
        i++;
        break;
      case '--fields':
        if (!next) throw new AxiError('--fields expects a comma-separated list', 'VALIDATION_ERROR');
        flags.extras = next.split(',').map((s) => s.trim()).filter(Boolean);
        i++;
        break;
      case '--sort':
        if (!next) throw new AxiError('--sort expects a field name', 'VALIDATION_ERROR');
        flags.sort = next;
        i++;
        break;
      case '--desc':
        flags.desc = true;
        break;
      case '--group-by':
        if (!next) throw new AxiError('--group-by expects a field name', 'VALIDATION_ERROR');
        flags.groupBy = next;
        i++;
        break;
      case '--limit':
        if (!next) throw new AxiError('--limit expects an integer', 'VALIDATION_ERROR');
        flags.limit = Math.min(10_000, Math.max(1, parseInt(next, 10) || 100));
        i++;
        break;
      case '--prefix':
        if (!next) throw new AxiError('--prefix expects a path', 'VALIDATION_ERROR');
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
  const sheet = await openSheetForCommand(
    repo,
    sheetName,
    flags.prefix !== undefined ? { prefix: flags.prefix } : {},
  );

  const config = await sheet.readConfig();
  const withBody = config.format.body !== undefined;

  let all;
  try {
    all = await sheet.queryAll({}, { withBody });
  } catch (error) {
    throw translateError(error);
  }

  const predicate = buildPredicate(flags.filters);
  const matched = (all as Array<Record<string, unknown>>).filter(predicate);

  // --group-by: faceted counts over the filtered set (not capped by --limit).
  if (flags.groupBy) {
    const facets = facetCounts(matched, flags.groupBy);
    const groupBlock = renderListResponse({
      summary: { groups: `${facets.length} distinct ${flags.groupBy}`, matched: matched.length },
      name: 'groups',
      items: facets as unknown as Array<Record<string, unknown>>,
      schema: [field('value'), field('count')],
      emptyMessage: `no records match in ${sheetName}`,
    });
    return maybeExport(groupBlock, matched, flags, sheetName);
  }

  const ordered = flags.sort ? sortRecords(matched, flags.sort, flags.desc) : matched;
  const limited = ordered.slice(0, flags.limit);

  const baseSchema = defaultSheetSchema(config);
  const schema = fieldsWithExtras(baseSchema, flags.extras);

  const suggestions: string[] = [];
  if (limited.length === 0 && flags.filters.length > 0) {
    suggestions.push(
      `No records match the filter — try \`gitsheets-axi query ${sheetName}\` without filters`,
    );
  } else if (limited.length > 0) {
    suggestions.push(`Run \`gitsheets-axi read ${sheetName} <path>\` to view a single record`);
    if (config.format.body) suggestions.push('Add `--full` on `read` to see untruncated body content');
  }
  if (matched.length > limited.length && !flags.exportFormat) {
    suggestions.push(
      `${matched.length - limited.length} records hidden by --limit ${flags.limit}; raise --limit or use --json-out to capture all`,
    );
  }

  const listResponse = renderListResponse({
    summary: { count: `${limited.length} of ${matched.length} total` },
    name: 'records',
    items: limited.map((r) => ({
      ...r,
      path: (r as Record<symbol, unknown>)[Symbol.for('gitsheets-path')] ?? '',
    })) as Array<Record<string, unknown>>,
    schema: [...schema, field('path')],
    suggestions,
    emptyMessage: `no records in ${sheetName}`,
  });

  return maybeExport(listResponse, ordered, flags, sheetName);
}

/**
 * Append the side-channel export block when an export flag was passed. The file
 * carries the full matched (and, for the record path, sorted) set, verbatim.
 */
function maybeExport(
  stdoutBlock: string,
  records: Array<Record<string, unknown>>,
  flags: QueryFlags,
  sheetName: string,
): string {
  if (!flags.exportFormat) return stdoutBlock;
  const exp = exportRecords(records, flags.exportFormat, flags.exportPath, sheetName);
  const firstCol = exp.columns[0] ?? '';
  const hint =
    flags.exportFormat === 'csv'
      ? `Run \`column -s, -t ${exp.path} | less -S\` to inspect all ${exp.rows} rows`
      : flags.exportFormat === 'ndjson'
        ? `Run \`jq '.${firstCol}' ${exp.path}\` to process all ${exp.rows} rows`
        : `Run \`jq '.[] | .${firstCol}' ${exp.path}\` to process all ${exp.rows} rows`;
  return joinBlocks(
    stdoutBlock,
    renderObject({ wrote: exp.path, rows: exp.rows, cols: exp.cols }),
    renderObject({ columns: exp.columns }),
    renderHelp([hint]),
  );
}
