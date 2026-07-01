import { AxiError } from 'axi-sdk-js';
import type { Repository, Sheet } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { joinBlocks, renderHelp, renderObject } from '../output/render.js';
import { readStdin } from '../util/stdin.js';
import { openSheetForCommand } from '../util/open-sheet.js';
import { parseRecordsInput, recordLabel } from '../util/parse-records.js';

export const UPSERT_HELP = `usage: gitsheets-axi upsert <sheet> [--data <json>] [--allow-missing-body] [--prefix p] [--message m]
flags[4]:
  --data <json>        Record JSON inline. If omitted, reads stdin.
  --allow-missing-body Content-typed sheets only — permit upsert without body field
  --prefix <p>         Tenant sub-tree scope
  --message <m>        Commit message (default: "<sheet> upsert <path>")
bulk:
  Input may be a single JSON object, a JSON array of objects, or NDJSON
  (one compact object per line) — the shape is autodetected. Many records
  are upserted in a SINGLE transaction that produces ONE commit.
examples:
  gitsheets-axi upsert users --data '{"slug":"jane","email":"jane@x.org"}'
  echo '{"slug":"jane","email":"jane@x.org"}' | gitsheets-axi upsert users
  jq -c '.[]' repos.json | gitsheets-axi upsert repos          # NDJSON, one commit
  cat repos.array.json | gitsheets-axi upsert repos             # JSON array, one commit
idempotency:
  Each record's canonical bytes are compared against the existing blob at
  its rendered path. Unchanged records are skipped; a batch where nothing
  changed exits 0 with result: "no-op" and no commit. In a batch, a single
  invalid record aborts the whole transaction — nothing is committed.
note:
  gitsheets writes to the git ref, not your working tree. After a commit,
  run \`git checkout HEAD -- .\` to materialize the record files on disk.
`;

interface UpsertFlags {
  sheet: string;
  data: string | undefined;
  allowMissingBody: boolean;
  prefix: string | undefined;
  message: string | undefined;
}

function parseUpsertFlags(args: string[]): UpsertFlags {
  const flags: UpsertFlags = {
    sheet: '',
    data: undefined,
    allowMissingBody: false,
    prefix: undefined,
    message: undefined,
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

const MATERIALIZE_HINT =
  'gitsheets committed to the git ref, not your working tree — run `git checkout HEAD -- .` to materialize the record files on disk';

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

  // Single-record: preserve the detailed per-record output (path/hash/commit).
  if (records.length === 1) {
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

  const commitMessage =
    flags.message ?? `${flags.sheet} upsert ${willResult.path}`;
  try {
    const result = await repo.transact(
      { message: commitMessage },
      async (tx) => {
        const txSheet = tx.sheet(flags.sheet, prefixOpts);
        return txSheet.upsert(record as never, upsertOpts);
      },
    );
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

async function batchUpsert(
  repo: Repository,
  sheet: Sheet,
  flags: UpsertFlags,
  records: Array<Record<string, unknown>>,
  upsertOpts: { allowMissingBody?: boolean },
  prefixOpts: { prefix?: string },
): Promise<string> {
  // Pre-flight every record: validates (via willChange) and categorizes
  // changed vs unchanged BEFORE opening a transaction. A single bad record
  // aborts the whole batch here, so we never produce a partial commit.
  const changed: Array<Record<string, unknown>> = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    try {
      const wc = await sheet.willChange(record as never, upsertOpts);
      if (wc.changed) changed.push(record);
    } catch (error) {
      const axi = translateError(error);
      throw new AxiError(
        `Record ${i + 1} (${recordLabel(record)}): ${axi.message}`,
        axi.code,
        [
          'The whole batch was aborted — nothing committed. Fix or remove the offending record and re-run.',
        ],
      );
    }
  }

  if (changed.length === 0) {
    return renderObject({
      result: 'no-op',
      sheet: flags.sheet,
      upserted: 0,
      unchanged: records.length,
    });
  }

  const commitMessage =
    flags.message ?? `${flags.sheet} upsert (${changed.length})`;
  try {
    const result = await repo.transact(
      { message: commitMessage },
      async (tx) => {
        const txSheet = tx.sheet(flags.sheet, prefixOpts);
        for (const record of changed) {
          await txSheet.upsert(record as never, upsertOpts);
        }
        return changed.length;
      },
    );
    return joinBlocks(
      renderObject({
        result: 'committed',
        sheet: flags.sheet,
        upserted: changed.length,
        unchanged: records.length - changed.length,
        commit: result.commitHash,
      }),
      renderHelp([MATERIALIZE_HINT]),
    );
  } catch (error) {
    throw translateError(error);
  }
}
