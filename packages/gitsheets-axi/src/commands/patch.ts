import { AxiError } from 'axi-sdk-js';
import { mergePatch, Template, type Repository, type Sheet } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { joinBlocks, renderHelp, renderObject } from '../output/render.js';
import { readStdin } from '../util/stdin.js';
import { openSheetForCommand } from '../util/open-sheet.js';
import { parseRecordsInput, recordLabel } from '../util/parse-records.js';
import { MATERIALIZE_HINT } from '../util/hints.js';

export const PATCH_HELP = `usage: gitsheets-axi patch <sheet> <query-json> [--patch <json>] [--prefix p] [--message m]
       gitsheets-axi patch <sheet> [--data <json>] [--prefix p] [--message m]   # bulk
flags[4]:
  --patch <json>       Single mode: RFC 7396 partial. If omitted, reads stdin.
  --data <json>        Bulk mode: JSON array / NDJSON of combined records.
  --prefix <p>         Tenant sub-tree scope
  --message <m>        Commit message (default: "<sheet> patch <path>")
examples:
  gitsheets-axi patch users '{"slug":"jane"}' --patch '{"name":"Jane O. Doe"}'
  echo '{"name":"Jane O. Doe"}' | gitsheets-axi patch users '{"slug":"jane"}'
  jq -c '.[]' classify.json | gitsheets-axi patch repos      # bulk, one commit
bulk:
  With no <query-json>, input is a JSON array or NDJSON of records. In each
  record the sheet's path-template fields form the query (which record to
  patch); the remaining fields are the merge patch. Every patch runs in a
  SINGLE transaction → ONE commit. This is the tool for incremental
  classification: emit {<path-fields>, <fields-to-set>} per record.
semantics:
  RFC 7396 JSON Merge Patch. \`null\` deletes a field, arrays replace
  in full, objects merge recursively. Same as gitsheets's library patch.
idempotency:
  Each record is merged and run through willChange. Unchanged records are
  skipped; a batch where nothing changed exits 0 with result: "no-op" and no
  commit. In a batch, a record whose query matches nothing aborts the whole
  transaction — nothing is committed.
`;

interface PatchFlags {
  sheet: string;
  queryJson: string | undefined;
  patchJson: string | undefined;
  data: string | undefined;
  prefix: string | undefined;
  message: string | undefined;
}

function parsePatchFlags(args: string[]): PatchFlags {
  const flags: PatchFlags = {
    sheet: '',
    queryJson: undefined,
    patchJson: undefined,
    data: undefined,
    prefix: undefined,
    message: undefined,
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];
    switch (arg) {
      case '--patch':
        if (!next) throw new AxiError('--patch expects JSON', 'VALIDATION_ERROR');
        flags.patchJson = next;
        i++;
        break;
      case '--data':
        if (!next) throw new AxiError('--data expects JSON', 'VALIDATION_ERROR');
        flags.data = next;
        i++;
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
            'Run `gitsheets-axi patch --help`',
          ]);
        }
        positional.push(arg);
    }
  }
  if (positional.length === 0 || positional.length > 2) {
    throw new AxiError(
      'patch requires <sheet> [<query-json>]',
      'VALIDATION_ERROR',
      [
        "Single: gitsheets-axi patch users '{\"slug\":\"jane\"}' --patch '{...}'",
        'Bulk:   gitsheets-axi patch repos --data \'[{...}, ...]\'',
      ],
    );
  }
  flags.sheet = positional[0]!;
  flags.queryJson = positional[1];
  return flags;
}

export async function patchCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return PATCH_HELP;
  }

  const flags = parsePatchFlags(args);
  const prefixOpts = flags.prefix !== undefined ? { prefix: flags.prefix } : {};

  const repo = await ctx.repo();
  const sheet = await openSheetForCommand(repo, flags.sheet, prefixOpts);

  // Single mode is signalled by an explicit <query-json> positional; bulk mode
  // by its absence (records come from --data / stdin, query embedded per record).
  if (flags.queryJson !== undefined) {
    if (flags.data !== undefined) {
      throw new AxiError(
        '--data is bulk mode — drop the <query-json> positional to use it',
        'VALIDATION_ERROR',
      );
    }
    return singlePatch(repo, sheet, flags, prefixOpts);
  }
  if (flags.patchJson !== undefined) {
    throw new AxiError(
      '--patch is single mode — it needs a <query-json> positional',
      'VALIDATION_ERROR',
      ['For bulk, embed the query fields in each record and use --data / stdin'],
    );
  }
  return batchPatch(repo, sheet, flags, prefixOpts);
}

