import { AxiError } from 'axi-sdk-js';
import { NotFoundError, RECORD_PATH_KEY, RECORD_SHEET_KEY } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderObject } from '../output/render.js';

export const READ_HELP = `usage: gitsheets-axi read <sheet> <path> [--full] [--prefix p]
flags[2]:
  --full               Don't truncate the body field on content-typed sheets
  --prefix <p>         Tenant sub-tree scope (see gitsheets --prefix)
examples:
  gitsheets-axi read users jane
  gitsheets-axi read posts hello --full
output:
  TOML sheet           — all fields, one per line
  Markdown/MDX sheet   — frontmatter fields + body truncated to ~500 chars
                         (with "(truncated, N chars total)" + --full hint)
`;

const BODY_PREVIEW_CHARS = 500;

interface ReadFlags {
  sheet: string;
  path: string;
  full: boolean;
  prefix: string | undefined;
}

function parseReadFlags(args: string[]): ReadFlags {
  const positional: string[] = [];
  const flags: ReadFlags = {
    sheet: '',
    path: '',
    full: false,
    prefix: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];
    if (arg === '--full') {
      flags.full = true;
      continue;
    }
    if (arg === '--prefix') {
      if (!next) {
        throw new AxiError('--prefix expects a path', 'VALIDATION_ERROR');
      }
      flags.prefix = next;
      i++;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
        'Run `gitsheets-axi read --help`',
      ]);
    }
    positional.push(arg);
  }
  if (positional.length !== 2) {
    throw new AxiError('read requires <sheet> <path>', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi read users jane',
    ]);
  }
  flags.sheet = positional[0]!;
  flags.path = positional[1]!;
  return flags;
}

export async function readCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return READ_HELP;
  }

  const flags = parseReadFlags(args);
  const repo = await ctx.repo();

  let sheet;
  try {
    sheet = await repo.openSheet(
      flags.sheet,
      flags.prefix !== undefined ? { prefix: flags.prefix } : {},
    );
  } catch (error) {
    throw translateError(error);
  }

  // The path is the rendered template result; drop a trailing `.toml`/`.md`
  // extension if the caller included one.
  const target = stripExtension(flags.path);

  let found: Record<string, unknown> | undefined;
  try {
    for await (const record of sheet.query()) {
      const pathSym = (record as Record<symbol, unknown>)[RECORD_PATH_KEY];
      if (pathSym === target) {
        found = record as Record<string, unknown>;
        break;
      }
    }
  } catch (error) {
    throw translateError(error);
  }

  if (!found) {
    throw translateError(
      new NotFoundError('record_not_found', `${flags.sheet}: no record at ${target}`),
    );
  }

  // Hydrate body for content-typed sheets — query() returns body-less records.
  const config = await sheet.readConfig();
  const bodyField = config.format.body;
  if (bodyField && (found as Record<string, unknown>)[bodyField] === undefined) {
    try {
      found = (await sheet.loadBody(found as never)) as unknown as Record<string, unknown>;
    } catch {
      // Body load failure is non-fatal — agent can still see frontmatter.
    }
  }

  const out: Record<string, unknown> = {};
  out['record'] = projectRecord(found, bodyField, flags.full);

  const help: string[] = [];
  if (bodyField && !flags.full) {
    const bodyValue = found[bodyField];
    if (typeof bodyValue === 'string' && bodyValue.length > BODY_PREVIEW_CHARS) {
      help.push(`Run \`gitsheets-axi read ${flags.sheet} ${target} --full\` to see complete body`);
    }
  }
  if (help.length > 0) out['help'] = help;

  return renderObject(out);
}

function stripExtension(path: string): string {
  if (path.endsWith('.toml')) return path.slice(0, -5);
  if (path.endsWith('.md')) return path.slice(0, -3);
  if (path.endsWith('.mdx')) return path.slice(0, -4);
  return path;
}

function projectRecord(
  record: Record<string, unknown>,
  bodyField: string | undefined,
  full: boolean,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === bodyField && !full && typeof value === 'string') {
      if (value.length > BODY_PREVIEW_CHARS) {
        cleaned[key] = `${value.slice(0, BODY_PREVIEW_CHARS)}…  (truncated, ${value.length} chars total)`;
      } else {
        cleaned[key] = value;
      }
      continue;
    }
    cleaned[key] = value;
  }
  // Symbol annotations: surface path as a plain field for visibility.
  const pathSym = (record as Record<symbol, unknown>)[RECORD_PATH_KEY];
  if (typeof pathSym === 'string') {
    cleaned['_path'] = pathSym;
  }
  const sheetSym = (record as Record<symbol, unknown>)[RECORD_SHEET_KEY];
  if (typeof sheetSym === 'string') {
    cleaned['_sheet'] = sheetSym;
  }
  return cleaned;
}
