import { AxiError } from 'axi-sdk-js';
import { mergePatch, Template, type Repository, type Sheet } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { joinBlocks, renderHelp, renderObject } from '../output/render.js';
import { readStdin } from '../util/stdin.js';
import { openSheetForCommand } from '../util/open-sheet.js';
import { parseRecordsInput, recordLabel } from '../util/parse-records.js';
import { MATERIALIZE_HINT } from '../util/hints.js';
import { renderDryRun, type InvalidRow } from './upsert.js';

const PATH_KEY = Symbol.for('gitsheets-path');
type OnMissing = 'abort' | 'skip' | 'insert';

export const PATCH_HELP = `usage: gitsheets-axi patch <sheet> <query-json> [--patch <json>] [--prefix p] [--message m]
       gitsheets-axi patch <sheet> [--data <json>] [--on-missing m] [--delete-missing] [--dry-run]   # bulk
flags[7]:
  --patch <json>       Single mode: RFC 7396 partial. If omitted, reads stdin.
  --data <json>        Bulk mode: JSON array / NDJSON of combined records.
  --on-missing <m>     Bulk: what to do when a record's query matches nothing —
                       abort (default) | skip | insert (upsert it as new).
  --delete-missing     Bulk: delete existing records NOT targeted by the batch
                       (exact re-sync). One commit.
  --dry-run            Bulk: preview {will-change, no-op, missing, invalid,
                       delete} — no commit.
  --prefix <p>         Tenant sub-tree scope
  --message <m>        Commit message (default: "<sheet> patch <path>")
examples:
  gitsheets-axi patch users '{"slug":"jane"}' --patch '{"name":"Jane O. Doe"}'
  jq -c '.[]' classify.json | gitsheets-axi patch repos                   # bulk, one commit
  jq -c '.[]' classify.json | gitsheets-axi patch repos --on-missing skip # tolerate stale rows
  gitsheets-axi patch repos --data "$(cat sync.json)" --on-missing insert --delete-missing
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
  Unchanged records are skipped; a batch where nothing changed exits 0 with
  result: "no-op" and no commit. With --on-missing abort (default), a record
  matching nothing aborts the batch (nothing committed); --dry-run reports all
  missing/invalid rows at once.
`;

interface PatchFlags {
  sheet: string;
  queryJson: string | undefined;
  patchJson: string | undefined;
  data: string | undefined;
  prefix: string | undefined;
  message: string | undefined;
  onMissing: OnMissing;
  deleteMissing: boolean;
  dryRun: boolean;
}

function parsePatchFlags(args: string[]): PatchFlags {
  const flags: PatchFlags = {
    sheet: '',
    queryJson: undefined,
    patchJson: undefined,
    data: undefined,
    prefix: undefined,
    message: undefined,
    onMissing: 'abort',
    deleteMissing: false,
    dryRun: false,
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
      case '--on-missing':
        if (next !== 'abort' && next !== 'skip' && next !== 'insert') {
          throw new AxiError('--on-missing expects abort | skip | insert', 'VALIDATION_ERROR');
        }
        flags.onMissing = next;
        i++;
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
    if (flags.onMissing !== 'abort' || flags.deleteMissing || flags.dryRun) {
      throw new AxiError(
        '--on-missing / --delete-missing / --dry-run are bulk-only — drop the <query-json> positional',
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
  const template = Template.fromString(config.path);
  const templateFields = new Set(template.getFieldNames());

  // Pre-flight: split each record into (query, partial) and categorize —
  // changed / unchanged / missing (query matched nothing) / invalid — before
  // opening a transaction. We never throw mid-loop so --dry-run can report the
  // full picture; the commit path aborts explicitly afterward.
  const changes: Array<{ query: Record<string, unknown>; partial: Record<string, unknown> }> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const batchPaths = new Set<string>();
  const invalid: InvalidRow[] = [];
  const missing: Array<{ row: number; id: string }> = [];
  let unchanged = 0;

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const query: Record<string, unknown> = {};
    const partial: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (templateFields.has(k)) query[k] = v;
      else partial[k] = v;
    }

    if (Object.keys(query).length === 0) {
      invalid.push({
        row: i + 1,
        id: recordLabel(record),
        reason: `has none of the path-template fields (${[...templateFields].join(', ')})`,
        code: 'VALIDATION_ERROR',
      });
      continue;
    }

    let preview;
    try {
      preview = await previewPatch(sheet, query, partial);
    } catch (error) {
      const axi = translateError(error);
      invalid.push({ row: i + 1, id: recordLabel(record), reason: axi.message, code: axi.code });
      continue;
    }

    if (preview === 'not-found') {
      if (flags.onMissing === 'skip') {
        missing.push({ row: i + 1, id: recordLabel(record) });
      } else if (flags.onMissing === 'insert') {
        inserts.push(record);
        try {
          batchPaths.add(template.render(record));
        } catch {
          /* un-renderable insert surfaces at commit; ignore for path set */
        }
      } else {
        missing.push({ row: i + 1, id: recordLabel(record) }); // abort mode: collected, thrown below
      }
      continue;
    }

    batchPaths.add(preview.path);
    if (preview.changed) changes.push({ query, partial });
    else unchanged++;
  }

  // --delete-missing: existing records not targeted by the batch.
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
        willChange: changes.length,
        insert: inserts.length,
        noOp: unchanged,
        missing: missing.length,
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
  if (flags.onMissing === 'abort' && missing.length > 0) {
    const first = missing[0]!;
    throw new AxiError(`Record ${first.row} (${first.id}): no record matches its query`, 'NOT_FOUND', [
      `${missing.length} record(s) matched nothing — batch aborted. Use --on-missing skip|insert, or --dry-run to see all.`,
    ]);
  }

  if (changes.length === 0 && inserts.length === 0 && deletions.length === 0) {
    return renderObject({
      result: 'no-op',
      sheet: flags.sheet,
      patched: 0,
      unchanged: records.length - invalid.length - missing.length,
      ...(missing.length > 0 ? { skipped: missing.length } : {}),
    });
  }

  const commitMessage = flags.message ?? `${flags.sheet} patch (${changes.length + inserts.length})`;
  try {
    const result = await repo.transact({ message: commitMessage }, async (tx) => {
      const txSheet = tx.sheet(flags.sheet, prefixOpts);
      for (const { query, partial } of changes) await txSheet.patch(query, partial);
      for (const record of inserts) await txSheet.upsert(record as never);
      for (const path of deletions) await txSheet.delete(path);
      return changes.length;
    });
    return joinBlocks(
      renderObject({
        result: 'committed',
        sheet: flags.sheet,
        patched: changes.length,
        ...(inserts.length > 0 ? { inserted: inserts.length } : {}),
        unchanged,
        ...(missing.length > 0 ? { skipped: missing.length } : {}),
        ...(flags.deleteMissing ? { deleted: deletions.length } : {}),
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

function stripSymbols(record: unknown): unknown {
  if (!record || typeof record !== 'object') return record;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record as Record<string, unknown>)) {
    out[key] = (record as Record<string, unknown>)[key];
  }
  return out;
}
