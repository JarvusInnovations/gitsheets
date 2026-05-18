import { AxiError } from 'axi-sdk-js';
import { mergePatch } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderObject } from '../output/render.js';
import { readStdin } from '../util/stdin.js';

export const PATCH_HELP = `usage: gitsheets-axi patch <sheet> <query-json> [--patch <json>] [--prefix p] [--message m]
flags[3]:
  --patch <json>       RFC 7396 partial. If omitted, reads stdin.
  --prefix <p>         Tenant sub-tree scope
  --message <m>        Commit message (default: "<sheet> patch <path>")
examples:
  gitsheets-axi patch users '{"slug":"jane"}' --patch '{"name":"Jane O. Doe"}'
  echo '{"name":"Jane O. Doe"}' | gitsheets-axi patch users '{"slug":"jane"}'
semantics:
  RFC 7396 JSON Merge Patch. \`null\` deletes a field, arrays replace
  in full, objects merge recursively. Same as gitsheets's library patch.
idempotency:
  Reads the existing record, applies the merge, runs the result through
  willChange. If the canonical bytes are unchanged, exits 0 with
  result: "no-op" and no commit is produced.
`;

interface PatchFlags {
  sheet: string;
  queryJson: string;
  patchJson: string | undefined;
  prefix: string | undefined;
  message: string | undefined;
}

function parsePatchFlags(args: string[]): PatchFlags {
  const flags: PatchFlags = {
    sheet: '',
    queryJson: '',
    patchJson: undefined,
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
  if (positional.length !== 2) {
    throw new AxiError('patch requires <sheet> <query-json>', 'VALIDATION_ERROR', [
      "Example: gitsheets-axi patch users '{\"slug\":\"jane\"}' --patch '{...}'",
    ]);
  }
  flags.sheet = positional[0]!;
  flags.queryJson = positional[1]!;
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

  let query: Record<string, unknown>;
  try {
    query = JSON.parse(flags.queryJson) as Record<string, unknown>;
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

  let existing;
  try {
    existing = await sheet.queryFirst(query);
  } catch (error) {
    throw translateError(error);
  }
  if (!existing) {
    throw new AxiError(
      `${flags.sheet}: no record matches the query`,
      'NOT_FOUND',
    );
  }

  // Apply RFC 7396 merge in-axi so we can run willChange against the result.
  const merged = mergePatch(stripSymbols(existing), partial) as Record<
    string,
    unknown
  >;

  // Preserve the record's path annotation so willChange uses the rename path
  // logic if any path-template field changed (matches Sheet.patch behavior).
  const pathSym = (existing as Record<symbol, unknown>)[Symbol.for('gitsheets-path')];
  if (typeof pathSym === 'string') {
    (merged as Record<symbol, unknown>)[Symbol.for('gitsheets-path')] = pathSym;
  }

  // Body-presence on content-typed sheets: patch is body-preserving — the
  // merged record carries the existing body forward unless the partial
  // explicitly replaced it. Use allowMissingBody to defer the upsert guard
  // since the merge produces the canonical record either way.
  const upsertOpts = { allowMissingBody: true } as const;

  let willResult;
  try {
    willResult = await sheet.willChange(merged as never, upsertOpts);
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
    flags.message ?? `${flags.sheet} patch ${willResult.path}`;
  try {
    const result = await repo.transact(
      { message: commitMessage },
      async (tx) => {
        const txSheet = tx.sheet(
          flags.sheet,
          flags.prefix !== undefined ? { prefix: flags.prefix } : {},
        );
        return txSheet.patch(query, partial);
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

function stripSymbols(record: unknown): unknown {
  if (!record || typeof record !== 'object') return record;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record as Record<string, unknown>)) {
    out[key] = (record as Record<string, unknown>)[key];
  }
  return out;
}
