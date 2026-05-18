import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAxiCli } from 'axi-sdk-js';

import { createContext, type GitsheetsContext } from './context.js';
import { homeCommand } from './commands/home.js';
import { sheetsCommand, SHEETS_HELP } from './commands/sheets.js';
import { queryCommand, QUERY_HELP } from './commands/query.js';
import { readCommand, READ_HELP } from './commands/read.js';

const DESCRIPTION =
  'gitsheets — agent-facing interface for the git-backed document store. ' +
  'Token-efficient TOON output, idempotent mutations, format-aware schemas.';

const VERSION = readPackageVersion();

export const TOP_HELP = `usage: gitsheets-axi [command] [args] [flags]
commands[4]:
  (none)=home, sheets, query, read
flags[2]:
  --help, -v/-V/--version
examples:
  gitsheets-axi
  gitsheets-axi sheets
  gitsheets-axi sheets view users
  gitsheets-axi query users --filter status=active
  gitsheets-axi read posts hello --full
`;

const COMMAND_HELP: Record<string, string> = {
  sheets: SHEETS_HELP,
  query: QUERY_HELP,
  read: READ_HELP,
};

type CommandFn = (args: string[], ctx: GitsheetsContext) => Promise<string | Record<string, unknown>>;

const COMMANDS: Record<string, CommandFn> = {
  sheets: sheetsCommand,
  query: queryCommand,
  read: readCommand,
};

export async function main(): Promise<void> {
  await runAxiCli<GitsheetsContext>({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(process.env.GITSHEETS_AXI_DISABLE_HOOKS === '1' ? { hooks: false as const } : {}),
    resolveContext: () => createContext(),
    home: (_args, ctx) => homeCommand(ctx as GitsheetsContext),
    commands: COMMANDS as Record<
      string,
      (args: string[], ctx: GitsheetsContext | undefined) => Promise<string | Record<string, unknown>>
    >,
    getCommandHelp: (command) => COMMAND_HELP[command],
  });
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  for (const candidate of [
    join(here, '..', 'package.json'),
    join(here, '..', '..', 'package.json'),
  ]) {
    if (!existsSync(candidate)) continue;

    const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as {
      version?: unknown;
    };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  }

  throw new Error('Could not determine gitsheets-axi package version');
}
