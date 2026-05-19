import { AxiError } from 'axi-sdk-js';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderObject } from '../output/render.js';
import { readStdin } from '../util/stdin.js';

export const UPSERT_HELP = `usage: gitsheets-axi upsert <sheet> [--data <json>] [--allow-missing-body] [--prefix p] [--message m]
flags[4]:
  --data <json>        Record JSON inline. If omitted, reads stdin.
  --allow-missing-body Content-typed sheets only — permit upsert without body field
  --prefix <p>         Tenant sub-tree scope
  --message <m>        Commit message (default: "<sheet> upsert <path>")
examples:
  gitsheets-axi upsert users --data '{"slug":"jane","email":"jane@x.org"}'
  echo '{"slug":"jane","email":"jane@x.org"}' | gitsheets-axi upsert users
idempotency:
  Compares the canonical bytes the upsert would write against the
  existing blob at the rendered path. If identical, exits 0 with
  result: "no-op" and no commit is produced.
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

export async function upsertCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return UPSERT_HELP;
  }

  const flags = parseUpsertFlags(args);
  const recordJson = flags.data ?? (await readStdin());
  if (!recordJson.trim()) {
    throw new AxiError(
      'upsert needs a record — pass --data <json> or pipe JSON on stdin',
      'VALIDATION_ERROR',
      ['Example: gitsheets-axi upsert users --data \'{"slug":"jane"}\''],
    );
  }

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(recordJson) as Record<string, unknown>;
  } catch (error) {
    throw new AxiError(
      `Could not parse record JSON: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_JSON',
      ['Ensure the input is a valid JSON object'],
    );
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new AxiError('Record must be a JSON object', 'VALIDATION_ERROR');
  }

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

  const upsertOpts = flags.allowMissingBody ? { allowMissingBody: true } : {};

  // Pre-flight idempotency check.
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

  // Carry through. willChange validated already; this re-validates inside
  // upsert (cheap, idempotent at the validate layer). Future optimization
  // could expose a "skip validation" path keyed off willChange's result.
  const commitMessage =
    flags.message ?? `${flags.sheet} upsert ${willResult.path}`;
  try {
    const result = await repo.transact(
      { message: commitMessage },
      async (tx) => {
        const txSheet = tx.sheet(
          flags.sheet,
          flags.prefix !== undefined ? { prefix: flags.prefix } : {},
        );
        return txSheet.upsert(record as never, upsertOpts);
      },
    );
    return renderObject({
      result: 'committed',
      sheet: flags.sheet,
      path: result.value.path,
      hash: result.value.blob.hash,
      commit: result.commitHash,
    });
  } catch (error) {
    throw translateError(error);
  }
}
