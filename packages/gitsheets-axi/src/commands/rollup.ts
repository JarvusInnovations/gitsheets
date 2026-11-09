import { AxiError } from 'axi-sdk-js';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderListResponse } from '../output/render.js';
import { field } from '../output/schema.js';
import { openSheetForCommand } from '../util/open-sheet.js';

export const ROLLUP_HELP = `usage: gitsheets-axi rollup <sheet> [--check] [--prefix p] [--message m]
flags[3]:
  --check              List each stale / missing / orphaned partition; write nothing
  --prefix <p>         Tenant sub-tree scope
  --message <m>        Commit message (default: "<sheet> rollup")
examples:
  gitsheets-axi rollup transactions-monthly --check
  gitsheets-axi rollup transactions-monthly
behavior:
  <sheet> is a rollup sheet ([gitsheet.rollup]): per-partition aggregates
  over a source sheet, stamped with the source partition's tree id. Every
  commit gitsheets makes keeps them fresh; a plain \`git merge\` or an outside
  writer can leave them stale. Reads are always correct (stale partitions are
  recomputed on read); this command persists the fix — recompute every stale
  or missing rollup record and delete orphaned ones, in one commit (none when
  everything is fresh).
exit codes:
  0   Fresh, or materialized
  1   --check found partitions that are not fresh (code ROLLUP_STALE)
`;

interface RollupFlags {
  sheet: string;
  check: boolean;
  prefix: string | undefined;
  message: string | undefined;
}

function parseRollupFlags(args: string[]): RollupFlags {
  const flags: RollupFlags = { sheet: '', check: false, prefix: undefined, message: undefined };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];
    if (arg === '--check') {
      flags.check = true;
      continue;
    }
    if (arg === '--prefix') {
      if (!next) throw new AxiError('--prefix expects a path', 'VALIDATION_ERROR');
      flags.prefix = next;
      i++;
      continue;
    }
    if (arg === '--message') {
      if (!next) throw new AxiError('--message expects a string', 'VALIDATION_ERROR');
      flags.message = next;
      i++;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', ['Run `gitsheets-axi rollup --help`']);
    }
    positional.push(arg);
  }
  if (positional.length !== 1) {
    throw new AxiError('rollup requires <sheet>', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi rollup transactions-monthly --check',
    ]);
  }
  flags.sheet = positional[0]!;
  return flags;
}

export async function rollupCommand(args: string[], ctx: GitsheetsContext): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return ROLLUP_HELP;
  }
  const flags = parseRollupFlags(args);
  const repo = await ctx.repo();
  const scope = flags.prefix !== undefined ? { prefix: flags.prefix } : {};
  const sheet = await openSheetForCommand(repo, flags.sheet, scope);

  let entries;
  try {
    entries = await sheet.rollupStatus();
  } catch (error) {
    if (error instanceof TypeError) {
      throw new AxiError(error.message, 'VALIDATION_ERROR', [
        'rollup takes a rollup sheet — one whose config declares [gitsheet.rollup]',
      ]);
    }
    throw translateError(error);
  }

  if (flags.check) {
    if (entries.length > 0) {
      throw new AxiError(
        `${entries.length} partition(s) of ${flags.sheet} are not fresh: ${entries.map((e) => `${e.status} ${e.path}`).join(', ')}`,
        'ROLLUP_STALE',
        [`Run \`gitsheets-axi rollup ${flags.sheet}\` to recompute and commit them`],
      );
    }
    return renderListResponse({
      summary: { result: 'fresh', sheet: flags.sheet },
      name: 'partitions',
      items: [],
      schema: [field('path'), field('status')],
      emptyMessage: 'every partition is fresh',
    });
  }

  let out = { recomputed: [] as string[], deleted: [] as string[] };
  let commitHash: string | null = null;
  try {
    const result = await repo.transact({ message: flags.message ?? `${flags.sheet} rollup` }, async (tx) => {
      out = await tx.sheet(flags.sheet, scope).materialize();
    });
    commitHash = result.commitHash;
  } catch (error) {
    throw translateError(error);
  }
  const items = [
    ...out.recomputed.map((path) => ({ path, status: 'recomputed' })),
    ...out.deleted.map((path) => ({ path, status: 'deleted' })),
  ];
  return renderListResponse({
    summary:
      commitHash === null
        ? { result: 'no-op', sheet: flags.sheet }
        : { result: 'committed', sheet: flags.sheet, commit: commitHash },
    name: 'partitions',
    items,
    schema: [field('path'), field('status')],
    emptyMessage: 'every partition was fresh — nothing committed',
  });
}
