import { AxiError } from 'axi-sdk-js';
import type { AggregateSpec, Sheet, SheetConfig } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderObject } from '../output/render.js';
import { openSheetForCommand } from '../util/open-sheet.js';
import { bucketFieldsOf, buildPredicate, parseFilter, pushdownFilter } from '../util/filter.js';

/**
 * The filter key the combined host predicate rides under. No record carries
 * it, so `Sheet.aggregate` hands the predicate `(undefined, record)` and the
 * predicate tests the whole record.
 */
export const HOST_PREDICATE_KEY = '\u0000gitsheets-axi:filter';

/**
 * The `Sheet.aggregate` filter for a set of `--filter` clauses: the ordered
 * clauses on date-bucket path fields that the core can prune by
 * ({@link pushdownFilter}), plus ONE combined host predicate over every clause
 * ({@link buildPredicate}) under {@link HOST_PREDICATE_KEY}. The pushed-down
 * range never excludes a record the host predicate keeps, and the host
 * predicate stays authoritative, so the DSL's semantics are unchanged while
 * the walk prunes.
 */
export function buildAggregateFilter(
  filters: string[],
  config: Pick<SheetConfig, 'path'>,
): Record<string, unknown> {
  const filter: Record<string, unknown> = { ...pushdownFilter(filters, bucketFieldsOf(config.path)) };
  if (filters.length > 0) {
    const predicate = buildPredicate(filters);
    filter[HOST_PREDICATE_KEY] = (_value: unknown, record: Record<string, unknown>) => predicate(record);
  }
  return filter;
}

export const AGGREGATE_HELP = `usage: gitsheets-axi aggregate <sheet> --agg <name>=<form>[:<field>] ... [--group-by f] [--filter expr ...] [--prefix p]
flags[4]:
  --agg <spec>         Aggregate (repeatable, at least one): <name>=count, or
                       <name>=sum|min|max|avg|distinct:<field>
  --group-by <field>   Apply groupBy to every aggregate (each result becomes
                       a table keyed by the field's string form)
  --filter <expr>      Filter clause (repeatable), same DSL as query
  --prefix <p>         Tenant sub-tree scope
examples:
  gitsheets-axi aggregate repos --agg n=count --group-by target_team
  gitsheets-axi aggregate tx --agg total=sum:amountCents --agg mean=avg:amountCents
  gitsheets-axi aggregate repos --agg teams=distinct:target_team --filter archived=false
note:
  Computed in the gitsheets core over the filtered records, body-less, in
  canonical path order. An aggregate with nothing to fold is omitted, except
  count and sum (0). Records lacking a string/integer/boolean --group-by
  value do not contribute. reduce is library-only (Sheet.aggregate).
`;

/**
 * Aggregates read body-less, so a clause on a content-typed sheet's body field
 * would silently match nothing — the spec'd TypeError, surfaced naming the
 * clause.
 */
function assertNoBodyClause(filters: string[], bodyField: string | undefined): void {
  if (bodyField === undefined) return;
  for (const expr of filters) {
    if (parseFilter(expr).field === bodyField) {
      throw new AxiError(
        `--filter "${expr}" references the body field "${bodyField}" — aggregate reads records body-less`,
        'VALIDATION_ERROR',
        ['Filter on frontmatter fields, or use `query` to read bodies'],
      );
    }
  }
}

const FIELD_FORMS = new Set(['sum', 'min', 'max', 'avg', 'distinct']);

