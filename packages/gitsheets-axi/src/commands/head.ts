import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { AxiError } from 'axi-sdk-js';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { joinBlocks, renderHelp, renderList, renderObject } from '../output/render.js';
import { field } from '../output/schema.js';

export const HEAD_HELP = `usage: gitsheets-axi head [<commit>] [--json-out[=path]]
flags[1]:
  --json-out[=path]  Also write the commit as JSON (bare: an owner-only temp file)
examples:
  gitsheets-axi --branch log head
  gitsheets-axi --branch log head --json-out=/tmp/tip.json
output:
  branch, commit, tree, author, subject, body, parents (hashes, first first),
  trailers{key,value} — one row per trailer, repeats kept. The trailers come
  from the core's reading of the commit; nothing to parse.
`;

export async function headCommand(args: string[], ctx: GitsheetsContext): Promise<string> {
  if (args.includes('--help')) return HEAD_HELP;
  let rev: string | undefined;
  let jsonOut: string | true | undefined;
  for (const arg of args) {
    if (arg === '--json-out') jsonOut = true;
    else if (arg.startsWith('--json-out=')) {
      const p = arg.slice('--json-out='.length);
      if (p === '') throw new AxiError('--json-out= expects a path', 'VALIDATION_ERROR');
      jsonOut = p;
    } else if (arg.startsWith('-')) {
      throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', ['Run `gitsheets-axi head --help`']);
    } else if (rev === undefined) rev = arg;
    else throw new AxiError(`Unexpected argument: ${arg}`, 'VALIDATION_ERROR', ['head takes at most one <commit>']);
  }

  const repo = await ctx.repo();
  let info;
  try {
    info = await repo.readCommit(rev);
  } catch (error) {
    throw translateError(error);
  }
  const blocks: string[] = [];
  if (info === null) {
    blocks.push(renderObject({ branch: repo.branch !== null ? `refs/heads/${repo.branch}` : 'HEAD', commit: null }));
    blocks.push(renderHelp(['The branch is unborn (no commits yet); `gitsheets-axi commit --allow-empty --message …` starts it']));
  } else {
    blocks.push(
      renderObject({
        branch: info.branch,
        commit: info.hash,
        tree: info.tree,
        author: `${info.author.name} <${info.author.email}> ${info.author.date}`,
        subject: info.subject,
        ...(info.body !== '' ? { body: info.body } : {}),
      }),
    );
    blocks.push(renderObject({ parents: [...info.parents] }));
    if (info.trailers.length > 0) {
      blocks.push(renderList('trailers', info.trailers as unknown as Array<Record<string, unknown>>, [field('key'), field('value')]));
    }
  }
  if (jsonOut !== undefined) {
    const path =
      jsonOut === true
        ? join(tmpdir(), 'gitsheets-axi', `head-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`)
        : jsonOut;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
    blocks.push(renderObject({ wrote: path }));
  }
  return joinBlocks(...blocks);
}
