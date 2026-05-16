// CLI entry. See specs/api/cli.md.

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
import {
  csvHeader,
  inferInputFormat,
  parseRecords,
  stringifyRecord_text,
  validateInputFormat,
  validateOutputFormat,
  type InputFormat,
  type OutputFormat,
} from './formats.js';

interface GlobalArgs {
  gitDir?: string;
  root?: string;
  prefix?: string;
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
  format?: string;
  encoding?: string;
  deleteMissing?: boolean;
}

interface QueryArgs extends GlobalArgs {
  sheet: string;
  filter?: Record<string, string>;
  fields?: string[];
  limit?: number;
  format?: string;
  headers?: boolean;
}

interface ReadArgs extends GlobalArgs {
  sheet: string;
  path: string;
  format?: string;
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

async function readInput(input: string | undefined, encoding: BufferEncoding): Promise<string> {
  if (input === undefined || input === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    }
    return Buffer.concat(chunks).toString(encoding);
  }
  // Treat anything starting with `{` or `[` as inline JSON, otherwise a path.
  const trimmed = input.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return input;
  return readFile(input, encoding);
}

const VALID_ENCODINGS: ReadonlySet<BufferEncoding> = new Set([
  'utf8',
  'utf-8',
  'utf16le',
  'utf-16le',
  'ascii',
  'latin1',
  'binary',
  'base64',
  'hex',
]);

function resolveEncoding(raw: string | undefined): BufferEncoding {
  const enc = (raw ?? 'utf8').toLowerCase() as BufferEncoding;
  if (!VALID_ENCODINGS.has(enc)) {
    throw new Error(`--encoding "${raw}" is not a recognized encoding`);
  }
  return enc;
}

async function loadRepoAndSheet(
  argv: GlobalArgs & { sheet: string },
): Promise<{ repo: Awaited<ReturnType<typeof openRepo>>; sheet: Sheet }> {
  const repo = await openRepo(argv.gitDir ? { gitDir: argv.gitDir } : {});
  const sheetOpts: { root?: string; prefix?: string } = {};
  if (argv.root) sheetOpts.root = argv.root;
  if (argv.prefix) sheetOpts.prefix = argv.prefix;
  const sheet = await repo.openSheet(argv.sheet, sheetOpts);
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
  void sheet; // loadRepoAndSheet validates the config exists
  const encoding = resolveEncoding(argv.encoding);
  const explicitFormat = validateInputFormat(argv.format);
  const format: InputFormat = explicitFormat ?? inferInputFormat(argv.input);
  const text = await readInput(argv.input, encoding);
  const records = parseRecords(text, format);
  if (records.length === 0) return;

  const messageDefault = argv.deleteMissing
    ? `${argv.sheet} full-replace (${records.length})`
    : `${argv.sheet} upsert (${records.length})`;
  const txOpts = buildTxOpts(argv, messageDefault);

  const txSheetOpts: { prefix?: string } = argv.prefix ? { prefix: argv.prefix } : {};

  // For --delete-missing, capture the existing record paths BEFORE the
  // transaction opens, so we can compute the "missing" set after all upserts.
  // Reading from the same Sheet handle the loadRepoAndSheet returned gives us
  // a HEAD snapshot, not the in-flight tx state — exactly what we want.
  const existingPaths = new Set<string>();
  if (argv.deleteMissing) {
    for await (const r of sheet.query()) {
      const p = (r as Record<symbol, unknown>)[Symbol.for('gitsheets-path')];
      if (typeof p === 'string') existingPaths.add(p);
    }
  }

  await repo.transact(txOpts, async (tx) => {
    const target = tx.sheet(argv.sheet, txSheetOpts);
    const upsertedPaths = new Set<string>();
    for (const record of records) {
      const result: UpsertResult = await target.upsert(record);
      upsertedPaths.add(result.path);
      process.stdout.write(`${result.blob.hash} ${result.path}\n`);
    }
    if (argv.deleteMissing) {
      // Anything in the existing set that's not in the upserted set must die.
      for (const p of existingPaths) {
        if (!upsertedPaths.has(p)) {
          await target.delete(p);
          process.stdout.write(`- ${p}\n`);
        }
      }
    }
  });
}