/** Parse one `--agg <name>=<form>[:<field>]` clause. */
export function parseAggSpec(item: string): [string, AggregateSpec] {
  const eq = item.indexOf('=');
  const name = eq > 0 ? item.slice(0, eq) : '';
  const rhs = eq > 0 ? item.slice(eq + 1) : '';
  const colon = rhs.indexOf(':');
  const form = colon === -1 ? rhs : rhs.slice(0, colon);
  const field = colon === -1 ? undefined : rhs.slice(colon + 1);
  const hint = ['Forms: <name>=count · <name>=sum|min|max|avg|distinct:<field>'];
  if (!name) throw new AxiError(`--agg expects <name>=<form>[:<field>], got "${item}"`, 'VALIDATION_ERROR', hint);
  if (form === 'count' && field === undefined) return [name, { count: true }];
  if (FIELD_FORMS.has(form) && field) return [name, { [form]: field } as unknown as AggregateSpec];
  throw new AxiError(`Could not parse --agg "${item}"`, 'VALIDATION_ERROR', hint);
}

interface AggregateFlags {
  sheet: string;
  aggs: Array<[string, AggregateSpec]>;
  groupBy: string | undefined;
  filters: string[];
  prefix: string | undefined;
}

function parseAggregateFlags(args: string[]): AggregateFlags {
  const sheet = args[0];
  if (!sheet || sheet.startsWith('-')) {
    throw new AxiError('aggregate requires a sheet name', 'VALIDATION_ERROR', [
      'Run `gitsheets-axi aggregate <sheet> --agg n=count`',
    ]);
  }
  const flags: AggregateFlags = { sheet, aggs: [], groupBy: undefined, filters: [], prefix: undefined };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '--agg':
        if (!next) throw new AxiError('--agg expects <name>=<form>[:<field>]', 'VALIDATION_ERROR');
        flags.aggs.push(parseAggSpec(next));
        i++;
        break;
      case '--group-by':
        if (!next) throw new AxiError('--group-by expects a field name', 'VALIDATION_ERROR');
        flags.groupBy = next;
        i++;
        break;
      case '--filter':
        if (!next) throw new AxiError('--filter expects an expression', 'VALIDATION_ERROR');
        flags.filters.push(next);
        i++;
        break;
      case '--prefix':
        if (!next) throw new AxiError('--prefix expects a path', 'VALIDATION_ERROR');
        flags.prefix = next;
        i++;
        break;
      default:
        throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
          'Run `gitsheets-axi aggregate --help`',
        ]);
    }
  }
  if (flags.aggs.length === 0) {
    throw new AxiError('aggregate requires at least one --agg', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi aggregate repos --agg n=count --group-by target_team',
    ]);
  }
  return flags;
}

/**
 * Run `Sheet.aggregate` with the axi filter DSL, translating a malformed-spec
 * `TypeError` to `VALIDATION_ERROR` and library errors through
 * {@link translateError}.
 */
export async function runAggregate(
  sheet: Sheet,
  filters: string[],
  aggregates: Record<string, AggregateSpec>,
): Promise<Record<string, unknown>> {
  try {
    const config = await sheet.readConfig();
    assertNoBodyClause(filters, config.format.body);
    return await sheet.aggregate(buildAggregateFilter(filters, config), aggregates);
  } catch (error) {
    if (error instanceof TypeError) throw new AxiError(error.message, 'VALIDATION_ERROR', []);
    throw translateError(error);
  }
}

export async function aggregateCommand(args: string[], ctx: GitsheetsContext): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return AGGREGATE_HELP;
  }
  const flags = parseAggregateFlags(args);
  // Null-prototype so names like `toString` aren't mistaken for duplicates.
  const aggregates = Object.create(null) as Record<string, AggregateSpec>;
  for (const [name, spec] of flags.aggs) {
    if (Object.hasOwn(aggregates, name)) throw new AxiError(`--agg ${name} given twice`, 'VALIDATION_ERROR');
    aggregates[name] = flags.groupBy !== undefined ? { ...spec, groupBy: flags.groupBy } : spec;
  }
  const repo = await ctx.repo();
  const sheet = await openSheetForCommand(
    repo,
    flags.sheet,
    flags.prefix !== undefined ? { prefix: flags.prefix } : {},
  );
  const results = await runAggregate(sheet, flags.filters, aggregates);
  return renderObject({ sheet: flags.sheet, results });
}
