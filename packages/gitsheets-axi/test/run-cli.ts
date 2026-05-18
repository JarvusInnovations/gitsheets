// Test helper: run gitsheets-axi commands programmatically against a given
// working directory. We can't just spawn the bin because the built `dist/`
// might not exist during a fresh checkout. Instead, capture process.cwd(),
// chdir to the test repo, run the SDK dispatcher, restore cwd, and return
// the captured stdout.

import { runAxiCli } from 'axi-sdk-js';

import { createContext, type GitsheetsContext } from '../src/context.js';
import { homeCommand } from '../src/commands/home.js';
import { sheetsCommand, SHEETS_HELP } from '../src/commands/sheets.js';
import { queryCommand, QUERY_HELP } from '../src/commands/query.js';
import { readCommand, READ_HELP } from '../src/commands/read.js';

const COMMAND_HELP: Record<string, string> = {
  sheets: SHEETS_HELP,
  query: QUERY_HELP,
  read: READ_HELP,
};

const COMMANDS = {
  sheets: sheetsCommand,
  query: queryCommand,
  read: readCommand,
} as Record<
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

  try {
    process.chdir(cwd);
    process.exitCode = 0;

    await runAxiCli<GitsheetsContext>({
      description: 'test-instance',
      version: '0.0.0-test',
      topLevelHelp: 'test',
      hooks: false,
      argv,
      resolveContext: () => createContext(),
      home: (_args, ctx) => homeCommand(ctx as GitsheetsContext),
      commands: COMMANDS,
      getCommandHelp: (command) => COMMAND_HELP[command],
      stdout: { write: (chunk: string) => { captured += chunk; return true; } },
    });

    const exitCode = process.exitCode ?? 0;
    return { stdout: captured, exitCode: Number(exitCode) };
  } finally {
    process.chdir(prevCwd);
    process.exitCode = prevExit;
  }
}
