import { AxiError } from 'axi-sdk-js';
import type { Repository, Sheet } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { joinBlocks, renderHelp, renderList, renderObject } from '../output/render.js';
import { field } from '../output/schema.js';
import { readStdin } from '../util/stdin.js';
import { openSheetForCommand } from '../util/open-sheet.js';
import { parseRecordsInput, recordLabel } from '../util/parse-records.js';
import { MATERIALIZE_HINT } from '../util/hints.js';

const PATH_KEY = Symbol.for('gitsheets-path');

export const UPSERT_HELP = `usage: gitsheets-axi upsert <sheet> [--data <json>] [--delete-missing] [--dry-run] [--allow-missing-body] [--prefix p] [--message m]
flags[6]:
  --data <json>        Record JSON inline. If omitted, reads stdin.
  --delete-missing     After upserting, delete existing records NOT in the input
                       set (make the sheet exactly match the batch). One commit.
  --dry-run            Preview {will-change, no-op, invalid, delete} — no commit.
  --allow-missing-body Content-typed sheets only — permit upsert without body field
  --prefix <p>         Tenant sub-tree scope
  --message <m>        Commit message (default: "<sheet> upsert <path>")
bulk:
  Input may be a single JSON object, a JSON array of objects, or NDJSON (one
  compact object per line) — autodetected. A batch upserts in ONE commit.
examples:
  echo '{"slug":"jane","email":"jane@x.org"}' | gitsheets-axi upsert users
  jq -c '.[]' repos.json | gitsheets-axi upsert repos                  # NDJSON, one commit
  gitsheets-axi upsert repos --data "$(cat repos.json)" --delete-missing   # exact re-sync
  gitsheets-axi upsert repos --data "$(cat repos.json)" --dry-run           # preview
idempotency:
  Unchanged records are skipped; a batch where nothing changed is a no-op with
  no commit. A single invalid record aborts the batch (nothing committed) and
  names the row — run --dry-run to see all invalid rows at once.
note:
  gitsheets writes to the git ref, not your working tree. After a commit run
  \`git checkout HEAD -- .\` to materialize the record files on disk.
`;

interface UpsertFlags {
  sheet: string;
  data: string | undefined;
  allowMissingBody: boolean;
  prefix: string | undefined;
  message: string | undefined;
  deleteMissing: boolean;
  dryRun: boolean;
}

function parseUpsertFlags(args: string[]): UpsertFlags {
  const flags: UpsertFlags = {
    sheet: '',
    data: undefined,
    allowMissingBody: false,
    prefix: undefined,
    message: undefined,
    deleteMissing: false,
    dryRun: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];
    switch (arg) {
      case '--data':
        if (!next) throw new AxiError('--data expects a JSON string', 'VALIDATION_ERROR');
        flags.data = next;
        i++;
        break;
      case '--allow-missing-body':
        flags.allowMissingBody = true;
        break;
      case '--delete-missing':
        flags.deleteMissing = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--prefix':
        if (!next) throw new AxiError('--prefix expects a path', 'VALIDATION_ERROR');
        flags.prefix = next;
        i++;
        break;
      case '--message':
        if (!next) throw new AxiError('--message expects a string', 'VALIDATION_ERROR');
        flags.message = next;
        i++;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
            'Run `gitsheets-axi upsert --help`',
          ]);
        }
        positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    throw new AxiError('upsert requires <sheet>', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi upsert users --data \'{"slug":"jane"}\'',
    ]);
  }
  flags.sheet = positional[0]!;
  return flags;
}

export async function upsertCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return UPSERT_HELP;
  }

  const flags = parseUpsertFlags(args);
  const recordJson = flags.data ?? (await readStdin());
  const { records } = parseRecordsInput(recordJson);

  const prefixOpts = flags.prefix !== undefined ? { prefix: flags.prefix } : {};
  const upsertOpts = flags.allowMissingBody ? { allowMissingBody: true } : {};

  const repo = await ctx.repo();
  const sheet = await openSheetForCommand(repo, flags.sheet, prefixOpts);

  // Fast single-record path only when no set-level flag is in play.
  if (records.length === 1 && !flags.deleteMissing && !flags.dryRun) {
    return singleUpsert(repo, sheet, flags, records[0]!, upsertOpts, prefixOpts);
  }
  return batchUpsert(repo, sheet, flags, records, upsertOpts, prefixOpts);
}

