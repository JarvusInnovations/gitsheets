import { AxiError } from 'axi-sdk-js';


import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderObject } from '../output/render.js';

export const PUSH_HELP = `usage: gitsheets-axi push [--remote r] [--to <commit>]
flags[2]:
  --remote <r>         Git remote to push to (default: origin)
  --to <commit>        Push the branch only up to this commit: the tip or a
                       first-parent ancestor of it (publish all but an open tip)
examples:
  gitsheets-axi push
  gitsheets-axi --branch log push --to <commit>
behavior:
  One-shot push of the bound branch (the global --branch), never forced. On
  success the remote-tracking ref is updated, so --replace then refuses the
  published commit (TIP_PUBLISHED) while the open tip above it stays
  replaceable. Not a daemon: for retry-with-backoff use
  Repository.startPushDaemon from a long-running consumer.
idempotency:
  When the remote is already up to date, exits 0 with result: "no-op".
errors:
  NON_FAST_FORWARD     Remote has work the local doesn't — never force-pushed.
  PUSH_FAILED          Network / auth / other transient failure. Re-run later.
  REF_ERROR            Detached HEAD binding, or --to not on the branch's first-parent line.
`;

interface PushFlags {
  remote: string;
  to: string | undefined;
}

function parsePushFlags(args: string[]): PushFlags {
  const flags: PushFlags = { remote: 'origin', to: undefined };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];
    if (arg === '--remote' || arg === '--to') {
      if (!next) throw new AxiError(`${arg} expects a value`, 'VALIDATION_ERROR');
      if (arg === '--remote') flags.remote = next;
      else flags.to = next;
      i++;
      continue;
    }
    if (arg.startsWith('--remote=')) {
      flags.remote = arg.slice('--remote='.length);
      continue;
    }
    if (arg.startsWith('--to=')) {
      flags.to = arg.slice('--to='.length);
      continue;
    }
    if (arg === '--help') continue;
    throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
      'Run `gitsheets-axi push --help`',
    ]);
  }
  return flags;
}

export async function pushCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 1 && args[0] === '--help') return PUSH_HELP;

  const flags = parsePushFlags(args);
  const repo = await ctx.repo();
  if (!repo.branch) {
    throw new AxiError(
      "Couldn't determine current branch (detached HEAD?)",
      'REF_ERROR',
      ['Pass --branch explicitly, e.g. `gitsheets-axi push --branch main`'],
    );
  }
  let r;
  try {
    r = await repo.push({ remote: flags.remote, ...(flags.to !== undefined ? { to: flags.to } : {}) });
  } catch (error) {
    throw translateError(error);
  }
  if (r.outcome === 'non-fast-forward' || r.outcome === 'failed') {
    const code = r.outcome === 'non-fast-forward' ? 'NON_FAST_FORWARD' : 'PUSH_FAILED';
    throw new AxiError(
      `git push to ${r.remote} ${r.branch} failed: ${(r.error ?? 'unknown error').split('\n')[0]}`,
      code,
      code === 'NON_FAST_FORWARD'
        ? [
            "Remote has commits the local doesn't — reconcile externally before retrying",
            'Stop the writer, fetch + rebase or pull, then restart',
          ]
        : ['Network or auth failure — retry, or check the remote configuration'],
    );
  }
  if (r.outcome === 'up-to-date') {
    return renderObject({ result: 'no-op', remote: r.remote, branch: r.branch, commit: r.commit, reason: 'remote already up-to-date' });
  }
  return renderObject({ result: 'pushed', remote: r.remote, branch: r.branch, commit: r.commit });
}
