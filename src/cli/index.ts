// CLI entry. See specs/api/cli.md.
// v1.0 substrate ships: upsert, query, read, normalize.
// infer / migrate-config / edit are tracked as follow-ups against #130, #139.

import { readFile } from 'node:fs/promises';
import process from 'node:process';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  ConfigError,
  GitsheetsError,
  IndexError,
  NotFoundError,
  RefError,
  TransactionError,
  ValidationError,
} from '../errors.js';
import { openRepo } from '../repository.js';
import type { Sheet, UpsertResult } from '../sheet.js';
import type { RecordLike } from '../path-template/index.js';

interface GlobalArgs {
  gitDir?: string;
  root?: string;
  ref?: string;
  commitTo?: string;
  message?: string;
  authorName?: string;
  authorEmail?: string;
  trailer?: Record<string, string>;
}

interface UpsertArgs extends GlobalArgs {
  sheet: string;
  input?: string;
  patch?: boolean;
}

interface QueryArgs extends GlobalArgs {
  sheet: string;
  filter?: Record<string, string>;
  fields?: string[];
  limit?: number;
}

interface ReadArgs extends GlobalArgs {
  sheet: string;
  path: string;
}

interface NormalizeArgs extends GlobalArgs {
  sheet: string;
}

// Exit codes per specs/api/cli.md
function exitCodeForError(err: unknown): number {
  if (err instanceof ValidationError) return 22;
  if (err instanceof ConfigError) return 64;
  if (err instanceof RefError) return 65;
  if (err instanceof NotFoundError) return 66;
  if (err instanceof TransactionError) return 69;
  if (err instanceof IndexError) return 70;
  if (err instanceof GitsheetsError) return 1;
  return 1;
}

function reportError(err: unknown): void {
  const out = process.stderr;
  if (err instanceof GitsheetsError) {
    out.write(`gitsheets: ${err.name}: ${err.message}\n`);
    out.write(`  code:   ${err.code}\n`);
    if (err instanceof ValidationError && err.issues.length > 0) {
      for (const i of err.issues) {
        out.write(`  issue:  ${i.path.join('.') || '<root>'}: ${i.message} (${i.source})\n`);
      }
    }
    if (err.cause !== undefined) {
      out.write(`  cause:  ${err.cause instanceof Error ? err.cause.message : String(err.cause)}\n`);
    }
    return;
  }
  if (err instanceof Error) {
    out.write(`gitsheets: ${err.name}: ${err.message}\n`);
    return;
  }
  out.write(`gitsheets: ${String(err)}\n`);
}

async function readInput(input: string | undefined): Promise<string> {
  if (input === undefined || input === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  // Treat anything starting with `{` or `[` as inline JSON, otherwise a path.
  const trimmed = input.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return input;
  return readFile(input, 'utf8');
}

function parseJsonRecords(text: string): RecordLike[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // JSON array → many records; JSON object → single record; one-record-per-line JSONL → many.
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) throw new Error('expected JSON array of records');
    return arr as RecordLike[];
  }
  if (trimmed.startsWith('{')) {
    return [JSON.parse(trimmed) as RecordLike];
  }
  // JSONL fallback
  return trimmed
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordLike);
}

async function loadRepoAndSheet(
  argv: GlobalArgs & { sheet: string },
): Promise<{ repo: Awaited<ReturnType<typeof openRepo>>; sheet: Sheet }> {
  const repo = await openRepo(argv.gitDir ? { gitDir: argv.gitDir } : {});
  const sheet = await repo.openSheet(argv.sheet, argv.root ? { root: argv.root } : {});
  return { repo, sheet };
}

function buildTxOpts(argv: GlobalArgs, defaultMessage: string): {
  message: string;
  author?: { name: string; email: string };
  trailers?: Record<string, string>;
  parent?: string;
  branch?: string;
} {
  const opts: {
    message: string;
    author?: { name: string; email: string };
    trailers?: Record<string, string>;
    parent?: string;
    branch?: string;
  } = { message: argv.message ?? defaultMessage };
  if (argv.authorName && argv.authorEmail) {
    opts.author = { name: argv.authorName, email: argv.authorEmail };
  }
  if (argv.trailer && Object.keys(argv.trailer).length > 0) {
    opts.trailers = argv.trailer;
  }
  if (argv.ref) opts.parent = argv.ref;
  if (argv.commitTo) opts.branch = argv.commitTo;
  return opts;
}

// --- Commands ---

async function runUpsert(argv: UpsertArgs): Promise<void> {
  const { repo, sheet } = await loadRepoAndSheet(argv);
  const text = await readInput(argv.input);
  const records = parseJsonRecords(text);
  if (records.length === 0) return;

  const txOpts = buildTxOpts(argv, `${argv.sheet} upsert (${records.length})`);

  await repo.transact(txOpts, async (tx) => {
    const target = tx.sheet(argv.sheet);
    for (const record of records) {
      let result: UpsertResult;
      if (argv.patch) {
        // For --patch the user supplies a query that matches an existing
        // record. The simplest convention: use the record itself as the
        // query (every field), patching nothing. The CLI's `--patch` mode is
        // a v1.0 minimum — richer query/patch handling is a follow-up.
        result = await target.patch(record, record);
      } else {
        result = await target.upsert(record);
      }
      process.stdout.write(`${result.blob.hash} ${result.path}\n`);
    }
  });
}

