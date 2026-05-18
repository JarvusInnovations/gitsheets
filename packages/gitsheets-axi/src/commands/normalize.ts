import { AxiError } from 'axi-sdk-js';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderListResponse } from '../output/render.js';
import { field } from '../output/schema.js';

export const NORMALIZE_HELP = `usage: gitsheets-axi normalize <sheet> [--prefix p] [--message m]
flags[2]:
  --prefix <p>         Tenant sub-tree scope
  --message <m>        Commit message (default: "<sheet> normalize")
examples:
  gitsheets-axi normalize users
behavior:
  Reads every record in the sheet, re-runs validation + canonical
  serialization, and writes back any record whose bytes differ.
  Idempotent per-record via Sheet.willChange: records that already
  serialize to identical bytes are skipped. If every record is already
  canonical, exits 0 with result: "no-op" and no commit is produced.
exit codes:
  0   Success (whether records were rewritten or no-op)
`;

interface NormalizeFlags {
  sheet: string;
  prefix: string | undefined;
  message: string | undefined;
}

function parseNormalizeFlags(args: string[]): NormalizeFlags {
  const flags: NormalizeFlags = { sheet: '', prefix: undefined, message: undefined };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];
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
      throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
        'Run `gitsheets-axi normalize --help`',
      ]);
    }
    positional.push(arg);
  }
  if (positional.length !== 1) {
    throw new AxiError('normalize requires <sheet>', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi normalize users',
    ]);
  }
  flags.sheet = positional[0]!;
  return flags;
}

export async function normalizeCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return NORMALIZE_HELP;
  }

  const flags = parseNormalizeFlags(args);
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

  // Collect all records first so we know what to rewrite + can skip the
  // commit entirely if every record is already canonical.
  const records: Array<Record<string, unknown>> = [];
  try {
    for await (const r of sheet.query()) {
      records.push(r as Record<string, unknown>);
    }
  } catch (error) {
    throw translateError(error);
  }

  if (records.length === 0) {
    return renderListResponse({
      summary: { result: 'no-op', records: '0 — empty sheet' },
      name: 'rewrites',
      items: [],
      schema: [field('path'), field('hash')],
      emptyMessage: 'no records',
    });
  }

  // Determine which records would actually change.
  const toWrite: Array<{ record: Record<string, unknown>; path: string }> = [];
  try {
    for (const record of records) {
      const will = await sheet.willChange(record as never, { allowMissingBody: true });
      if (will.changed) {
        toWrite.push({ record, path: will.path });
      }
    }
  } catch (error) {
    throw translateError(error);
  }

  if (toWrite.length === 0) {
    return renderListResponse({
      summary: {
        result: 'no-op',
        records: `${records.length} already canonical`,
      },
      name: 'rewrites',
      items: [],
      schema: [field('path'), field('hash')],
      emptyMessage: 'every record already canonical',
    });
  }

  const commitMessage =
    flags.message ?? `${flags.sheet} normalize (${toWrite.length} records)`;
  const rewrites: Array<Record<string, unknown>> = [];
  let commitHash = '';
  try {
    const result = await repo.transact(
      { message: commitMessage },
      async (tx) => {
        const txSheet = tx.sheet(
          flags.sheet,
          flags.prefix !== undefined ? { prefix: flags.prefix } : {},
        );
        for (const { record } of toWrite) {
          const r = await txSheet.upsert(record as never, { allowMissingBody: true });
          rewrites.push({ path: r.path, hash: r.blob.hash });
        }
      },
    );
    commitHash = result.commitHash ?? '';
  } catch (error) {
    throw translateError(error);
  }

  return renderListResponse({
    summary: {
      result: 'committed',
      records: `${rewrites.length} of ${records.length} rewritten`,
      commit: commitHash,
    },
    name: 'rewrites',
    items: rewrites,
    schema: [field('path'), field('hash')],
  });
}
