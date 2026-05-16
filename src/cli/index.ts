// CLI entry. See specs/api/cli.md.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
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
  attachment?: Record<string, string>;
  patch?: boolean;
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

interface EditArgs extends GlobalArgs {
  sheet: string;
  path: string;
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

  const attachmentMap = argv.attachment ?? {};
  const attachmentNames = Object.keys(attachmentMap);
  if (attachmentNames.length > 0 && records.length !== 1) {
    throw new Error(
      `--attachment requires a single-record input (got ${records.length} records)`,
    );
  }

  // Resolve attachment source paths up front so a missing file fails before
  // the transaction opens. We hand them to hologit's writeBlobFromFile so
  // binary content is hashed correctly (git hash-object -w). For `-` (stdin),
  // we buffer it to a tmp file first since stdin may already be consumed by
  // the record input.
  const attachmentSources: Record<string, string> = {}; // name → absolute path
  const tmpDirs: string[] = []; // cleanup at end
  let stdinConsumed = argv.input === '-' || argv.input === undefined;
  const inputDir = argv.input && argv.input !== '-' ? dirname(argv.input) : process.cwd();
  for (const name of attachmentNames) {
    const source = attachmentMap[name]!;
    if (source === '-') {
      if (stdinConsumed) {
        throw new Error(
          `--attachment ${name}=-: stdin is already consumed; only one '-' source per command`,
        );
      }
      stdinConsumed = true;
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
      }
      const dir = await mkdtemp(join(tmpdir(), 'gitsheets-attach-'));
      tmpDirs.push(dir);
      const tmpPath = join(dir, 'data');
      await writeFile(tmpPath, Buffer.concat(chunks));
      attachmentSources[name] = tmpPath;
    } else {
      const resolved = isAbsolute(source) ? source : join(inputDir, source);
      attachmentSources[name] = resolved;
    }
  }

  if (argv.patch && argv.deleteMissing) {
    throw new Error('--patch and --delete-missing cannot be combined');
  }
  if (argv.patch && attachmentNames.length > 0) {
    throw new Error('--patch and --attachment cannot be combined');
  }

  // For --patch: pre-load the sheet's path-template so we know which input
  // fields form the query (record-identifier) and which are the patch payload.
  let templateKeyFields: ReadonlySet<string> | undefined;
  if (argv.patch) {
    const config = await sheet.readConfig();
    const tpl = (await import('../path-template/index.js')).Template.fromString(config.path);
    templateKeyFields = new Set(tpl.getFieldNames());
    if (templateKeyFields.size === 0) {
      throw new Error(
        '--patch: cannot auto-derive a query — sheet path template has no extractable field names',
      );
    }
  }

  const messageDefault = argv.patch
    ? `${argv.sheet} patch (${records.length})`
    : argv.deleteMissing
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
    let lastResult: UpsertResult | undefined;
    for (const record of records) {
      if (argv.patch && templateKeyFields) {
        // Split the input into (query, partial) using the template's field
        // names: keys present in the template AND in the record form the
        // query; the rest is the JSON Merge Patch payload.
        const query: RecordLike = {};
        const partial: RecordLike = {};
        for (const [k, v] of Object.entries(record)) {
          if (templateKeyFields.has(k)) {
            query[k] = v;
          } else {
            partial[k] = v;
          }
        }
        if (Object.keys(query).length === 0) {
          throw new Error(
            `--patch: input record does not include any of the path-template fields (${[...templateKeyFields].join(', ')})`,
          );
        }
        const result: UpsertResult = await target.patch(query, partial as Partial<typeof record>);
        upsertedPaths.add(result.path);
        process.stdout.write(`${result.blob.hash} ${result.path}\n`);
        lastResult = result;
        continue;
      }
      const result: UpsertResult = await target.upsert(record);
      upsertedPaths.add(result.path);
      process.stdout.write(`${result.blob.hash} ${result.path}\n`);
      lastResult = result;
    }
    // Attach files alongside the (single) record. Already guarded above to
    // run only when records.length === 1. Each source goes through
    // hologit's writeBlobFromFile (git hash-object -w <path>) so binary
    // content is hashed verbatim.
    if (attachmentNames.length > 0 && lastResult) {
      const blobMap: Record<string, import('hologit').BlobObject> = {};
      for (const [name, sourcePath] of Object.entries(attachmentSources)) {
        blobMap[name] = await repo.hologitRepo.writeBlobFromFile(sourcePath);
      }
      await target.setAttachments(lastResult.path, blobMap);
      for (const name of attachmentNames) {
        process.stdout.write(`+ ${lastResult.path}/${name}\n`);
      }
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

  // Clean up tmp dirs used to materialize stdin-sourced attachments.
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
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

async function runEdit(argv: EditArgs): Promise<void> {
  const { repo, sheet } = await loadRepoAndSheet(argv);
  const target = argv.path.endsWith('.toml') ? argv.path.slice(0, -5) : argv.path;

  // Resolve the record by walking query() and matching the rendered path.
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

  // Drop symbols before serializing; they're not part of the record's data.
  const cleaned: RecordLike = { ...found };
  delete (cleaned as Record<symbol, unknown>)[Symbol.for('gitsheets-path')];
  delete (cleaned as Record<symbol, unknown>)[Symbol.for('gitsheets-sheet')];
  const { stringifyRecord } = await import('../toml.js');
  const originalToml = stringifyRecord(cleaned);

  const tmpDir = await mkdtemp(join(tmpdir(), 'gitsheets-edit-'));
  const tmpFile = join(tmpDir, `${argv.sheet}-${target.replace(/\//g, '-')}.toml`);
  try {
    await writeFile(tmpFile, originalToml, 'utf8');

    const editor = process.env['VISUAL'] || process.env['EDITOR'] || 'vi';
    const shell = process.platform === 'win32' ? 'cmd' : 'sh';
    const shellArgs = process.platform === 'win32'
      ? ['/c', `${editor} "${tmpFile}"`]
      : ['-c', `${editor} "${tmpFile}"`];

    // Spawn with inherited stdio so the editor takes the terminal.
    const { spawn } = await import('node:child_process');
    const exit = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(shell, shellArgs, { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code));
    });
    if (exit !== 0) {
      throw new Error(`editor exited with code ${exit ?? 'null'} — aborting`);
    }

    const editedToml = await readFile(tmpFile, 'utf8');
    if (editedToml === originalToml) {
      // No-op; don't commit. Matches the "no commit on no change" idiom.
      process.stderr.write('gitsheets: no changes — nothing to commit\n');
      return;
    }

    const { parseToml } = await import('../toml.js');
    const edited = parseToml(editedToml);

    const txOpts = buildTxOpts(argv, `${argv.sheet} edit ${target}`);
    const txSheetOpts: { prefix?: string } = argv.prefix ? { prefix: argv.prefix } : {};
    await repo.transact(txOpts, async (tx) => {
      const sheetTx = tx.sheet(argv.sheet, txSheetOpts);
      // Carry the original path annotation so upsert detects renames if the
      // user changed a path-template field.
      (edited as Record<symbol, unknown>)[Symbol.for('gitsheets-path')] = target;
      const result: UpsertResult = await sheetTx.upsert(edited);
      process.stdout.write(`${result.blob.hash} ${result.path}\n`);
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
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
          })
          .option('patch', {
            type: 'boolean',
            default: false,
            describe:
              'Treat each input record as an RFC 7396 merge-patch: fields matching the sheet path template become the query; the rest are merged into the matched record. Cannot be combined with --delete-missing or --attachment.',
          })
          .option('attachment', {
            type: 'string',
            array: true,
            describe:
              "Attach a file alongside the record: --attachment <name>=<source>. <source> is a file path (relative to the input file's dir, else cwd) or '-' for stdin. Repeatable. Requires a single-record input.",
            coerce: (raw: string[] | string): Record<string, string> => {
              const items = Array.isArray(raw) ? raw : [raw];
              const out: Record<string, string> = {};
              for (const item of items) {
                const eq = item.indexOf('=');
                if (eq === -1) {
                  throw new Error(`--attachment expects <name>=<source>, got ${item}`);
                }
                out[item.slice(0, eq)] = item.slice(eq + 1);
              }
              return out;
            },
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
    .command<EditArgs>(
      'edit <sheet> <path>',
      "Open a record in $EDITOR (TOML form); on save, validate and upsert in a transaction",
      (y) =>
        y
          .positional('sheet', { type: 'string', demandOption: true })
          .positional('path', { type: 'string', demandOption: true }),
      runEdit,
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
