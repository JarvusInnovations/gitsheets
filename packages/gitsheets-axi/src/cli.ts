import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAxiCli } from 'axi-sdk-js';

import { createContext, parseGlobalFlagsForDispatch, type GitsheetsContext } from './context.js';
import { homeCommand } from './commands/home.js';
import { sheetsCommand, SHEETS_HELP } from './commands/sheets.js';
import { queryCommand, QUERY_HELP } from './commands/query.js';
import { countCommand, COUNT_HELP } from './commands/count.js';
import { distinctCommand, DISTINCT_HELP } from './commands/distinct.js';
import { aggregateCommand, AGGREGATE_HELP } from './commands/aggregate.js';
import { readCommand, READ_HELP } from './commands/read.js';
import { upsertCommand, UPSERT_HELP } from './commands/upsert.js';
import { patchCommand, PATCH_HELP } from './commands/patch.js';
import { renameCommand, RENAME_HELP } from './commands/rename.js';
import { deleteCommand, DELETE_HELP } from './commands/delete.js';
import { checkCommand, CHECK_HELP } from './commands/check.js';
import { diffCommand, DIFF_HELP } from './commands/diff.js';
import { normalizeCommand, NORMALIZE_HELP } from './commands/normalize.js';
import { initCommand, INIT_HELP } from './commands/init.js';
import { inferCommand, INFER_HELP } from './commands/infer.js';
import { migrateConfigCommand, MIGRATE_CONFIG_HELP } from './commands/migrate-config.js';
import { attachmentCommand, ATTACHMENT_HELP } from './commands/attachment.js';
import { contractsCommand, CONTRACTS_HELP } from './commands/contracts.js';
import { pushCommand, PUSH_HELP } from './commands/push.js';
import { setupCommand, SETUP_HELP } from './commands/setup.js';
import { rollupCommand, ROLLUP_HELP } from './commands/rollup.js';

const DESCRIPTION =
  'gitsheets — agent-facing interface for the git-backed document store. ' +
  'Token-efficient TOON output, idempotent mutations, format-aware schemas.';

const VERSION = readPackageVersion();

export const TOP_HELP = `usage: gitsheets-axi [command] [args] [flags]
commands[22]:
  (none)=home, sheets, query, count,
  distinct, aggregate, read, upsert, patch, rename,
  delete, check, diff, normalize,
  init, infer, migrate-config,
  attachment, contracts, push, setup, rollup
flags[6]:
  --help, -v/-V/--version
  --branch <name>  Default branch every command reads/writes (any command;
                   default: $GITSHEETS_BRANCH, gitsheets.branch, HEAD's branch)
  --submodule <p>  Data submodule every command reads/writes; writes advance
                   its HEAD (the superproject's pointer). Any command;
                   default: $GITSHEETS_SUBMODULE, gitsheets.submodule
  --stage-pointer  With --submodule: also stage the moved gitlink after each
                   write (--no-stage-pointer: off). Default:
                   $GITSHEETS_STAGE_POINTER, gitsheets.stagePointer, off
  --at <ref>       With --submodule: read-only at the data commit this
                   superproject ref pins; writes are refused. Default: $GITSHEETS_AT
examples:
  gitsheets-axi
  gitsheets-axi query repos --filter status=unclassified --sort pushed_at
  gitsheets-axi count repos --filter archived=true
  gitsheets-axi query repos --group-by target_team
  gitsheets-axi distinct repos disposition
  gitsheets-axi aggregate tx --agg total=sum:amountCents --group-by status
  gitsheets-axi upsert users --data '{"slug":"jane","email":"jane@x.org"}'
  gitsheets-axi patch users '{"slug":"jane"}' --patch '{"name":"Jane"}'
  gitsheets-axi check users users/jane.toml --fix
  gitsheets-axi diff posts HEAD~10
  gitsheets-axi attachment list users jane
  gitsheets-axi contracts verify
  gitsheets-axi setup hooks
  gitsheets-axi rollup transactions-monthly --check
`;

const COMMAND_HELP: Record<string, string> = {
  sheets: SHEETS_HELP,
  query: QUERY_HELP,
  count: COUNT_HELP,
  distinct: DISTINCT_HELP,
  aggregate: AGGREGATE_HELP,
  read: READ_HELP,
  upsert: UPSERT_HELP,
  patch: PATCH_HELP,
  rename: RENAME_HELP,
  delete: DELETE_HELP,
  check: CHECK_HELP,
  diff: DIFF_HELP,
  normalize: NORMALIZE_HELP,
  init: INIT_HELP,
  infer: INFER_HELP,
  'migrate-config': MIGRATE_CONFIG_HELP,
  attachment: ATTACHMENT_HELP,
  contracts: CONTRACTS_HELP,
  push: PUSH_HELP,
  setup: SETUP_HELP,
  rollup: ROLLUP_HELP,
};

type CommandFn = (args: string[], ctx: GitsheetsContext) => Promise<string | Record<string, unknown>>;

const COMMANDS: Record<string, CommandFn> = {
  sheets: sheetsCommand,
  query: queryCommand,
  count: countCommand,
  distinct: distinctCommand,
  aggregate: aggregateCommand,
  read: readCommand,
  upsert: upsertCommand,
  patch: patchCommand,
  rename: renameCommand,
  delete: deleteCommand,
  check: checkCommand,
  diff: diffCommand,
  normalize: normalizeCommand,
  init: initCommand,
  infer: inferCommand,
  'migrate-config': migrateConfigCommand,
  attachment: attachmentCommand,
  contracts: contractsCommand,
  push: pushCommand,
  setup: setupCommand,
  rollup: rollupCommand,
};

export async function main(): Promise<void> {
  // Global flags, accepted on any command (specs/behaviors/default-branch.md "CLI").
  const globals = parseGlobalFlagsForDispatch(process.argv.slice(2));
  await runAxiCli<GitsheetsContext>({
    description: DESCRIPTION,
    version: VERSION,
    argv: globals.rest,
    topLevelHelp: TOP_HELP,
    resolveContext: () => createContext(globals.flags),
    home: (_args, ctx) => homeCommand(ctx as GitsheetsContext),
    commands: { ...COMMANDS, ...globals.commands } as Record<
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