async function singleUpsert(
  repo: Repository,
  sheet: Sheet,
  flags: UpsertFlags,
  record: Record<string, unknown>,
  upsertOpts: { allowMissingBody?: boolean },
  prefixOpts: { prefix?: string },
): Promise<string> {
  let willResult;
  try {
    willResult = await sheet.willChange(record as never, upsertOpts);
  } catch (error) {
    throw translateError(error);
  }

  if (!willResult.changed) {
    return renderObject({
      result: 'no-op',
      sheet: flags.sheet,
      path: willResult.path,
      hash: willResult.currentBlobHash ?? '',
    });
  }

  const commitMessage = flags.message ?? `${flags.sheet} upsert ${willResult.path}`;
  try {
    const result = await repo.transact({ message: commitMessage }, async (tx) => {
      const txSheet = tx.sheet(flags.sheet, prefixOpts);
      return txSheet.upsert(record as never, upsertOpts);
    });
    return joinBlocks(
      renderObject({
        result: 'committed',
        sheet: flags.sheet,
        path: result.value.path,
        hash: result.value.blob.hash,
        commit: result.commitHash,
      }),
      renderHelp([MATERIALIZE_HINT]),
    );
  } catch (error) {
    throw translateError(error);
  }
}

export interface InvalidRow {
  row: number;
  id: string;
  reason: string;
  code: string;
}

async function batchUpsert(
  repo: Repository,
  sheet: Sheet,
  flags: UpsertFlags,
  records: Array<Record<string, unknown>>,
  upsertOpts: { allowMissingBody?: boolean },
  prefixOpts: { prefix?: string },
): Promise<string> {
  // Pre-flight: categorize into changed / unchanged / invalid. Unlike the
  // commit path, we never throw here — dry-run needs every invalid row, and the
  // normal path aborts explicitly after collecting.
  const changed: Array<Record<string, unknown>> = [];
  const batchPaths = new Set<string>();
  const invalid: InvalidRow[] = [];
  let unchanged = 0;

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    try {
      const wc = await sheet.willChange(record as never, upsertOpts);
      batchPaths.add(wc.path);
      if (wc.changed) changed.push(record);
      else unchanged++;
    } catch (error) {
      const axi = translateError(error);
      invalid.push({ row: i + 1, id: recordLabel(record), reason: axi.message, code: axi.code });
    }
  }

  // --delete-missing: existing records whose path isn't in the input set.
  const deletions: string[] = [];
  if (flags.deleteMissing) {
    const existing = await sheet.queryAll({}, { withBody: false });
    for (const r of existing) {
      const p = (r as Record<symbol, unknown>)[PATH_KEY];
      if (typeof p === 'string' && !batchPaths.has(p)) deletions.push(p);
    }
  }

  if (flags.dryRun) {
    return renderDryRun(
      flags.sheet,
      {
        willChange: changed.length,
        noOp: unchanged,
        invalid: invalid.length,
        ...(flags.deleteMissing ? { willDelete: deletions.length } : {}),
      },
      invalid,
    );
  }

  if (invalid.length > 0) {
    const first = invalid[0]!;
    throw new AxiError(`Record ${first.row} (${first.id}): ${first.reason}`, first.code, [
      `${invalid.length} record(s) invalid — the whole batch was aborted, nothing committed. Run --dry-run to see all.`,
    ]);
  }

  if (changed.length === 0 && deletions.length === 0) {
    return renderObject({
      result: 'no-op',
      sheet: flags.sheet,
      upserted: 0,
      unchanged: records.length,
      ...(flags.deleteMissing ? { deleted: 0 } : {}),
    });
  }

  const commitMessage = flags.message ?? `${flags.sheet} upsert (${changed.length})`;
  try {
    const result = await repo.transact({ message: commitMessage }, async (tx) => {
      const txSheet = tx.sheet(flags.sheet, prefixOpts);
      for (const record of changed) await txSheet.upsert(record as never, upsertOpts);
      for (const path of deletions) await txSheet.delete(path);
      return changed.length;
    });
    return joinBlocks(
      renderObject({
        result: 'committed',
        sheet: flags.sheet,
        upserted: changed.length,
        unchanged: records.length - changed.length,
        ...(flags.deleteMissing ? { deleted: deletions.length } : {}),
        commit: result.commitHash,
      }),
      renderHelp([MATERIALIZE_HINT]),
    );
  } catch (error) {
    throw translateError(error);
  }
}

/** Shared dry-run renderer: a `dry-run` summary of counts + an invalid-rows table. */
export function renderDryRun(
  sheet: string,
  counts: Record<string, number>,
  invalid: InvalidRow[],
): string {
  const blocks = [renderObject({ result: 'dry-run', sheet, ...counts })];
  if (invalid.length > 0) {
    blocks.push(
      renderList('invalid', invalid as unknown as Array<Record<string, unknown>>, [
        field('row'),
        field('id'),
        field('reason'),
      ]),
    );
  }
  return joinBlocks(...blocks);
}
