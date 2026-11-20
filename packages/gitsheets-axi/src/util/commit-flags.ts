import { AxiError } from 'axi-sdk-js';
import type { Repository, TransactionOptions } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { joinBlocks, renderObject } from '../output/render.js';

/**
 * The commit-shape flags every committing command takes
 * (specs/api/axi.md "Commit-shape flags"): `--trailer`, `--also-parent`,
 * `--replace`, and on `commit` only `--allow-empty`. Per-call options: flags
 * only, never an environment variable or git config.
 */
export interface CommitShape {
  trailers: Record<string, string>;
  alsoParents: string[];
  replace: string | undefined;
  allowEmpty: boolean;
}

/** A trailer flag value: `Key: value` or `Key=value`, split at the first `:` or `=`. */
export function parseTrailer(item: string): [string, string] {
  const colon = item.indexOf(':');
  const eq = item.indexOf('=');
  const at = colon === -1 ? eq : eq === -1 ? colon : Math.min(colon, eq);
  if (at <= 0) {
    throw new AxiError(`--trailer expects 'Key: value' or Key=value, got ${JSON.stringify(item)}`, 'TRAILER_INVALID', [
      "Example: --trailer 'Cycle-Id: 42'",
    ]);
  }
  const key = item.slice(0, at);
  let value = item.slice(at + 1);
  if (item[at] === ':') value = value.replace(/^\s+/, '');
  if (!/^[A-Z][a-z0-9]*(-[A-Z][a-z0-9]*)*$/.test(key)) {
    throw new AxiError(`--trailer key ${JSON.stringify(key)} is not HTTP-header style`, 'TRAILER_INVALID', [
      'Keys look like Action, Subject-Id, Cycle-Id: capitalized, hyphenated',
    ]);
  }
  return [key, value];
}

/**
 * Pull the commit-shape flags out of `args` (anywhere, as `--flag value` or
 * `--flag=value`) and return the rest for the command's own parser, which
 * still refuses anything it does not know.
 */
export function takeCommitFlags(
  args: readonly string[],
  opts: { allowEmpty: boolean },
): { rest: string[]; shape: CommitShape } {
  const shape: CommitShape = { trailers: {}, alsoParents: [], replace: undefined, allowEmpty: false };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    if (name === '--allow-empty' && opts.allowEmpty) {
      if (eq !== -1) throw new AxiError('--allow-empty takes no value', 'VALIDATION_ERROR');
      shape.allowEmpty = true;
      continue;
    }
    if (name !== '--trailer' && name !== '--also-parent' && name !== '--replace') {
      rest.push(arg);
      continue;
    }
    let value: string | undefined;
    if (eq !== -1 && arg.startsWith('--')) {
      value = arg.slice(eq + 1);
    } else {
      value = args[i + 1];
      i++;
    }
    if (value === undefined || value === '') {
      if (name === '--trailer') throw new AxiError('--trailer expects a value', 'TRAILER_INVALID');
      throw new AxiError(`${name} expects a commit`, 'VALIDATION_ERROR');
    }
    if (name === '--trailer') {
      const [key, v] = parseTrailer(value);
      if (Object.hasOwn(shape.trailers, key)) {
        throw new AxiError(`--trailer ${key} given twice`, 'TRAILER_INVALID', [
          'Each trailer key may appear once per command',
        ]);
      }
      shape.trailers[key] = v;
    } else if (name === '--also-parent') {
      shape.alsoParents.push(value);
    } else {
      if (shape.replace !== undefined) throw new AxiError('--replace given twice', 'VALIDATION_ERROR');
      shape.replace = value;
    }
  }
  return { rest, shape };
}

/** The `repo.transact` options a shape adds. */
export function shapeOptions(shape: CommitShape): Partial<TransactionOptions> {
  const out: { trailers?: Record<string, string>; alsoParents?: string[]; replace?: string; allowEmpty?: boolean } = {};
  if (Object.keys(shape.trailers).length > 0) out.trailers = shape.trailers;
  if (shape.alsoParents.length > 0) out.alsoParents = shape.alsoParents;
  if (shape.replace !== undefined) out.replace = shape.replace;
  if (shape.allowEmpty) out.allowEmpty = true;
  return out;
}

type CommandFn = (args: string[], ctx: GitsheetsContext) => Promise<string | Record<string, unknown>>;

/**
 * Wrap a committing command: take the commit-shape flags, and give the command
 * a repository whose `transact` carries them. A replacement adds
 * `replaced: <old tip>` to the output. A command whose own preflight finds
 * nothing to change still makes no commit (the shape rides on a commit; it
 * does not cause one — `commit` is the command for that).
 */
export function withCommitShape(fn: CommandFn): CommandFn {
  return async (args, ctx) => {
    if (args.includes('--help')) return fn(args, ctx);
    const { rest, shape } = takeCommitFlags(args, { allowEmpty: false });
    const extra = shapeOptions(shape);
    if (Object.keys(extra).length === 0) return fn(rest, ctx);
    let replaced: string | null = null;
    const shaped: GitsheetsContext = {
      ...ctx,
      async repo() {
        return shapeRepo(await ctx.repo(), extra, (r) => {
          replaced = r;
        });
      },
      async tryRepo() {
        const repo = await ctx.tryRepo();
        return repo === null ? null : shapeRepo(repo, extra, (r) => (replaced = r));
      },
    };
    const out = await fn(rest, shaped);
    if (replaced === null || typeof out !== 'string') return out;
    return joinBlocks(out, renderObject({ replaced }));
  };
}

function shapeRepo(
  repo: Repository,
  extra: Partial<TransactionOptions>,
  onReplaced: (hash: string) => void,
): Repository {
  return new Proxy(repo, {
    get(target, prop) {
      if (prop === 'transact') {
        return async (opts: TransactionOptions, handler: Parameters<Repository['transact']>[1]) => {
          const r = await target.transact({ ...opts, ...extra, trailers: { ...(opts.trailers ?? {}), ...(extra.trailers ?? {}) } }, handler);
          if (r.replacedCommitHash) onReplaced(r.replacedCommitHash);
          return r;
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
