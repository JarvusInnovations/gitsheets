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
import { upsertCommand, UPSERT_HELP } from '../src/commands/upsert.js';
import { patchCommand, PATCH_HELP } from '../src/commands/patch.js';
import { deleteCommand, DELETE_HELP } from '../src/commands/delete.js';
import { checkCommand, CHECK_HELP } from '../src/commands/check.js';
import { diffCommand, DIFF_HELP } from '../src/commands/diff.js';
import { normalizeCommand, NORMALIZE_HELP } from '../src/commands/normalize.js';
import { initCommand, INIT_HELP } from '../src/commands/init.js';
import { inferCommand, INFER_HELP } from '../src/commands/infer.js';
import {
  migrateConfigCommand,
  MIGRATE_CONFIG_HELP,
} from '../src/commands/migrate-config.js';
import { attachmentCommand, ATTACHMENT_HELP } from '../src/commands/attachment.js';
import { pushCommand, PUSH_HELP } from '../src/commands/push.js';
import { setupCommand, SETUP_HELP } from '../src/commands/setup.js';

const COMMAND_HELP: Record<string, string> = {
  sheets: SHEETS_HELP,
  query: QUERY_HELP,
  read: READ_HELP,
  upsert: UPSERT_HELP,
  patch: PATCH_HELP,
  delete: DELETE_HELP,
  check: CHECK_HELP,
  diff: DIFF_HELP,
  normalize: NORMALIZE_HELP,
  init: INIT_HELP,
  infer: INFER_HELP,
  'migrate-config': MIGRATE_CONFIG_HELP,
  attachment: ATTACHMENT_HELP,
  push: PUSH_HELP,
  setup: SETUP_HELP,
};

const COMMANDS = {
  sheets: sheetsCommand,
  query: queryCommand,
  read: readCommand,
  upsert: upsertCommand,
  patch: patchCommand,
  delete: deleteCommand,
  check: checkCommand,
  diff: diffCommand,
  normalize: normalizeCommand,
  init: initCommand,
  infer: inferCommand,
  'migrate-config': migrateConfigCommand,
  attachment: attachmentCommand,
  push: pushCommand,
  setup: setupCommand,
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

  const prevNoStdin = process.env['GITSHEETS_AXI_NO_STDIN'];
  process.env['GITSHEETS_AXI_NO_STDIN'] = '1';

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
    if (prevNoStdin === undefined) {
      delete process.env['GITSHEETS_AXI_NO_STDIN'];
    } else {
      process.env['GITSHEETS_AXI_NO_STDIN'] = prevNoStdin;
    }
  }
}
