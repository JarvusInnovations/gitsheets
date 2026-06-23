import { AxiError, installSessionStartHooks } from 'axi-sdk-js';

import type { GitsheetsContext } from '../context.js';
import { joinBlocks, renderHelp, renderObject } from '../output/render.js';

export const SETUP_HELP = `usage: gitsheets-axi setup hooks
Install or repair agent SessionStart hooks so each session starts with gitsheets-axi's
home view (the current repo's sheets) as ambient context. Idempotent; repairs a stale
executable path.
examples:
  gitsheets-axi setup hooks`;

export async function setupCommand(
  args: string[],
  _ctx?: GitsheetsContext,
): Promise<string> {
  if (args.includes('--help')) return SETUP_HELP;
  if (args[0] !== 'hooks') {
    throw new AxiError(`Unknown setup action: ${args[0] ?? '(none)'}`, 'VALIDATION_ERROR', [
      'Run `gitsheets-axi setup hooks`',
    ]);
  }

  const errors: string[] = [];
  installSessionStartHooks({
    marker: 'gitsheets-axi',
    timeoutSeconds: 10,
    onError: (m) => errors.push(m),
  });
  if (errors.length > 0) {
    throw new AxiError('Hook installation reported problems', 'HOOK_INSTALL_FAILED', errors);
  }

  return joinBlocks(
    renderObject({
      hooks: {
        status: 'installed',
        integrations: 'Claude Code, Codex, OpenCode',
        marker: 'gitsheets-axi',
      },
    }),
    renderHelp(['Restart your agent session to receive gitsheets-axi ambient context']),
  );
}
