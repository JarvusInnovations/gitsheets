import { AxiError } from 'axi-sdk-js';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderListResponse } from '../output/render.js';
import { display, field } from '../output/schema.js';

export const DIFF_HELP = `usage: gitsheets-axi diff <sheet> [<src-ref>] [--patches] [--limit n] [--prefix p]
flags[3]:
  --patches            Include RFC 6902 JSON Patch ops on each change (default: false)
  --limit <n>          Cap results (default: 1000)
  --prefix <p>         Tenant sub-tree scope
examples:
  gitsheets-axi diff users
  gitsheets-axi diff posts HEAD~10
  gitsheets-axi diff users origin/main --patches
output:
  Default columns: status (added/modified/deleted/renamed), path, srcHash, dstHash.
  --patches adds an inline patch column (RFC 6902 ops).
src-ref:
  Optional. Defaults to the empty tree, which makes every current record
  show up as "added" — useful for a one-shot snapshot of the sheet.
`;

interface DiffFlags {
  sheet: string;
  srcRef: string | undefined;
  patches: boolean;
  limit: number;
  prefix: string | undefined;
}

function parseDiffFlags(args: string[]): DiffFlags {
  const flags: DiffFlags = {
    sheet: '',
    srcRef: undefined,
    patches: false,
    limit: 1000,
    prefix: undefined,
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];
    if (arg === '--patches') {
      flags.patches = true;
      continue;
    }
    if (arg === '--limit') {
      if (!next) throw new AxiError('--limit expects an integer', 'VALIDATION_ERROR');
      flags.limit = Math.min(100_000, Math.max(1, parseInt(next, 10) || 1000));
      i++;
      continue;
    }
    if (arg === '--prefix') {
      if (!next) throw new AxiError('--prefix expects a path', 'VALIDATION_ERROR');
      flags.prefix = next;
      i++;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
        'Run `gitsheets-axi diff --help`',
      ]);
    }
    positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2) {
    throw new AxiError('diff requires <sheet> [<src-ref>]', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi diff users HEAD~10',
    ]);
  }
  flags.sheet = positional[0]!;
  if (positional.length === 2) flags.srcRef = positional[1];
  return flags;
}

export async function diffCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return DIFF_HELP;
  }

  const flags = parseDiffFlags(args);
  const repo = await ctx.repo();

  let sheet;
  try {
    sheet = await repo.openSheet(
      flags.sheet,
      flags.prefix !== undefined ? { prefix: flags.prefix } : {},
    );
  } catch (error) {
    throw translateError(error);
  }

  const items: Array<Record<string, unknown>> = [];
  let total = 0;
  try {
    const opts = flags.patches ? { patches: true as const } : {};
    for await (const change of sheet.diffFrom(flags.srcRef, opts)) {
      total++;
      if (items.length >= flags.limit) continue;
      const row: Record<string, unknown> = {
        status: change.status,
        path: change.path,
        src_hash: change.srcHash ?? '',
        dst_hash: change.dstHash ?? '',
      };
      if (flags.patches && (change as { patch?: unknown }).patch !== undefined) {
        // Serialize the RFC 6902 patch as JSON so it fits in a TOON cell.
        // Empty arrays render as "[]"; small patches render compactly.
        const patch = (change as { patch?: readonly unknown[] }).patch;
        row['patch'] = JSON.stringify(patch ?? []);
      }
      items.push(row);
    }
  } catch (error) {
    throw translateError(error);
  }

  const schema = [
    field('status'),
    field('path'),
    display('src_hash'),
    display('dst_hash'),
  ];
  if (flags.patches) schema.push(field('patch'));

  const suggestions: string[] = [];
  if (total === 0) {
    suggestions.push('No changes between src ref and current tree');
  } else if (total > items.length) {
    suggestions.push(
      `${total - items.length} changes hidden by --limit ${flags.limit}; raise --limit to see more`,
    );
  }
  if (!flags.patches && total > 0) {
    suggestions.push('Add `--patches` to include RFC 6902 ops per change');
  }

  return renderListResponse({
    summary: {
      count: `${items.length} of ${total} total`,
      src_ref: flags.srcRef ?? '(empty tree)',
    },
    name: 'changes',
    items,
    schema,
    suggestions,
    emptyMessage: 'no changes',
  });
}