async function singlePatch(
  repo: Repository,
  sheet: Sheet,
  flags: PatchFlags,
  prefixOpts: { prefix?: string },
): Promise<string> {
  let query: Record<string, unknown>;
  try {
    query = JSON.parse(flags.queryJson!) as Record<string, unknown>;
  } catch (error) {
    throw new AxiError(
      `Could not parse query JSON: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_JSON',
    );
  }

  const patchJson = flags.patchJson ?? (await readStdin());
  if (!patchJson.trim()) {
    throw new AxiError(
      'patch needs a partial — pass --patch <json> or pipe JSON on stdin',
      'VALIDATION_ERROR',
    );
  }
  let partial: unknown;
  try {
    partial = JSON.parse(patchJson);
  } catch (error) {
    throw new AxiError(
      `Could not parse patch JSON: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_JSON',
    );
  }
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new AxiError('Patch must be a JSON object', 'VALIDATION_ERROR');
  }

  const willResult = await previewPatch(sheet, query, partial as Record<string, unknown>);
  if (willResult === 'not-found') {
    throw new AxiError(`${flags.sheet}: no record matches the query`, 'NOT_FOUND');
  }
  if (!willResult.changed) {
    return renderObject({
      result: 'no-op',
      sheet: flags.sheet,
      path: willResult.path,
      hash: willResult.hash ?? '',
    });
  }

  const commitMessage =
    flags.message ?? `${flags.sheet} patch ${willResult.path}`;
  try {
    const result = await repo.transact({ message: commitMessage }, async (tx) => {
      const txSheet = tx.sheet(flags.sheet, prefixOpts);
      return txSheet.patch(query, partial as Record<string, unknown>);
    });
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

async function batchPatch(
  repo: Repository,
  sheet: Sheet,
  flags: PatchFlags,
  prefixOpts: { prefix?: string },
): Promise<string> {
  const raw = flags.data ?? (await readStdin());
  const { records } = parseRecordsInput(raw);

  const config = await sheet.readConfig();
  const templateFields = new Set(Template.fromString(config.path).getFieldNames());

  // Pre-flight: split each record into (query, partial), confirm the target
  // exists, and merge+willChange to categorize changed vs unchanged — all
  // before opening a transaction, so a bad record aborts with nothing
  // committed and the changed subset commits atomically.
  const changes: Array<{
    query: Record<string, unknown>;
    partial: Record<string, unknown>;
  }> = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const query: Record<string, unknown> = {};
    const partial: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (templateFields.has(k)) query[k] = v;
      else partial[k] = v;
    }

    if (Object.keys(query).length === 0) {
      throw new AxiError(
        `Record ${i + 1} (${recordLabel(record)}) has none of the path-template fields (${[...templateFields].join(', ')}) — can't tell which record to patch`,
        'VALIDATION_ERROR',
        ['Each bulk-patch record must carry the path-template fields as its query'],
      );
    }
    // Query-only record (nothing to set) — a harmless no-op, skip it.
    if (Object.keys(partial).length === 0) continue;

    let willResult;
    try {
      willResult = await previewPatch(sheet, query, partial);
    } catch (error) {
      throw attribute(translateError(error), i, record);
    }
    if (willResult === 'not-found') {
      throw new AxiError(
        `Record ${i + 1} (${recordLabel(record)}): no record matches ${JSON.stringify(query)}`,
        'NOT_FOUND',
        ['The whole batch was aborted — nothing committed. Fix or remove the record and re-run.'],
      );
    }
    if (willResult.changed) changes.push({ query, partial });
  }

  if (changes.length === 0) {
    return renderObject({
      result: 'no-op',
      sheet: flags.sheet,
      patched: 0,
      unchanged: records.length,
    });
  }

  const commitMessage = flags.message ?? `${flags.sheet} patch (${changes.length})`;
  try {
    const result = await repo.transact({ message: commitMessage }, async (tx) => {
      const txSheet = tx.sheet(flags.sheet, prefixOpts);
      for (const { query, partial } of changes) {
        await txSheet.patch(query, partial);
      }
      return changes.length;
    });
    return joinBlocks(
      renderObject({
        result: 'committed',
        sheet: flags.sheet,
        patched: changes.length,
        unchanged: records.length - changes.length,
        commit: result.commitHash,
      }),
      renderHelp([MATERIALIZE_HINT]),
    );
  } catch (error) {
    throw translateError(error);
  }
}

type PatchPreview =
  | 'not-found'
  | { changed: boolean; path: string; hash: string | undefined };

/**
 * Resolve the record matched by `query`, apply the RFC 7396 merge, and run the
 * result through willChange — the shared pre-flight for both single and bulk
 * patch. Returns 'not-found' when the query matches no record.
 */
async function previewPatch(
  sheet: Sheet,
  query: Record<string, unknown>,
  partial: Record<string, unknown>,
): Promise<PatchPreview> {
  const existing = await sheet.queryFirst(query);
  if (!existing) return 'not-found';

  const merged = mergePatch(stripSymbols(existing), partial) as Record<string, unknown>;
  // Preserve the record's path annotation so willChange applies rename logic
  // when a path-template field changed (matches Sheet.patch behavior).
  const pathSym = (existing as Record<symbol, unknown>)[Symbol.for('gitsheets-path')];
  if (typeof pathSym === 'string') {
    (merged as Record<symbol, unknown>)[Symbol.for('gitsheets-path')] = pathSym;
  }

  // patch is body-preserving; allowMissingBody defers the upsert body guard
  // since the merge already produced the canonical record.
  const wc = await sheet.willChange(merged as never, { allowMissingBody: true });
  return { changed: wc.changed, path: wc.path, hash: wc.currentBlobHash };
}

function attribute(axi: AxiError, index: number, record: Record<string, unknown>): AxiError {
  return new AxiError(
    `Record ${index + 1} (${recordLabel(record)}): ${axi.message}`,
    axi.code,
    ['The whole batch was aborted — nothing committed. Fix or remove the record and re-run.'],
  );
}

function stripSymbols(record: unknown): unknown {
  if (!record || typeof record !== 'object') return record;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record as Record<string, unknown>)) {
    out[key] = (record as Record<string, unknown>)[key];
  }
  return out;
}