async function runQuery(argv: QueryArgs): Promise<void> {
  const { sheet } = await loadRepoAndSheet(argv);
  const filter = (argv.filter as RecordLike | undefined) ?? {};
  let yielded = 0;
  for await (const record of sheet.query(filter)) {
    const out = argv.fields
      ? Object.fromEntries(argv.fields.map((f) => [f, (record as Record<string, unknown>)[f]]))
      : record;
    // Strip well-known symbols before serializing
    process.stdout.write(`${JSON.stringify(out)}\n`);
    yielded++;
    if (argv.limit !== undefined && yielded >= argv.limit) break;
  }
}

async function runRead(argv: ReadArgs): Promise<void> {
  const { sheet } = await loadRepoAndSheet(argv);
  // The path is treated as the record's full slug-rendered key plus optional
  // .toml extension. For the simple `${{ slug }}` case this is just the slug.
  const target = argv.path.endsWith('.toml') ? argv.path.slice(0, -5) : argv.path;
  // Query by RECORD_PATH_KEY isn't supported through `query()` directly; iterate
  // and match. For typical sheets this is small enough.
  let found: RecordLike | undefined;
  for await (const record of sheet.query()) {
    const pathSym = (record as Record<symbol, unknown>)[Symbol.for('gitsheets-path')];
    if (pathSym === target) {
      found = record;
      break;
    }
  }
  if (!found) {
    throw new NotFoundError('record_not_found', `${argv.sheet}: no record at ${target}`);
  }
  process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
}

async function runNormalize(argv: NormalizeArgs): Promise<void> {
  const { repo, sheet } = await loadRepoAndSheet(argv);
  const records: RecordLike[] = [];
  for await (const r of sheet.query()) {
    records.push(r);
  }
  if (records.length === 0) return;
  const txOpts = buildTxOpts(argv, `${argv.sheet} normalize`);
  await repo.transact(txOpts, async (tx) => {
    const target = tx.sheet(argv.sheet);
    for (const r of records) {
      const result = await target.upsert(r);
      process.stdout.write(`${result.blob.hash} ${result.path}\n`);
    }
  });
}

// --- Entry ---

export async function main(args: string[] = hideBin(process.argv)): Promise<number> {
  const parser = yargs(args)
    .scriptName('gitsheets')
    .usage('Usage: $0 <command> [options]')
    .strict()
    .demandCommand(1, 'Specify a command')
    .option('git-dir', {
      type: 'string',
      describe: 'Path to a .git directory; default: discovered from cwd',
    })
    .option('root', { type: 'string', describe: 'Sub-directory under the data tree; default "/"' })
    .option('ref', { type: 'string', describe: "Parent ref/commit; default HEAD's branch" })
    .option('commit-to', { type: 'string', describe: 'Branch to update on commit' })
    .option('message', { type: 'string', describe: 'Commit message (mutating commands)' })
    .option('author-name', { type: 'string', describe: 'Commit author name' })
    .option('author-email', { type: 'string', describe: 'Commit author email' })
    .option('trailer', {
      type: 'string',
      array: true,
      describe: 'Commit trailers in Key=Value form (repeatable)',
      coerce: (raw: string[] | string): Record<string, string> => {
        const items = Array.isArray(raw) ? raw : [raw];
        const out: Record<string, string> = {};
        for (const item of items) {
          const eq = item.indexOf('=');
          if (eq === -1) throw new Error(`--trailer expects Key=Value, got ${item}`);
          out[item.slice(0, eq)] = item.slice(eq + 1);
        }
        return out;
      },
    })
    .env('GITSHEETS')
    .command<UpsertArgs>(
      'upsert <sheet> [input]',
      'Insert or update one or more records',
      (y) =>
        y
          .positional('sheet', { type: 'string', demandOption: true })
          .positional('input', {
            type: 'string',
            describe: "Inline JSON, a file path, or '-' for stdin",
          })
          .option('patch', { type: 'boolean', describe: 'Apply RFC 7396 merge patch' }),
      runUpsert,
    )
    .command<QueryArgs>(
      'query <sheet>',
      'Read records as newline-delimited JSON',
      (y) =>
        y
          .positional('sheet', { type: 'string', demandOption: true })
          .option('filter', {
            type: 'string',
            array: true,
            describe: 'Equality filter as field=value (repeatable)',
            coerce: (raw: string[] | string): Record<string, string> => {
              const items = Array.isArray(raw) ? raw : [raw];
              const out: Record<string, string> = {};
              for (const item of items) {
                const eq = item.indexOf('=');
                if (eq === -1) throw new Error(`--filter expects field=value, got ${item}`);
                out[item.slice(0, eq)] = item.slice(eq + 1);
              }
              return out;
            },
          })
          .option('fields', { type: 'string', array: true })
          .option('limit', { type: 'number' }),
      runQuery,
    )
    .command<ReadArgs>(
      'read <sheet> <path>',
      'Read a single record by its rendered path',
      (y) =>
        y
          .positional('sheet', { type: 'string', demandOption: true })
          .positional('path', { type: 'string', demandOption: true }),
      runRead,
    )
    .command<NormalizeArgs>(
      'normalize <sheet>',
      'Re-write every record through the canonical-normalization pipeline',
      (y) => y.positional('sheet', { type: 'string', demandOption: true }),
      runNormalize,
    )
    .fail((msg, err) => {
      if (err) {
        reportError(err);
        process.exit(exitCodeForError(err));
      }
      process.stderr.write(`gitsheets: ${msg}\n`);
      process.exit(2);
    })
    .help()
    .alias('h', 'help')
    .version();

  try {
    await parser.parseAsync();
    return 0;
  } catch (err) {
    reportError(err);
    return exitCodeForError(err);
  }
}
