import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { AxiError } from 'axi-sdk-js';

import type { GitsheetsContext } from '../context.js';
import { renderObject } from '../output/render.js';

const exec = promisify(execFile);

export const PUSH_HELP = `usage: gitsheets-axi push [--remote r] [--branch b]
flags[2]:
  --remote <r>         Git remote to push to (default: origin)
  --branch <b>         Branch to push (default: the repo's current HEAD branch)
examples:
  gitsheets-axi push
  gitsheets-axi push --remote upstream --branch main
behavior:
  One-shot push via \`git push <remote> <branch>\`. For agent workflows
  that want to publish after a mutation without spinning up a background
  daemon. This is NOT a daemon lifecycle command — for retry-with-backoff
  semantics, use Repository.startPushDaemon from a long-running consumer.
idempotency:
  When the remote is already up to date, exits 0 with
  result: "no-op" — git's natural "Everything up-to-date" path.
errors:
  NON_FAST_FORWARD     Remote has work the local doesn't — never force-pushed.
                       Reconcile externally (pull or rebase), then re-run.
  PUSH_FAILED          Network / auth / other transient failure. Re-run later.
`;

interface PushFlags {
  remote: string;
  branch: string | undefined;
}

function parsePushFlags(args: string[]): PushFlags {
  const flags: PushFlags = { remote: 'origin', branch: undefined };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];
    if (arg === '--remote') {
      if (!next) throw new AxiError('--remote expects a name', 'VALIDATION_ERROR');
      flags.remote = next;
      i++;
      continue;
    }
    if (arg === '--branch') {
      if (!next) throw new AxiError('--branch expects a name', 'VALIDATION_ERROR');
      flags.branch = next;
      i++;
      continue;
    }
    if (arg === '--help') continue;
    throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
      'Run `gitsheets-axi push --help`',
    ]);
  }
  return flags;
}

async function resolveBranch(gitDir: string): Promise<string> {
  const { stdout } = await exec(
    'git',
    ['symbolic-ref', '--short', 'HEAD'],
    { cwd: gitDir },
  );
  const branch = stdout.trim();
  if (!branch) {
    throw new AxiError(
      "Couldn't determine current branch (detached HEAD?)",
      'REF_ERROR',
      ['Pass --branch explicitly, e.g. `gitsheets-axi push --branch main`'],
    );
  }
  return branch;
}

function classifyPushError(message: string): 'NON_FAST_FORWARD' | 'PUSH_FAILED' {
  if (/!\s*\[rejected\]/.test(message) && /(non-fast-forward|fetch first)/i.test(message)) {
    return 'NON_FAST_FORWARD';
  }
  return 'PUSH_FAILED';
}

export async function pushCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 1 && args[0] === '--help') return PUSH_HELP;

  const flags = parsePushFlags(args);
  const repo = await ctx.repo();
  const gitDir = repo.gitDir;
  const branch = flags.branch ?? (await resolveBranch(gitDir));

  let stderr = '';
  try {
    const result = await exec(
      'git',
      ['push', flags.remote, branch],
      { cwd: gitDir, maxBuffer: 10 * 1024 * 1024 },
    );
    stderr = result.stderr;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const combined = `${err.stderr ?? ''}\n${err.stdout ?? ''}\n${err.message ?? ''}`;
    const code = classifyPushError(combined);
    const suggestions =
      code === 'NON_FAST_FORWARD'
        ? [
            "Remote has commits the local doesn't — reconcile externally before retrying",
            'Stop the writer, fetch + rebase or pull, then restart',
          ]
        : ['Network or auth failure — retry, or check the remote configuration'];
    throw new AxiError(
      `git push to ${flags.remote} ${branch} failed: ${(err.message ?? '').split('\n')[0] ?? 'unknown error'}`,
      code,
      suggestions,
    );
  }

  // git's "Everything up-to-date" lands in stderr without an error code.
  // Treat as no-op.
  const upToDate = /everything up.to.date/i.test(stderr);
  if (upToDate) {
    return renderObject({
      result: 'no-op',
      remote: flags.remote,
      branch,
      reason: 'remote already up-to-date',
    });
  }

  return renderObject({
    result: 'pushed',
    remote: flags.remote,
    branch,
    // Strip git's noisy "To <url>" / hash lines into a compact summary.
    detail: stderr.split('\n').filter((l) => l.trim()).slice(0, 3).join('\n'),
  });
}
