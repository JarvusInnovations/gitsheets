import { AxiError } from 'axi-sdk-js';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { joinBlocks, renderHelp, renderObject } from '../output/render.js';
import { shapeOptions, takeCommitFlags } from '../util/commit-flags.js';

export const COMMIT_HELP = `usage: gitsheets-axi commit --message <m> [--allow-empty] [--replace <commit>] [--also-parent <commit> ...] [--trailer 'Key: value' ...]
flags[5]:
  --message <m>          Commit message (required)
  --allow-empty          Commit even though no record changes
  --replace <commit>     Replace the branch tip, which must be <commit>
                         (TIP_MISMATCH otherwise; TIP_PUBLISHED when a remote has it)
  --also-parent <c>      Additional parent (repeatable): what this was built on; gitsheets attaches no behaviour
  --trailer 'Key: v'     Commit trailer (repeatable; Key=v also accepted)
examples:
  gitsheets-axi --branch log commit --allow-empty --message 'cycle 42: end' --trailer 'Cycle-Id: 42'
  gitsheets-axi --branch log commit --allow-empty --replace <tip> --message 'cycle 42: end' --trailer 'State: done'
notes:
  Needs --allow-empty, --replace, or both. Writes no record. Read the result
  back with \`gitsheets-axi head\`.
`;

export async function commitCommand(args: string[], ctx: GitsheetsContext): Promise<string> {
  if (args.length === 0 || args.includes('--help')) return COMMIT_HELP;
  const { rest, shape } = takeCommitFlags(args, { allowEmpty: true });
  let message: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--message') {
      message = rest[i + 1];
      if (message === undefined) throw new AxiError('--message expects a string', 'VALIDATION_ERROR');
      i++;
    } else if (arg.startsWith('--message=')) {
      message = arg.slice('--message='.length);
    } else {
      throw new AxiError(`Unknown ${arg.startsWith('-') ? 'flag' : 'argument'}: ${arg}`, 'VALIDATION_ERROR', [
        'Run `gitsheets-axi commit --help`',
      ]);
    }
  }
  if (message === undefined || message === '') {
    throw new AxiError('commit requires --message', 'VALIDATION_ERROR', ["Example: gitsheets-axi commit --allow-empty --message 'cycle 1'"]);
  }
  if (!shape.allowEmpty && shape.replace === undefined) {
    throw new AxiError('Nothing to commit: pass --allow-empty, --replace <tip>, or both', 'VALIDATION_ERROR', [
      'An empty commit needs --allow-empty; rewriting the tip needs --replace <tip>',
    ]);
  }

  const repo = await ctx.repo();
  try {
    const result = await repo.transact({ message, ...shapeOptions(shape) }, async () => undefined);
    const branch = repo.branch !== null ? `refs/heads/${repo.branch}` : 'HEAD';
    if (result.commitHash === null) {
      const tip = await repo.readCommit();
      return joinBlocks(
        renderObject({ result: 'no-op', branch, tip: tip?.hash ?? null }),
        renderHelp(['The replacement would change nothing relative to its parent; pass --allow-empty to commit it anyway']),
      );
    }
    const info = await repo.readCommit(result.commitHash);
    return joinBlocks(
      renderObject({
        result: 'committed',
        commit: result.commitHash,
        branch,
        ...(result.replacedCommitHash ? { replaced: result.replacedCommitHash } : {}),
      }),
      renderObject({ parents: [...(info?.parents ?? [])] }),
    );
  } catch (error) {
    throw translateError(error);
  }
}
