import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAxiCli } from 'axi-sdk-js';

const DESCRIPTION =
  'gitsheets — agent-facing interface for the git-backed document store. ' +
  'Token-efficient TOON output, idempotent mutations, format-aware schemas.';

const VERSION = readPackageVersion();

export const TOP_HELP = `usage: gitsheets-axi [command] [args] [flags]
commands[1]:
  (none)=home
flags[2]:
  --help, -v/-V/--version
examples:
  gitsheets-axi
`;

export async function main(): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(process.env.GITSHEETS_AXI_DISABLE_HOOKS === '1' ? { hooks: false as const } : {}),
    home: async () => ({
      status: 'scaffold — commands not yet wired up',
      help: ['Run `gitsheets-axi --help` to see top-level usage'],
    }),
    commands: {},
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
