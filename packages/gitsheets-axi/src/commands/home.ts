import { dirname } from 'node:path';
import { homedir } from 'node:os';

import type { GitsheetsContext } from '../context.js';
import { renderListResponse } from '../output/render.js';
import { countRecords } from '../output/sheet-schema.js';
import { display, field } from '../output/schema.js';
import { translateError } from '../errors.js';

function collapseHome(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

interface SheetSummary {
  name: string;
  format: string;
  records: number;
  root: string;
}

export async function homeCommand(
  ctx: GitsheetsContext,
): Promise<Record<string, unknown> | string> {
  const repo = await ctx.tryRepo();

  if (!repo) {
    return {
      status: 'no gitsheets repo here',
      help: [
        '`cd` into a directory inside a gitsheets-managed git repository',
        'Run `gitsheets-axi sheets` from there to see configured sheets',
      ],
    };
  }

  let sheets: Awaited<ReturnType<typeof repo.openSheets>>;
  try {
    sheets = await repo.openSheets();
  } catch (error) {
    throw translateError(error);
  }

  const summaries: SheetSummary[] = [];
  for (const [name, sheet] of Object.entries(sheets)) {
    let format = 'toml';
    let root = '.';
    let records = 0;
    try {
      const config = await sheet.readConfig();
      format = config.format.type ?? 'toml';
      root = (config as { root?: string }).root ?? '.';
      records = await countRecords(sheet);
    } catch {
      // If a sheet's config is malformed, skip the record count but keep
      // the row — agents need to see it exists.
    }
    summaries.push({ name, format, records, root });
  }
  summaries.sort((a, b) => a.name.localeCompare(b.name));

  const help: string[] = [];
  if (summaries.length === 0) {
    help.push(
      'No sheets configured — add a `.gitsheets/<name>.toml` to declare one',
    );
  } else {
    help.push('Run `gitsheets-axi sheets view <name>` to see a sheet\'s config');
    help.push('Run `gitsheets-axi query <sheet>` to list records');
  }

  const gitDir = repo.gitDir;
  const repoRoot = gitDir.endsWith('/.git') ? dirname(gitDir) : gitDir;

  return renderListResponse({
    header: { repo: collapseHome(repoRoot) },
    name: 'sheets',
    items: summaries as unknown as Array<Record<string, unknown>>,
    schema: [
      field('name'),
      display('format'),
      field('records'),
      field('root'),
    ],
    suggestions: help,
    emptyMessage: 'no sheets configured in this repository',
  });
}
