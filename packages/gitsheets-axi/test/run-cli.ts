// Test helper: run gitsheets-axi commands programmatically against a given
// working directory. We can't just spawn the bin because the built `dist/`
// might not exist during a fresh checkout. Instead, capture process.cwd(),
// chdir to the test repo, run the SDK dispatcher, restore cwd, and return
// the captured stdout.

import { runAxiCli } from 'axi-sdk-js';

import { createContext, parseGlobalFlagsForDispatch, type GitsheetsContext } from '../src/context.js';
import { homeCommand } from '../src/commands/home.js';
import { COMMAND_HELP, COMMANDS as CLI_COMMANDS } from '../src/cli.js';

// The production command table (the commit-shape wrappers included), so the
// tests drive exactly what the binary dispatches.
const COMMANDS = CLI_COMMANDS as Record<
  string,
  (args: string[], ctx: GitsheetsContext | undefined) => Promise<string | Record<string, unknown>>
>;

export interface RunResult {
  stdout: string;
  exitCode: number;
}

/**
 * Run the CLI dispatcher in-process against `cwd`. Captures stdout and the
 * `process.exitCode` the SDK sets. Restores cwd + exitCode on return.
 */
export async function runCli(argv: string[], cwd: string): Promise<RunResult> {
  const prevCwd = process.cwd();
  const prevExit = process.exitCode;
  let captured = '';

  const prevNoStdin = process.env['GITSHEETS_AXI_NO_STDIN'];
  process.env['GITSHEETS_AXI_NO_STDIN'] = '1';

  try {
    process.chdir(cwd);
    process.exitCode = 0;

    const globals = parseGlobalFlagsForDispatch(argv);
    await runAxiCli<GitsheetsContext>({
      description: 'test-instance',
      version: '0.0.0-test',
      topLevelHelp: 'test',
      hooks: false,
      argv: globals.rest,
      resolveContext: () => createContext(globals.flags),
      home: (_args, ctx) => homeCommand(ctx as GitsheetsContext),
      commands: { ...COMMANDS, ...globals.commands },
      getCommandHelp: (command) => COMMAND_HELP[command],
      stdout: { write: (chunk: string) => { captured += chunk; return true; } },
    });

    const exitCode = process.exitCode ?? 0;
    return { stdout: captured, exitCode: Number(exitCode) };
  } finally {
    process.chdir(prevCwd);
    process.exitCode = prevExit;
    if (prevNoStdin === undefined) {
      delete process.env['GITSHEETS_AXI_NO_STDIN'];
    } else {
      process.env['GITSHEETS_AXI_NO_STDIN'] = prevNoStdin;
    }
  }
}
