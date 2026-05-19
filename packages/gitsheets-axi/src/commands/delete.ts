import { AxiError } from 'axi-sdk-js';
import { NotFoundError, RECORD_PATH_KEY } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderObject } from '../output/render.js';

export const DELETE_HELP = `usage: gitsheets-axi delete <sheet> <path> [--prefix p] [--message m]
flags[2]:
  --prefix <p>         Tenant sub-tree scope
  --message <m>        Commit message (default: "<sheet> delete <path>")
examples:
  gitsheets-axi delete users jane
  gitsheets-axi delete posts hello --message "remove deprecated post"
idempotency:
  Already-missing records exit 0 with result: "no-op" — no commit, no
  error. Pattern: an agent re-running a workflow can safely call delete
  without checking existence first.
`;

interface DeleteFlags {
  sheet: string;
  path: string;
  prefix: string | undefined;
  message: string | undefined;
}

function parseDeleteFlags(args: string[]): DeleteFlags {
  const flags: DeleteFlags = {
    sheet: '',
    path: '',
    prefix: undefined,
    message: undefined,
  };
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
        'Run `gitsheets-axi delete --help`',
      ]);
    }
    positional.push(arg);
  }
  if (positional.length !== 2) {
    throw new AxiError('delete requires <sheet> <path>', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi delete users jane',
    ]);
  }
  flags.sheet = positional[0]!;
  flags.path = positional[1]!;
  return flags;
}

export async function deleteCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return DELETE_HELP;
  }

  const flags = parseDeleteFlags(args);
  const target = stripExtension(flags.path);

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

  // Pre-flight existence check — idempotent on already-missing.
  let exists = false;
  try {
    for await (const record of sheet.query()) {
      const pathSym = (record as Record<symbol, unknown>)[RECORD_PATH_KEY];
      if (pathSym === target) {
        exists = true;
        break;
      }
    }
  } catch (error) {
    throw translateError(error);
  }

  if (!exists) {
    return renderObject({
      result: 'no-op',
      sheet: flags.sheet,
      path: target,
      reason: 'record already absent',
    });
  }

  const commitMessage = flags.message ?? `${flags.sheet} delete ${target}`;
  try {
    const result = await repo.transact(
      { message: commitMessage },
      async (tx) => {
        const txSheet = tx.sheet(
          flags.sheet,
          flags.prefix !== undefined ? { prefix: flags.prefix } : {},
        );
        await txSheet.delete(target);
      },
    );
    return renderObject({
      result: 'committed',
      sheet: flags.sheet,
      path: target,
      commit: result.commitHash,
    });
  } catch (error) {
    // Edge: race where the record vanished between the existence check
    // and the delete. Treat as no-op rather than failing.
    if (error instanceof NotFoundError) {
      return renderObject({
        result: 'no-op',
        sheet: flags.sheet,
        path: target,
        reason: 'record vanished between check and delete',
      });
    }
    throw translateError(error);
  }
}

function stripExtension(path: string): string {
  if (path.endsWith('.toml')) return path.slice(0, -5);
  if (path.endsWith('.md')) return path.slice(0, -3);
  if (path.endsWith('.mdx')) return path.slice(0, -4);
  return path;
}