async function runQuery(argv: QueryArgs): Promise<void> {
  const { sheet } = await loadRepoAndSheet(argv);
  const filter = (argv.filter as RecordLike | undefined) ?? {};
  const format: OutputFormat = validateOutputFormat(argv.format) ?? 'json';
  const headers = argv.headers ?? true;
  const fields = argv.fields;

  let yielded = 0;
  let headerWritten = false;
  const allRecords: RecordLike[] = []; // only used for TOML output

  for await (const record of sheet.query(filter)) {
    if (format === 'csv' || format === 'tsv') {
      if (!headerWritten) {
        // Header columns come from --fields, otherwise from the first record.
        const cols = fields ?? Object.keys(record).filter((k) => !k.startsWith('__'));
        if (headers) process.stdout.write(csvHeader(cols, format));
        headerWritten = true;
      }
      process.stdout.write(stringifyRecord_text(record, format, fields));
    } else if (format === 'toml') {
      // TOML needs all records to assemble [[records]] — buffer.
      allRecords.push(record);
    } else {
      // json (default) — stream NDJSON
      process.stdout.write(stringifyRecord_text(record, 'json', fields));
    }

    yielded++;
    if (argv.limit !== undefined && yielded >= argv.limit) break;
  }

  if (format === 'toml') {
    // Emit a single TOML document with a [[records]] array. The wrapper keeps
    // the output round-trippable through `parseRecords(text, 'toml')`.
    for (const r of allRecords) {
      process.stdout.write('[[records]]\n');
      process.stdout.write(stringifyRecord_text(r, 'toml', fields));
    }
  }
}

async function runRead(argv: ReadArgs): Promise<void> {
  const { sheet } = await loadRepoAndSheet(argv);
  const format: OutputFormat = validateOutputFormat(argv.format) ?? 'json';
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
  if (format === 'json') {
    // Pretty-print for human reads — JSON.stringify(_, null, 2) matches v1.0 behavior
    const cleaned = { ...found };
    delete (cleaned as Record<symbol, unknown>)[Symbol.for('gitsheets-path')];
    delete (cleaned as Record<symbol, unknown>)[Symbol.for('gitsheets-sheet')];
    process.stdout.write(`${JSON.stringify(cleaned, null, 2)}\n`);
    return;
  }
  process.stdout.write(stringifyRecord_text(found, format));
}

async function runNormalize(argv: NormalizeArgs): Promise<void> {
  const { repo, sheet } = await loadRepoAndSheet(argv);
  const records: RecordLike[] = [];
  for await (const r of sheet.query()) {
    records.push(r);
  }
  if (records.length === 0) return;
  const txOpts = buildTxOpts(argv, `${argv.sheet} normalize`);
  const txSheetOpts: { prefix?: string } = argv.prefix ? { prefix: argv.prefix } : {};
  await repo.transact(txOpts, async (tx) => {
    const target = tx.sheet(argv.sheet, txSheetOpts);
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
      describe: 'Path to a .git directory; default: $GIT_DIR or discovered from cwd',
      default: process.env['GIT_DIR'],
    })
    .option('root', { type: 'string', describe: 'Sub-directory under the data tree; default "/"' })
    .option('prefix', {
      type: 'string',
      describe:
        'Sub-prefix under each sheet\'s config root — scopes records to a sub-tree (multi-tenant)',
    })
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
          .option('format', {
            type: 'string',
            choices: ['json', 'toml', 'csv'] as const,
            describe: 'Input format; default: inferred from extension, falls back to json',
          })
          .option('encoding', {
            type: 'string',
            describe: 'Encoding for file/stdin input (default: utf8)',
          })
          .option('delete-missing', {
            type: 'boolean',
            default: false,
            describe:
              'DESTRUCTIVE: delete every record not present in the input set, in the same transaction',
          }),
      runUpsert,
    )
    .command<QueryArgs>(
      'query <sheet>',
      'Read records (output: JSON by default; --format=csv|tsv|toml supported)',
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
          .option('limit', { type: 'number' })
          .option('format', {
            type: 'string',
            choices: ['json', 'toml', 'csv', 'tsv'] as const,
            describe: 'Output format (default: json)',
          })
          .option('headers', {
            type: 'boolean',
            default: true,
            describe: 'Emit a header row for CSV/TSV output (default: true)',
          }),
      runQuery,
    )
    .command<ReadArgs>(
      'read <sheet> <path>',
      'Read a single record by its rendered path',
      (y) =>
        y
          .positional('sheet', { type: 'string', demandOption: true })
          .positional('path', { type: 'string', demandOption: true })
          .option('format', {
            type: 'string',
            choices: ['json', 'toml', 'csv', 'tsv'] as const,
            describe: 'Output format (default: pretty json)',
          }),
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
