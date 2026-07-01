// Sheet — typed handle to one declared sheet in a Repository.
// See specs/api/sheet.md and specs/concepts.md.

import { execFile, spawn } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { promisify } from 'node:util';
import type { Readable } from 'node:stream';

import { createPatch as rfc6902CreatePatch, type Operation as JsonPatchOp } from 'rfc6902';

import { addon, callCore, CoreTransaction } from './core.js';
import {
  ConfigError,
  IndexError,
  NotFoundError,
  PathTemplateError,
  RefError,
  TransactionError,
} from './errors.js';
import { mergePatch } from './patch.js';
import { Template, type RecordLike } from './path-template/index.js';
import type { Repository } from './repository.js';
import {
  EMPTY_TREE_HASH,
  makeBlobHandle,
  type BlobHandle,
} from './working-tree.js';
import { parseConfigToml } from './toml.js';
import sortKeys from 'sort-keys';
import { Transaction, transactionContext } from './transaction.js';
import {
  validateRecord,
  type JSONSchema,
  type StandardSchemaV1,
} from './validation.js';
import { getFormat, resolveFormatConfig, type Format, type FormatConfig } from './format/index.js';
import { extractFirstH1, rewriteLeadingH1 } from './format/markdown.js';

const exec = promisify(execFile);

export const RECORD_SHEET_KEY = Symbol.for('gitsheets-sheet');
export const RECORD_PATH_KEY = Symbol.for('gitsheets-path');

// --- Config types ---

export type SortRule =
  | boolean
  | readonly string[]
  | Readonly<Record<string, 'ASC' | 'DESC'>>
  | string;

export interface SheetFieldConfig {
  /** Optional sort rule for array-valued fields (canonical normalization). */
  readonly sort?: SortRule;
}

export interface SheetConfig {
  readonly root: string;
  readonly path: string;
  readonly fields: Readonly<Record<string, SheetFieldConfig>>;
  /** JSON Schema for record validation; null if no [gitsheet.schema] block. */
  readonly schema: JSONSchema | null;
  /** Storage-format config from `[gitsheet.format]` (default: `type = 'toml'`). */
  readonly format: FormatConfig;
}

// --- Result types ---

export interface UpsertResult {
  readonly blob: BlobHandle;
  readonly path: string;
}

/**
 * Result of `Sheet.willChange` — the pre-flight idempotency check for upsert.
 *
 * `changed` is `false` when the canonical bytes for the supplied record
 * match the current blob byte-for-byte. Consumers use this to skip
 * commits that would produce empty diffs.
 */
export interface WillChangeResult {
  /** Would `upsert(record)` write different bytes than what's already at `path`? */
  readonly changed: boolean;
  /** Sheet-relative path the record renders to (per the path template). */
  readonly path: string;
  /** Hash of the existing blob at `path`. `undefined` when the record doesn't exist on disk yet. */
  readonly currentBlobHash?: string;
  /** Serialized bytes (UTF-8 text) that `upsert` would write. */
  readonly nextText: string;
}

/**
 * Options for `Sheet.upsert`. For content-typed (markdown) sheets only:
 * `allowMissingBody: true` permits an upsert whose record omits the body
 * field. Default `false` because upsert is a full-record replace — silently
 * erasing an on-disk body is rarely the intent. Consumers wanting a body-
 * preserving update should use `Sheet.patch(query, partial)` (which always
 * full-loads the existing record before merging).
 */
export interface UpsertOptions {
  readonly allowMissingBody?: boolean;
}

// --- Helpers ---

function joinTreePath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter((p) => p.length > 0 && p !== '.')
    .join('/');
}

function buildSorter(rule: SortRule): (a: unknown, b: unknown) => number {
  if (rule === true) {
    return (a, b) =>
      String(a).localeCompare(String(b), undefined, {
        sensitivity: 'base',
        ignorePunctuation: true,
        numeric: true,
      });
  }
  if (rule === false) {
    return () => 0;
  }
  if (typeof rule === 'string') {
    return runInNewContext(`(a, b) => { ${rule} }`) as (a: unknown, b: unknown) => number;
  }
  // Array of field names → ASC for each
  let directives: Array<[string, 'ASC' | 'DESC']>;
  if (Array.isArray(rule)) {
    directives = rule.map((f) => [f, 'ASC' as const]);
  } else {
    directives = Object.entries(rule) as Array<[string, 'ASC' | 'DESC']>;
  }
  const exprLines: string[] = [];
  for (const [field, dir] of directives) {
    const sign = dir === 'ASC' ? 1 : -1;
    exprLines.push(
      `if ((a[${JSON.stringify(field)}]) < (b[${JSON.stringify(field)}])) return ${-1 * sign};`,
      `if ((a[${JSON.stringify(field)}]) > (b[${JSON.stringify(field)}])) return ${1 * sign};`,
    );
  }
  exprLines.push('return 0;');
  return runInNewContext(`(a, b) => { ${exprLines.join('\n')} }`) as (
    a: unknown,
    b: unknown,
  ) => number;
}

/**
 * Throw the signal's reason. In modern Node `AbortController.abort(reason)`
 * sets `signal.reason` to whatever was passed (defaulting to a DOMException
 * with name 'AbortError'). The fallback is defensive — should never fire on
 * the Node versions gitsheets supports.
 */
function throwAborted(signal: AbortSignal): never {
  throw (signal.reason ?? new DOMException('Aborted', 'AbortError')) as Error;
}

function queryMatches(filter: RecordLike, record: RecordLike): boolean {
  for (const [key, qval] of Object.entries(filter)) {
    const rval = record[key];
    if (typeof qval === 'function') {
      const ok = (qval as (recordValue: unknown, record: RecordLike) => unknown)(rval, record);
      if (!ok) return false;
      continue;
    }
    if (qval instanceof Date) {
      // Datetime equality by value (the core compares datetimes by value, not
      // by object identity). See specs/behaviors/normalization.md + the cutover.
      if (!(rval instanceof Date) || rval.getTime() !== qval.getTime()) return false;
      continue;
    }
    if (qval !== null && typeof qval === 'object' && !Array.isArray(qval)) {
      if (rval === null || typeof rval !== 'object') return false;
      if (!queryMatches(qval as RecordLike, rval as RecordLike)) return false;
      continue;
    }
    if (rval !== qval) return false;
  }
  return true;
}

/**
 * Deep copy of a query filter with every function-valued predicate removed —
 * the literal/nested-equality skeleton the core's `recordQuery` /
 * `recordQueryCandidates` can apply (functions can't cross the FFI). The full
 * filter (functions included) is re-applied host-side by {@link queryMatches}.
 */
function stripFilterFunctions(filter: RecordLike): RecordLike {
  const out: RecordLike = {};
  for (const [k, v] of Object.entries(filter)) {
    if (typeof v === 'function') continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      out[k] = stripFilterFunctions(v as RecordLike);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Read a blob's UTF-8 text by `<treeRef>:<path>` via `git cat-file` — the
 * genuine git-porcelain blob read for the format-aware (markdown) query path,
 * where the core's TOML-only ref reads can't parse the record. Returns `null`
 * when the object doesn't exist.
 */
function readTreeBlobText(gitDir: string, treeRef: string, path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['cat-file', 'blob', `${treeRef}:${path}`],
      { cwd: gitDir, maxBuffer: 1024 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout));
      },
    );
    child.stdin?.end();
  });
}

/** Resolve `<rev>` to its object hash via `git rev-parse`; `null` when absent. */
async function revParseObject(gitDir: string, rev: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--verify', '--quiet', rev], { cwd: gitDir });
    const hash = stdout.trim();
    return hash || null;
  } catch {
    return null;
  }
}

/**
 * The immediate blob children (`name → { hash, mode }`) of a tree path via
 * `git ls-tree` — the non-transactional attachment read. Returns `null` when
 * the path is not a tree (no attachment directory).
 */
async function lsTreeBlobs(
  gitDir: string,
  treeRef: string,
  dirPath: string,
): Promise<Record<string, { hash: string; mode: string }> | null> {
  let stdout: string;
  try {
    // -z NUL-terminates entries; each line: "<mode> <type> <hash>\t<name>".
    const res = await exec('git', ['ls-tree', '-z', `${treeRef}:${dirPath}`], {
      cwd: gitDir,
      maxBuffer: 64 * 1024 * 1024,
    });
    stdout = res.stdout;
  } catch {
    return null; // not a tree / missing
  }
  const out: Record<string, { hash: string; mode: string }> = {};
  for (const entry of stdout.split('\0')) {
    if (!entry) continue;
    const tabIdx = entry.indexOf('\t');
    if (tabIdx < 0) continue;
    const meta = entry.slice(0, tabIdx).split(/\s+/);
    const name = entry.slice(tabIdx + 1);
    const [mode, type, hash] = meta;
    if (type !== 'blob' || !hash || !mode) continue;
    out[name] = { hash, mode };
  }
  return out;
}

// --- Sheet config cache (process-wide by blob hash of the config file) ---

const CONFIG_CACHE = new Map<string, SheetConfig>();

async function loadConfig(
  gitDir: string,
  treeRef: string,
  configPath: string,
): Promise<SheetConfig> {
  const hash = await revParseObject(gitDir, `${treeRef}:${configPath}`);
  if (hash === null) {
    throw new ConfigError('config_missing', `sheet config not found at ${configPath}`);
  }
  const cached = CONFIG_CACHE.get(hash);
  if (cached) return cached;

  const tomlText = await readTreeBlobText(gitDir, treeRef, configPath);
  if (tomlText === null) {
    throw new ConfigError('config_missing', `sheet config not found at ${configPath}`);
  }
  const raw = parseConfigToml(tomlText, configPath);
  const gitsheet = raw['gitsheet'];
  if (!gitsheet || typeof gitsheet !== 'object') {
    throw new ConfigError(
      'config_invalid',
      `${configPath}: missing [gitsheet] table`,
    );
  }
  const { root = '.', path, fields } = gitsheet as RecordLike;
  if (typeof path !== 'string' || path.length === 0) {
    throw new ConfigError('config_invalid', `${configPath}: gitsheet.path must be a non-empty string`);
  }
  if (typeof root !== 'string') {
    throw new ConfigError('config_invalid', `${configPath}: gitsheet.root must be a string`);
  }
  const fieldsClean: Record<string, SheetFieldConfig> = {};
  if (fields !== undefined && fields !== null) {
    if (typeof fields !== 'object' || Array.isArray(fields)) {
      throw new ConfigError(
        'config_invalid',
        `${configPath}: gitsheet.fields must be a table`,
      );
    }
    for (const [fname, fcfg] of Object.entries(fields as RecordLike)) {
      if (typeof fcfg !== 'object' || fcfg === null) continue;
      const entry: SheetFieldConfig = {};
      const sort = (fcfg as RecordLike)['sort'];
      if (sort !== undefined) {
        validateSortRule(sort, configPath, fname);
        Object.assign(entry, { sort: sort as SortRule });
      }
      fieldsClean[fname] = entry;
    }
  }
  const schemaRaw = (gitsheet as RecordLike)['schema'];
  let schema: JSONSchema | null = null;
  if (schemaRaw !== undefined && schemaRaw !== null) {
    if (typeof schemaRaw !== 'object' || Array.isArray(schemaRaw)) {
      throw new ConfigError(
        'config_invalid',
        `${configPath}: gitsheet.schema must be a table representing a JSON Schema`,
      );
    }
    schema = schemaRaw as JSONSchema;
  }

  let format: FormatConfig;
  try {
    format = resolveFormatConfig((gitsheet as RecordLike)['format']);
  } catch (err) {
    throw new ConfigError(
      'config_invalid',
      `${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  // Body-field collision: a sheet whose path template references the body
  // field would render the same key for a record regardless of body content.
  if (format.body !== undefined) {
    if (format.type !== 'markdown' && format.type !== 'mdx') {
      throw new ConfigError(
        'config_invalid',
        `${configPath}: [gitsheet.format].body only applies to markdown/mdx formats`,
      );
    }
    // Static check: the path template's getFieldNames must not include the
    // body field. Tested against the registered field name only — expressions
    // referencing body are caught lazily during render.
    const fieldNames = Template.fromString(path).getFieldNames();
    if (fieldNames.includes(format.body)) {
      throw new ConfigError(
        'config_invalid',
        `${configPath}: [gitsheet.format].body = ${JSON.stringify(format.body)} collides with the path template — the body field cannot also identify the record`,
      );
    }
  } else if (format.type === 'markdown' || format.type === 'mdx') {
    throw new ConfigError(
      'config_invalid',
      `${configPath}: [gitsheet.format].body is required when type is "markdown" or "mdx"`,
    );
  }

  const config: SheetConfig = { root, path, fields: fieldsClean, schema, format };
  CONFIG_CACHE.set(hash, config);
  return config;
}

function validateSortRule(sort: unknown, configPath: string, field: string): void {
  if (typeof sort === 'boolean' || typeof sort === 'string') return;
  if (Array.isArray(sort)) {
    for (const f of sort) {
      if (typeof f !== 'string') {
        throw new ConfigError(
          'config_invalid',
          `${configPath}: gitsheet.fields.${field}.sort[] must be string field names`,
        );
      }
    }
    return;
  }
  if (sort !== null && typeof sort === 'object') {
    for (const [k, v] of Object.entries(sort as RecordLike)) {
      if (v !== 'ASC' && v !== 'DESC') {
        throw new ConfigError(
          'config_invalid',
          `${configPath}: gitsheet.fields.${field}.sort.${k} must be 'ASC' or 'DESC'`,
        );
      }
    }
    return;
  }
  throw new ConfigError(
    'config_invalid',
    `${configPath}: gitsheet.fields.${field}.sort has invalid shape`,
  );
}

// --- Filter type ---

/**
 * Filter passed to `Sheet.query` / `queryFirst` / `queryAll`. Each field's
 * value can be a literal (equality match) or a predicate function. When `T`
 * is `Record<string, unknown>` (the default), arbitrary string keys are
 * accepted; consumer-supplied `T` narrows to its own keys.
 */
export type QueryFilter<T extends RecordLike = RecordLike> = {
  [K in keyof T]?: T[K] | ((value: T[K], record: T) => unknown);
};

/**
 * Options for `Sheet.query` / `queryFirst` / `queryAll`.
 *
 * @see specs/api/conventions.md#cancellation
 */
export interface QueryOptions {
  /**
   * Optional AbortSignal to cancel a running query. The query checks the
   * signal before iteration starts and again before each yield. When the
   * signal aborts, the next iteration throws `signal.reason` (a DOMException
   * with name 'AbortError' by default, or whatever value the consumer passed
   * to `controller.abort(reason)`).
   */
  readonly signal?: AbortSignal;
  /**
   * For content-typed sheets (markdown/mdx), whether to load the body field
   * into yielded records. Defaults to `true`. Setting `false` reads only the
   * frontmatter — the body field is `undefined`. Saves I/O at scale for
   * bulk metadata queries. Has no effect on TOML sheets (no body concept).
   *
   * When `withBody: false`, filters that reference the body field throw
   * `TypeError` at query start (the filter would silently match zero).
   *
   * @see specs/behaviors/content-types.md#lazy-body-loading
   */
  readonly withBody?: boolean;
}

// --- Attachments iterator (#140) ---

/**
 * Handle on an attachment's bytes, returned by `Sheet.attachments()`. Wraps
 * the raw blob hash with consumer-friendly `read()` (Buffer) and `stream()`
 * (Readable) accessors. Spawns `git cat-file blob <hash>` under the hood.
 */
export interface AttachmentBlobHandle {
  readonly hash: string;
  read(): Promise<Buffer>;
  stream(): Readable;
}

export interface AttachmentEntry {
  readonly name: string;
  readonly mimeType: string;
  readonly blob: AttachmentBlobHandle;
}

// Minimum-viable MIME map — covers the bulk of typical attachment uses
// (images, audio, video, docs). Unknown extensions get application/octet-stream.
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  // Text
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  toml: 'application/toml',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  ts: 'application/typescript',
  svg: 'image/svg+xml',
  // Images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/vnd.microsoft.icon',
  tiff: 'image/tiff',
  // Audio / video
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  // Documents / archives
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
};

function inferMimeType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return 'application/octet-stream';
  const ext = filename.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function makeAttachmentBlobHandle(gitDir: string, hash: string): AttachmentBlobHandle {
  return {
    hash,
    async read(): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        const child = execFile(
          'git',
          ['cat-file', 'blob', hash],
          { cwd: gitDir, encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
          (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout as Buffer);
          },
        );
        child.stdin?.end();
      });
    },
    stream(): Readable {
      const child = spawn('git', ['cat-file', 'blob', hash], { cwd: gitDir });
      child.stdin.end();
      return child.stdout;
    },
  };
}

// --- diffFrom (specs/api/sheet.md) ---

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** Options for `Sheet.diffFrom`. */
export interface DiffOptions {
  /** Attach BlobHandle handles for the src/dst blob hashes when set. */
  readonly blobs?: boolean;
  /** Parse src/dst TOML into records when set. */
  readonly records?: boolean;
  /** Generate an RFC 6902 JSON Patch between src and dst when set. */
  readonly patches?: boolean;
}

/**
 * One change yielded by `Sheet.diffFrom`. `srcMode`/`srcHash` are null for
 * added records; `dstMode`/`dstHash` are null for deleted records.
 *
 * The optional fields populate based on the `opts` flag passed to diffFrom:
 * - `blobs: true` → `srcBlob`/`dstBlob` (gitsheets `BlobHandle` handles)
 * - `records: true` → `src`/`dst` (parsed records)
 * - `patches: true` → `patch` (RFC 6902 array; null/empty array on no-op)
 */
export interface DiffChange<T extends RecordLike = RecordLike> {
  /** Record path relative to the sheet root, without the `.toml` suffix. */
  readonly path: string;
  readonly status: DiffStatus;
  readonly srcMode: string | null;
  readonly dstMode: string | null;
  readonly srcHash: string | null;
  readonly dstHash: string | null;
  readonly srcBlob?: BlobHandle;
  readonly dstBlob?: BlobHandle;
  readonly src?: T;
  readonly dst?: T;
  readonly patch?: readonly JsonPatchOp[];
}

interface RawDiffEntry {
  readonly status: DiffStatus;
  readonly statusChar: string;
  readonly srcMode: string | null;
  readonly dstMode: string | null;
  readonly srcHash: string | null;
  readonly dstHash: string | null;
  readonly canonicalPath: string;
}

function parseDiffTreeZ(output: string): RawDiffEntry[] {
  // `git diff-tree -z -r --no-commit-id` formats each entry as:
  //   :<srcMode> <dstMode> <srcHash> <dstHash> <statusToken>\0<srcPath>\0[<dstPath>\0]
  // The `-z` flag NUL-separates the metadata line from each path, so any
  // path with special characters in it is preserved verbatim. Status R/C
  // emits two paths; everything else emits one.
  const parts = output.split('\0');
  const out: RawDiffEntry[] = [];
  let i = 0;
  while (i < parts.length) {
    const meta = parts[i];
    if (!meta || !meta.startsWith(':')) {
      i++;
      continue;
    }
    const tokens = meta.slice(1).split(' ');
    if (tokens.length < 5) {
      i++;
      continue;
    }
    const srcMode = tokens[0]!;
    const dstMode = tokens[1]!;
    const srcHash = tokens[2]!;
    const dstHash = tokens[3]!;
    const statusToken = tokens[4]!;
    const statusChar = statusToken[0] ?? '';
    const status = mapDiffStatus(statusChar);
    if (!status) {
      i++;
      continue;
    }
    i++;
    const srcPath = parts[i++] ?? '';
    let canonicalPath = srcPath;
    if (statusChar === 'R' || statusChar === 'C') {
      const dstPath = parts[i++] ?? srcPath;
      canonicalPath = dstPath;
    }
    out.push({
      status,
      statusChar,
      srcMode: srcMode === '000000' ? null : srcMode,
      dstMode: dstMode === '000000' ? null : dstMode,
      srcHash: /^0+$/.test(srcHash) ? null : srcHash,
      dstHash: /^0+$/.test(dstHash) ? null : dstHash,
      canonicalPath,
    });
  }
  return out;
}

function mapDiffStatus(ch: string): DiffStatus | null {
  switch (ch) {
    case 'A':
      return 'added';
    case 'M':
    case 'T':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      return null;
  }
}

async function readBlobAsRecord(
  gitDir: string,
  hash: string,
  format: Format,
  formatConfig: FormatConfig,
): Promise<RecordLike | null> {
  try {
    const { stdout } = await exec('git', ['cat-file', 'blob', hash], {
      cwd: gitDir,
      maxBuffer: 64 * 1024 * 1024,
    });
    return format.parse(stdout, formatConfig);
  } catch {
    // Blob unreadable or unparsable — caller treats this as "no record".
    return null;
  }
}

function stripRecordPath(rawPath: string, root: string, extension: string): string {
  let p = rawPath;
  const cleanRoot = root.replace(/^\/+|\/+$/g, '');
  if (cleanRoot && cleanRoot !== '.' && cleanRoot !== '') {
    const prefix = `${cleanRoot}/`;
    if (p.startsWith(prefix)) p = p.slice(prefix.length);
  }
  if (p.endsWith(extension)) p = p.slice(0, -extension.length);
  return p;
}

// --- Indexing ---

export type IndexKeyFn<T extends RecordLike = RecordLike> = (
  record: T,
) => string | undefined | null;

export interface DefineIndexOptions {
  readonly unique?: boolean;
  readonly eager?: boolean;
}

interface IndexState<T extends RecordLike = RecordLike> {
  readonly name: string;
  readonly unique: boolean;
  readonly eager: boolean;
  readonly keyFn: IndexKeyFn<T>;
  built: boolean;
  treeHashAtBuild: string | null;
  uniqueMap: Map<string, T>;
  multiMap: Map<string, T[]>;
}

// --- Sheet class ---

export interface SheetConstructorOptions<T extends RecordLike = RecordLike> {
  readonly repo: Repository;
  readonly name: string;
  readonly configPath: string;
  readonly transaction?: Transaction;
  /**
   * Non-transactional snapshot: the tree hash reads (config, query, diff,
   * attachments) resolve against. Captured at open time. Absent for tx-bound
   * sheets, which read the in-progress tree through the core transaction.
   */
  readonly readRef?: string;
  /**
   * Non-transactional: the record base path relative to the repo root, sourced
   * from the `openSheet({ root })` option. Combined with `config.root`/`prefix`.
   */
  readonly dataBase?: string;
  /** Consumer-supplied Standard Schema validator; runs after JSON Schema. */
  readonly validator?: StandardSchemaV1<unknown, T>;
  /**
   * Optional sub-prefix under the sheet's `config.root`. Records read/written
   * by this Sheet live at `<config.root>/<prefix>/<rendered-path>.toml`. See
   * specs/api/cli.md and #148.
   */
  readonly prefix?: string;
}

export class Sheet<T extends RecordLike = RecordLike> {
  readonly #repo: Repository;
  readonly #name: string;
  readonly #configPath: string;
  readonly #transaction: Transaction | undefined;
  readonly #readRef: string | undefined;
  readonly #dataBase: string;
  readonly #validator: StandardSchemaV1<unknown, T> | undefined;
  readonly #prefix: string;
  readonly #indexes = new Map<string, IndexState<T>>();
  #configPromise: Promise<SheetConfig> | undefined;

  constructor(opts: SheetConstructorOptions<T>) {
    this.#repo = opts.repo;
    this.#name = opts.name;
    this.#configPath = opts.configPath;
    this.#transaction = opts.transaction;
    this.#readRef = opts.readRef;
    this.#dataBase = (opts.dataBase ?? '').replace(/^\/+|\/+$/g, '');
    this.#validator = opts.validator;
    this.#prefix = (opts.prefix ?? '').replace(/^\/+|\/+$/g, '');
  }

  /** The git dir this sheet reads/writes through. */
  get #gitDir(): string {
    return this.#repo.gitDir;
  }

  /** The tree ref config/reads resolve against (tx parent, or the open snapshot). */
  #configTreeRef(): string {
    if (this.#transaction !== undefined) {
      return this.#transaction.parentCommitHash ?? 'HEAD';
    }
    return this.#readRef ?? EMPTY_TREE_HASH;
  }

  /** Open this sheet in the bound core transaction (idempotent). Tx-bound only. */
  #ensureCoreSheetOpened(): void {
    this.#transaction!.openCoreSheet(this.#name, this.#configPath, this.#prefix);
  }

  /**
   * The effective tree path where this sheet's records live, formed by
   * joining `config.root` and the optional `prefix`. Normalized; never has
   * leading/trailing slashes.
   */
  #effectiveRoot(config: SheetConfig): string {
    const root = config.root.replace(/^\/+|\/+$/g, '');
    if (!this.#prefix) return root;
    return joinTreePath(root, this.#prefix);
  }

  /** Options to forward when delegating into a `tx.sheet(name, opts)` call. */
  #txDelegateOpts(): { prefix?: string } {
    return this.#prefix ? { prefix: this.#prefix } : {};
  }

  /** Resolve the active `Format` for this sheet's storage type. */
  #getFormat(config: SheetConfig): Format {
    return getFormat(config.format.type);
  }

  get name(): string {
    return this.#name;
  }

  get configPath(): string {
    return this.#configPath;
  }

  /** True if this Sheet is bound to a transaction's private tree. */
  get isTransactionBound(): boolean {
    return this.#transaction !== undefined;
  }

  async readConfig(): Promise<SheetConfig> {
    // A Sheet reads a single, immutable tree ref (the open snapshot, or the tx
    // parent), so its config never changes over the instance's lifetime.
    // Memoize to avoid a `git rev-parse` per call on hot write/query loops.
    if (this.#configPromise === undefined) {
      this.#configPromise = loadConfig(this.#gitDir, this.#configTreeRef(), this.#configPath);
    }
    return this.#configPromise;
  }

  /** Same as readConfig — config is cached by config-blob hash anyway. */
  async getCachedConfig(): Promise<SheetConfig> {
    return this.readConfig();
  }

  /** Async iterator over records matching the filter. */
  async *query(filter: QueryFilter<T> = {}, opts: QueryOptions = {}): AsyncGenerator<T> {
    if (typeof filter === 'function') {
      throw new TypeError('Sheet.query() does not accept a function — pass a filter object');
    }

    const { signal } = opts;
    // Aborted-before-call: throw immediately, no I/O.
    if (signal?.aborted) throwAborted(signal);

    const config = await this.readConfig();
    const format = this.#getFormat(config);
    const withBody = opts.withBody ?? true;
    const bodyField = config.format.body;
    // Guard: if the consumer asked for body-less reads but their filter
    // references the body field, we'd silently match zero records. Fail
    // loudly at query start instead.
    if (!withBody && bodyField !== undefined && bodyField in (filter as RecordLike)) {
      throw new TypeError(
        `Sheet.query: filter references body field ${JSON.stringify(bodyField)} while withBody: false — bodies aren't loaded so the filter would match nothing`,
      );
    }

    // Route the tree walk + record decode through the core. Function-valued
    // filter predicates can't cross the FFI, so they're stripped from the core
    // filter and re-applied host-side by queryMatches.
    const gitDir = this.#gitDir;
    const coreFilter = stripFilterFunctions(filter as RecordLike);

    let rows: Array<{ path: string; record: RecordLike }>;
    if (this.#transaction !== undefined) {
      // Tx-bound: read the in-progress private tree through the core (format-
      // aware). The core lists every record under the sheet base; the full
      // filter (including functions) is applied host-side below.
      this.#ensureCoreSheetOpened();
      rows = callCore(() =>
        this.#transaction!.coreTx.list(this.#name, withBody),
      ) as Array<{ path: string; record: RecordLike }>;
    } else {
      // Non-tx: resolve against the open-time snapshot ref.
      const treeRef = this.#readRef ?? EMPTY_TREE_HASH;
      const base = joinTreePath(this.#dataBase, this.#effectiveRoot(config));
      if (config.format.type === 'toml') {
        // TOML records: the core reads + parses + literal-filters in one call.
        rows = callCore(() =>
          addon.recordQuery(gitDir, treeRef, base, config.path, coreFilter, format.extension),
        ) as Array<{ path: string; record: RecordLike }>;
      } else {
        // Format-aware (markdown/mdx): the core's ref reads are TOML-only, so
        // use it only for the (format-agnostic) pruning walk, then read + decode
        // each candidate blob through the host format codec (itself core-backed).
        const candidates = callCore(() =>
          addon.recordQueryCandidates(gitDir, treeRef, base, config.path, coreFilter, format.extension),
        );
        rows = [];
        for (const p of candidates) {
          const text = await readTreeBlobText(gitDir, treeRef, joinTreePath(base, `${p}${format.extension}`));
          if (text === null) continue;
          const record = withBody
            ? format.parse(text, config.format)
            : format.parseHeaderOnly(text, config.format);
          rows.push({ path: p, record });
        }
      }
    }

    for (const { path: recordPath, record } of rows) {
      if (signal?.aborted) throwAborted(signal);
      (record as Record<symbol, unknown>)[RECORD_SHEET_KEY] = this.#name;
      (record as Record<symbol, unknown>)[RECORD_PATH_KEY] = recordPath;
      if (!queryMatches(filter as RecordLike, record as RecordLike)) continue;
      yield record as T;
    }
  }

  async queryFirst(
    filter: QueryFilter<T> = {},
    opts: QueryOptions = {},
  ): Promise<T | undefined> {
    for await (const record of this.query(filter, opts)) {
      return record;
    }
    return undefined;
  }

  async queryAll(filter: QueryFilter<T> = {}, opts: QueryOptions = {}): Promise<T[]> {
    const results: T[] = [];
    for await (const record of this.query(filter, opts)) {
      results.push(record);
    }
    return results;
  }

  /**
   * Hydrate a body-less record returned by `query`/`findByIndex` with its
   * full body. Re-reads the record blob at the path annotation symbol and
   * returns a fresh record with the body field populated.
   *
   * For TOML sheets (no body concept) this returns the input record
   * unchanged after a fresh parse. For markdown/mdx sheets the body field
   * is populated from the on-disk blob.
   *
   * @see specs/behaviors/content-types.md#lazy-body-loading
   */
  async loadBody(record: T): Promise<T> {
    const recordPath = (record as Record<symbol, unknown>)[RECORD_PATH_KEY];
    if (typeof recordPath !== 'string') {
      throw new TypeError(
        `Sheet.loadBody: record is missing the path annotation (RECORD_PATH_KEY) — did it come from query()?`,
      );
    }
    const config = await this.readConfig();
    const format = this.#getFormat(config);
    const treeRef = this.#configTreeRef();
    const fullPath = joinTreePath(
      this.#dataBase,
      this.#effectiveRoot(config),
      `${recordPath}${format.extension}`,
    );
    const text = await readTreeBlobText(this.#gitDir, treeRef, fullPath);
    if (text === null) {
      throw new NotFoundError(
        'record_not_found',
        `Sheet.loadBody: no record blob at ${fullPath}`,
      );
    }
    return (await this.#readRecordFromText(text, recordPath, config)) as T;
  }

  /**
   * Async iterator of changes between `srcCommitHash` and the current tree,
   * scoped to this sheet's root. `srcCommitHash` accepts a commit hash, a
   * tree hash, or a ref name; if omitted it defaults to the empty tree
   * (every current record yields `status: 'added'`).
   *
   * Currently scoped to `*.toml` entries — attachment-blob diffs are
   * out-of-scope for v1.1.
   *
   * See specs/api/sheet.md#diffFrom and specs/behaviors/attachments.md.
   */
  async *diffFrom(
    srcCommitHash?: string | null,
    opts: DiffOptions = {},
  ): AsyncGenerator<DiffChange<T>> {
    const config = await this.readConfig();
    // TOML sheets: the core computes the whole rename-aware diff from the
    // canonical bytes — so datetime field changes and int-vs-float distinctions
    // surface in the patch (they're lost once a record is parsed into a JS
    // object, where every number is a float and Dates compare by identity).
    // Format-aware sheets fall back to the git-porcelain tree diff, since the
    // core's ref diff parses blobs as TOML.
    if (config.format.type === 'toml') {
      yield* this.#diffFromCore(config, srcCommitHash ?? EMPTY_TREE_HASH, opts);
      return;
    }
    yield* this.#diffFromGit(config, srcCommitHash, opts);
  }

  /** TOML diff computed in the core (`diffRecords`) — rename-aware, byte-faithful. */
  async *#diffFromCore(
    config: SheetConfig,
    srcRef: string,
    opts: DiffOptions,
  ): AsyncGenerator<DiffChange<T>> {
    const gitDir = this.#gitDir;
    const format = this.#getFormat(config);
    const base = joinTreePath(this.#dataBase, this.#effectiveRoot(config));
    const dstTreeHash = this.#configTreeRef();

    const diffs = callCore(() =>
      addon.diffRecords(gitDir, srcRef, dstTreeHash, base, format.extension),
    ) as unknown as Array<{
      path: string;
      status: DiffStatus;
      previousPath: string | null;
      srcHash: string | null;
      dstHash: string | null;
      src: RecordLike | null;
      dst: RecordLike | null;
      patch: JsonPatchOp[];
    }>;

    for (const d of diffs) {
      // Config blobs live under the sheet root when root = '.'; they're not records.
      if (d.path.startsWith('.gitsheets/')) continue;
      const change: Record<string, unknown> = {
        path: d.path,
        status: d.status,
        srcMode: d.srcHash ? '100644' : null,
        dstMode: d.dstHash ? '100644' : null,
        srcHash: d.srcHash,
        dstHash: d.dstHash,
      };
      if (opts.blobs) {
        if (d.srcHash) change['srcBlob'] = makeBlobHandle(gitDir, d.srcHash, '100644');
        if (d.dstHash) change['dstBlob'] = makeBlobHandle(gitDir, d.dstHash, '100644');
      }
      if (opts.records) {
        if (d.src !== null) change['src'] = d.src;
        if (d.dst !== null) change['dst'] = d.dst;
      }
      if (opts.patches) {
        change['patch'] = d.patch;
      }
      yield change as unknown as DiffChange<T>;
    }
  }

  async *#diffFromGit(
    config: SheetConfig,
    srcCommitHash: string | null | undefined,
    opts: DiffOptions,
  ): AsyncGenerator<DiffChange<T>> {
    const gitDir = this.#gitDir;
    const srcRef = srcCommitHash ?? EMPTY_TREE_HASH;
    const dstTreeHash = this.#configTreeRef();

    const args = ['diff-tree', '-z', '-r', '-M', '--no-commit-id', srcRef, dstTreeHash];
    const effectiveRoot = joinTreePath(this.#dataBase, this.#effectiveRoot(config));
    if (effectiveRoot && effectiveRoot !== '.') {
      args.push('--', effectiveRoot);
    }

    let stdout: string;
    try {
      const result = await exec('git', args, {
        cwd: gitDir,
        maxBuffer: 64 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (err) {
      throw new RefError(
        'ref_not_found',
        `Sheet.diffFrom: git diff-tree failed for src=${srcRef} dst=${dstTreeHash}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const format = this.#getFormat(config);
    const entries = parseDiffTreeZ(stdout);
    for (const entry of entries) {
      // Scope to record files for this sheet's storage format. Attachments
      // (any extension), hidden files, and `.gitsheets/` config blobs are
      // filtered out — they're not records.
      if (!entry.canonicalPath.endsWith(format.extension)) continue;
      if (entry.canonicalPath.startsWith('.gitsheets/')) continue;

      const recordPath = stripRecordPath(
        entry.canonicalPath,
        joinTreePath(this.#dataBase, this.#effectiveRoot(config)),
        format.extension,
      );

      const change: Record<string, unknown> = {
        path: recordPath,
        status: entry.status,
        srcMode: entry.srcMode,
        dstMode: entry.dstMode,
        srcHash: entry.srcHash,
        dstHash: entry.dstHash,
      };

      if (opts.blobs) {
        if (entry.srcHash) {
          change['srcBlob'] = makeBlobHandle(gitDir, entry.srcHash, entry.srcMode ?? '100644');
        }
        if (entry.dstHash) {
          change['dstBlob'] = makeBlobHandle(gitDir, entry.dstHash, entry.dstMode ?? '100644');
        }
      }

      if (opts.records || opts.patches) {
        const src = entry.srcHash
          ? await readBlobAsRecord(gitDir, entry.srcHash, format, config.format)
          : null;
        const dst = entry.dstHash
          ? await readBlobAsRecord(gitDir, entry.dstHash, format, config.format)
          : null;
        if (opts.records) {
          if (src !== null) change['src'] = src;
          if (dst !== null) change['dst'] = dst;
        }
        if (opts.patches) {
          // rfc6902 treats undefined/null specially. For added: src is null,
          // dst is the object → patch is a single `add` op. For deleted: src
          // is the object, dst is null → patch is a single `remove` op. For
          // modified: a sequence of ops describing the diff.
          change['patch'] = rfc6902CreatePatch(src, dst);
        }
      }

      yield change as unknown as DiffChange<T>;
    }
  }

  async pathForRecord(record: T): Promise<string> {
    const config = await this.readConfig();
    return Template.fromString(config.path).render(record as RecordLike);
  }

  /**
   * Apply canonical normalization (deep key sort + array-field sort rules)
   * without writing or validating.
   */
  async normalizeRecord(record: T): Promise<T> {
    const config = await this.readConfig();
    const out: RecordLike = { ...record };
    for (const [field, fcfg] of Object.entries(config.fields)) {
      const value = out[field];
      if (fcfg.sort !== undefined && Array.isArray(value)) {
        const sorter = buildSorter(fcfg.sort);
        out[field] = [...value].sort(sorter);
      }
    }
    // Deep-sort keys per specs/api/sheet.md — the returned JS object reflects
    // canonical form even before TOML serialization.
    return sortKeys(out, { deep: true }) as T;
  }

  async clear(): Promise<void> {
    if (this.#transaction === undefined) {
      await this.#repo.transact({ message: `${this.#name} clear` }, async (tx) => {
        await tx.sheet(this.#name, this.#txDelegateOpts()).clear();
      });
      return;
    }
    this.#ensureCoreSheetOpened();
    callCore(() => this.#transaction!.coreTx.clear(this.#name));
    this.#invalidateIndexes();
  }

  async clone(): Promise<Sheet<T>> {
    // Config + data are immutable snapshots for a non-tx sheet; the clone reads
    // the same ref. (Kept for API compatibility; the tree is no longer mutable
    // host-side, so the clone shares the same read snapshot.)
    const opts: SheetConstructorOptions<T> = {
      repo: this.#repo,
      name: this.#name,
      configPath: this.#configPath,
    };
    if (this.#readRef !== undefined) Object.assign(opts, { readRef: this.#readRef });
    if (this.#dataBase) Object.assign(opts, { dataBase: this.#dataBase });
    if (this.#validator !== undefined) Object.assign(opts, { validator: this.#validator });
    if (this.#prefix) Object.assign(opts, { prefix: this.#prefix });
    return new Sheet<T>(opts);
  }

  async upsert(record: T, opts: UpsertOptions = {}): Promise<UpsertResult> {
    if (this.#transaction !== undefined) {
      return this.#upsertInTx(record, opts);
    }
    this.#checkStrictMode();

    // The tx-bound Sheet returned by tx.sheet(name) doesn't carry this
    // standalone Sheet's `validator`. Apply the Standard Schema layer here
    // so its transform is reflected in what gets written. JSON Schema also
    // runs here; the inner #upsertInTx will re-run it (cheap, idempotent).
    let validated: T = record;
    if (this.#validator !== undefined) {
      const config = await this.readConfig();
      validated = (await validateRecord({
        record: stripSymbols(record as RecordLike),
        schema: config.schema,
        schemaSourcePath: this.#configPath,
        validator: this.#validator,
      })) as T;
      // Carry the original path annotation forward for rename detection.
      const existing = (record as Record<symbol, unknown>)[RECORD_PATH_KEY];
      if (typeof existing === 'string') {
        (validated as Record<symbol, unknown>)[RECORD_PATH_KEY] = existing;
      }
    }

    const tx = transactionContext.getStore();
    if (tx !== undefined) {
      return tx.sheet<T>(this.#name, this.#txDelegateOpts()).upsert(validated, opts);
    }
    return this.#autoTransact(
      async (innerTx) =>
        innerTx.sheet<T>(this.#name, this.#txDelegateOpts()).upsert(validated, opts),
      (r) => `${this.#name} upsert ${r.path}`,
    );
  }

  /**
   * RFC 7396 JSON Merge Patch. Reads the matching record, merges `partial`,
   * validates, and upserts the result. Returns the same shape as upsert.
   * Throws NotFoundError if the query matches no record.
   */
  async patch(query: QueryFilter<T>, partial: Partial<T>): Promise<UpsertResult> {
    const existing = await this.queryFirst(query);
    if (!existing) {
      throw new NotFoundError(
        'record_not_found',
        `${this.#name}: no record matched ${JSON.stringify(query)}`,
      );
    }
    const merged = mergePatch(stripSymbols(existing as RecordLike), partial) as T;
    // Carry the record's path annotation forward so upsert's rename
    // detection deletes the old file if the new path differs.
    const existingPath = (existing as Record<symbol, unknown>)[RECORD_PATH_KEY];
    if (typeof existingPath === 'string') {
      (merged as Record<symbol, unknown>)[RECORD_PATH_KEY] = existingPath;
    }

    // Title↔body H1 reconciliation for content-typed sheets with title
    // extraction enabled. `upsert` enforces `record[title] === <body's first
    // H1>`. patch's job is to keep the invariant satisfied when the consumer
    // supplies only one side of the delta.
    //
    //   {title: 'X'} only        → rewrite body's first H1 to `# X`
    //   {body: '# Y\n...'} only  → re-derive title from new body's H1
    //   {title, body} both       → pass through; upsert validates consistency
    //   neither in partial       → invariant trivially preserved
    const config = await this.readConfig();
    const titleField = config.format.title;
    const bodyField = config.format.body;
    if (titleField !== undefined && bodyField !== undefined) {
      const partialFields = partial as Record<string, unknown>;
      const titleInPatch = titleField in partialFields;
      const bodyInPatch = bodyField in partialFields;
      const mergedAny = merged as Record<string, unknown>;

      if (titleInPatch && !bodyInPatch) {
        // Consumer set the title; rewrite the body's first H1 to match.
        const titleValue = mergedAny[titleField];
        const currentBody = typeof mergedAny[bodyField] === 'string'
          ? (mergedAny[bodyField] as string)
          : '';
        if (typeof titleValue === 'string') {
          mergedAny[bodyField] = rewriteLeadingH1(currentBody, titleValue);
        }
      } else if (bodyInPatch && !titleInPatch) {
        // Consumer set the body; re-derive the title from the new H1. If the
        // new body has no H1, the title becomes undefined (the serializer
        // will drop the frontmatter field).
        const newBody = typeof mergedAny[bodyField] === 'string'
          ? (mergedAny[bodyField] as string)
          : '';
        const derivedTitle = extractFirstH1(newBody);
        if (derivedTitle !== undefined) {
          mergedAny[titleField] = derivedTitle;
        } else {
          delete mergedAny[titleField];
        }
      }
      // Both supplied or neither — upsert handles validation / no-op.
    }

    // patch may produce a record missing the body field (e.g., `{body: null}`
    // deletes per RFC 7396). The consumer's intent is explicit at the patch
    // call site, so we don't trip the upsert allowMissingBody guard here.
    return this.upsert(merged, { allowMissingBody: true });
  }

  async delete(target: T | string): Promise<void> {
    if (this.#transaction !== undefined) {
      await this.#deleteInTx(target);
      return;
    }
    this.#checkStrictMode();
    const tx = transactionContext.getStore();
    if (tx !== undefined) {
      await tx.sheet(this.#name, this.#txDelegateOpts()).delete(target);
      return;
    }
    const path = typeof target === 'string' ? target : await this.pathForRecord(target);
    await this.#repo.transact({ message: `${this.#name} delete ${path}` }, async (innerTx) => {
      await innerTx.sheet(this.#name, this.#txDelegateOpts()).delete(target);
    });
  }

  // --- Indexing (specs/behaviors/indexing.md) ---

  /**
   * Declare a secondary in-memory index on this Sheet.
   *
   * Overloads:
   *   defineIndex(name, keyFn) → void
   *   defineIndex(name, { unique?, eager?: false }, keyFn) → void
   *   defineIndex(name, { unique?, eager: true }, keyFn)   → Promise<void>
   *
   * keyFn returns a string key; returning undefined / null excludes the
   * record from the index entirely. With `eager: true`, the return value
   * resolves when the initial build completes (or rejects on conflict).
   */
  defineIndex(name: string, keyFn: IndexKeyFn<T>): void;
  defineIndex(
    name: string,
    opts: DefineIndexOptions & { eager: true },
    keyFn: IndexKeyFn<T>,
  ): Promise<void>;
  defineIndex(
    name: string,
    opts: DefineIndexOptions & { eager?: false | undefined },
    keyFn: IndexKeyFn<T>,
  ): void;
  defineIndex(
    name: string,
    optsOrFn: DefineIndexOptions | IndexKeyFn<T>,
    maybeFn?: IndexKeyFn<T>,
  ): void | Promise<void> {
    let opts: DefineIndexOptions;
    let keyFn: IndexKeyFn<T>;
    if (typeof optsOrFn === 'function') {
      opts = {};
      keyFn = optsOrFn;
    } else {
      opts = optsOrFn;
      if (typeof maybeFn !== 'function') {
        throw new TypeError(`defineIndex(${name}, opts, keyFn): keyFn must be a function`);
      }
      keyFn = maybeFn;
    }
    const state: IndexState<T> = {
      name,
      unique: opts.unique ?? false,
      eager: opts.eager ?? false,
      keyFn,
      built: false,
      treeHashAtBuild: null,
      uniqueMap: new Map<string, T>(),
      multiMap: new Map<string, T[]>(),
    };
    this.#indexes.set(name, state);
    if (state.eager) {
      // Per spec, eager defineIndex returns Promise<void> resolving when
      // the build completes (or rejecting on conflict).
      return this.#ensureIndexBuilt(state);
    }
    return;
  }

  /**
   * Look up records by an index. Unique indexes return `record | undefined`;
   * non-unique indexes return an array.
   */
  async findByIndex(name: string, key: string): Promise<T | T[] | undefined> {
    const state = this.#indexes.get(name);
    if (!state) {
      throw new IndexError('index_not_defined', `index "${name}" is not defined on sheet "${this.#name}"`);
    }
    await this.#ensureIndexBuilt(state);
    if (state.unique) return state.uniqueMap.get(key);
    return state.multiMap.get(key) ?? [];
  }

  async getAttachment(record: T | string, name: string): Promise<BlobHandle | null> {
    const config = await this.readConfig();
    const recordPath = typeof record === 'string' ? record : await this.pathForRecord(record);
    if (this.#transaction !== undefined) {
      this.#ensureCoreSheetOpened();
      const hash = callCore(() => this.#transaction!.coreTx.getAttachment(this.#name, recordPath, name));
      return hash === null ? null : makeBlobHandle(this.#gitDir, hash, '100644');
    }
    const full = joinTreePath(this.#dataBase, this.#effectiveRoot(config), recordPath, name);
    const hash = await revParseObject(this.#gitDir, `${this.#configTreeRef()}:${full}`);
    if (hash === null) return null;
    return makeBlobHandle(this.#gitDir, hash, '100644');
  }

  async getAttachments(
    record: T | string,
  ): Promise<Record<string, BlobHandle> | null> {
    const config = await this.readConfig();
    const recordPath = typeof record === 'string' ? record : await this.pathForRecord(record);
    if (this.#transaction !== undefined) {
      this.#ensureCoreSheetOpened();
      const entries = callCore(() => this.#transaction!.coreTx.getAttachments(this.#name, recordPath));
      if (entries === null) return null;
      const out: Record<string, BlobHandle> = {};
      for (const e of entries) {
        out[e.name] = makeBlobHandle(this.#gitDir, e.hash, '100644');
      }
      return out;
    }
    const dirPath = joinTreePath(this.#dataBase, this.#effectiveRoot(config), recordPath);
    const blobs = await lsTreeBlobs(this.#gitDir, this.#configTreeRef(), dirPath);
    if (blobs === null) return null;
    const out: Record<string, BlobHandle> = {};
    for (const [name, { hash, mode }] of Object.entries(blobs)) {
      out[name] = makeBlobHandle(this.#gitDir, hash, mode);
    }
    return out;
  }

  /**
   * Async iterator over a record's attachments. Each yielded item carries
   * `name`, an extension-inferred `mimeType`, and a `blob` handle with
   * `.read()` (returns `Buffer`) and `.stream()` (returns a Readable).
   *
   * The iterator is the friendlier consumer surface for browsing attachments.
   * For programmatic blob-hash access, `getAttachments` remains.
   *
   * See specs/behaviors/attachments.md.
   */
  async *attachments(record: T | string): AsyncGenerator<AttachmentEntry> {
    const blobMap = await this.getAttachments(record);
    if (!blobMap) return;
    const gitDir = this.#repo.gitDir;
    for (const name in blobMap) {
      const blob = blobMap[name];
      if (!blob) continue;
      yield {
        name,
        mimeType: inferMimeType(name),
        blob: makeAttachmentBlobHandle(gitDir, blob.hash),
      };
    }
  }

  async setAttachment(
    record: T | string,
    name: string,
    blob: string | BlobHandle,
  ): Promise<void> {
    await this.setAttachments(record, { [name]: blob });
  }

  async setAttachments(
    record: T | string,
    attachments: Record<string, string | BlobHandle>,
  ): Promise<void> {
    if (this.#transaction === undefined) {
      this.#checkStrictMode();
      const tx = transactionContext.getStore();
      if (tx !== undefined) {
        await tx.sheet(this.#name, this.#txDelegateOpts()).setAttachments(record, attachments);
        return;
      }
      await this.#repo.transact(
        { message: `${this.#name} attachments` },
        async (innerTx) => {
          await innerTx.sheet(this.#name, this.#txDelegateOpts()).setAttachments(record, attachments);
        },
      );
      return;
    }
    const recordPath = typeof record === 'string' ? record : await this.pathForRecord(record);
    this.#ensureCoreSheetOpened();
    const map: Record<string, string> = {};
    for (const [aName, content] of Object.entries(attachments)) {
      // A string is hashed as its UTF-8 bytes; a BlobHandle already names an
      // ODB blob (from repo.writeBlob or a diff), so reuse its hash directly.
      map[aName] =
        typeof content === 'string'
          ? callCore(() => addon.writeBlob(this.#gitDir, Buffer.from(content, 'utf8')))
          : content.hash;
    }
    callCore(() => this.#transaction!.coreTx.setAttachments(this.#name, recordPath, map));
  }

  /**
   * Remove a single attachment. Throws `NotFoundError` if the named attachment
   * doesn't exist (so callers can't silently miss bugs). Sibling attachments
   * are left intact. See specs/behaviors/attachments.md.
   */
  async deleteAttachment(record: T | string, name: string): Promise<void> {
    if (this.#transaction === undefined) {
      this.#checkStrictMode();
      const tx = transactionContext.getStore();
      if (tx !== undefined) {
        await tx.sheet(this.#name, this.#txDelegateOpts()).deleteAttachment(record, name);
        return;
      }
      await this.#repo.transact(
        { message: `${this.#name} deleteAttachment ${name}` },
        async (innerTx) => {
          await innerTx.sheet(this.#name, this.#txDelegateOpts()).deleteAttachment(record, name);
        },
      );
      return;
    }
    const recordPath = typeof record === 'string' ? record : await this.pathForRecord(record);
    this.#ensureCoreSheetOpened();
    // The core is strict: a missing attachment throws NotFoundError(record_not_found).
    callCore(() => this.#transaction!.coreTx.deleteAttachment(this.#name, recordPath, name));
  }

  /**
   * Remove all attachments for a record. No-op if the record has no
   * attachment directory (same idempotent shape as the cascade behavior in
   * `Sheet.delete`). See specs/behaviors/attachments.md.
   */
  async deleteAttachments(record: T | string): Promise<void> {
    if (this.#transaction === undefined) {
      this.#checkStrictMode();
      const tx = transactionContext.getStore();
      if (tx !== undefined) {
        await tx.sheet(this.#name, this.#txDelegateOpts()).deleteAttachments(record);
        return;
      }
      await this.#repo.transact(
        { message: `${this.#name} deleteAttachments` },
        async (innerTx) => {
          await innerTx.sheet(this.#name, this.#txDelegateOpts()).deleteAttachments(record);
        },
      );
      return;
    }
    const recordPath = typeof record === 'string' ? record : await this.pathForRecord(record);
    this.#ensureCoreSheetOpened();
    // No attachment dir → the core removes nothing and leaves the tx unmutated.
    callCore(() => this.#transaction!.coreTx.deleteAttachments(this.#name, recordPath));
  }

  // --- Private helpers ---

  #checkStrictMode(): void {
    if (this.#repo.isStrictMode()) {
      throw new TransactionError(
        'transaction_required',
        `Sheet.${this.#name} writes require an explicit repo.transact in strict mode`,
      );
    }
  }

  async #autoTransact(
    inner: (tx: Transaction) => Promise<UpsertResult>,
    message: (r: UpsertResult) => string,
  ): Promise<UpsertResult> {
    let staged: UpsertResult | undefined;
    const result = await this.#repo.transact(
      { message: `${this.#name} upsert` },
      async (innerTx) => {
        staged = await inner(innerTx);
        return staged;
      },
    );
    void result;
    if (staged === undefined) {
      throw new TransactionError('commit_failed', 'auto-transaction completed without staging a write');
    }
    // The first message was a placeholder; we know the final path now, but the
    // commit already happened. The auto-message convention is "<sheet> upsert
    // <renderedPath>", but rendering the path twice is the cost of needing it
    // for the message before staging — for now we accept the simpler form.
    void message;
    return staged;
  }

  async #upsertInTx(record: T, opts: UpsertOptions = {}): Promise<UpsertResult> {
    const tx = this.#transaction!;
    this.#ensureCoreSheetOpened();
    const config = await this.readConfig();

    // Body-presence guard (markdown/mdx) — kept as a host-side TypeError shim.
    const bodyField = config.format.body;
    if (
      bodyField !== undefined &&
      !opts.allowMissingBody &&
      (record as Record<string, unknown>)[bodyField] === undefined
    ) {
      throw new TypeError(
        `Sheet.upsert: record is missing the body field ${JSON.stringify(bodyField)}. Pass { allowMissingBody: true } to opt in, or use Sheet.patch for body-preserving frontmatter updates.`,
      );
    }

    // Standard Schema validator (host-side; may transform). JSON Schema +
    // normalization + path rendering happen in the core's prepareUpsert (which
    // re-runs JSON Schema on the transformed value — cheap, idempotent).
    let input: RecordLike = stripSymbols(record as RecordLike);
    if (this.#validator !== undefined) {
      input = await validateRecord({
        record: input,
        schema: config.schema,
        schemaSourcePath: this.#configPath,
        validator: this.#validator,
      });
    }

    const previous = (record as Record<symbol, unknown>)[RECORD_PATH_KEY];
    const prevArg = typeof previous === 'string' ? previous : undefined;

    // Phase 1 (non-mutating): JSON Schema + normalize + render, in the core.
    const candidate = callCore(() =>
      tx.coreTx.prepareUpsert(this.#name, input, prevArg, opts.allowMissingBody ?? false),
    ) as unknown as { path: string; nextText: string; record: RecordLike };

    // Pre-write unique-index check — throws before staging any bytes.
    this.#uniqueIndexPrecheck(candidate.record, candidate.path);

    // Phase 3 (mutating): write the prepared candidate (deletes the old path on
    // rename, cascading through the core).
    const outcome = callCore(() => tx.coreTx.stageUpsert(this.#name)) as unknown as {
      blobHash: string;
      path: string;
    };
    this.#invalidateIndexes();
    return { blob: makeBlobHandle(this.#gitDir, outcome.blobHash, '100644'), path: outcome.path };
  }

  /**
   * Pre-write unique-index check — throws `IndexError(index_unique_conflict)`
   * before staging any bytes (specs/behaviors/indexing.md) so the tree is never
   * left contradicting a unique constraint.
   */
  #uniqueIndexPrecheck(normalized: RecordLike, recordPath: string): void {
    for (const state of this.#indexes.values()) {
      if (!state.built || !state.unique) continue;
      const rawKey = state.keyFn(normalized as T);
      if (rawKey === undefined || rawKey === null) continue;
      const key = String(rawKey);
      const owner = state.uniqueMap.get(key);
      if (!owner) continue;
      const ownerPath = (owner as Record<symbol, unknown>)[RECORD_PATH_KEY];
      if (typeof ownerPath === 'string' && ownerPath !== recordPath) {
        throw new IndexError(
          'index_unique_conflict',
          `unique index "${state.name}" on sheet "${this.#name}": key ${JSON.stringify(key)} is already used by ${ownerPath}`,
          { conflictingPaths: [ownerPath, recordPath] },
        );
      }
    }
  }

  /**
   * Pre-flight idempotency check for `upsert` — the core runs the prepare
   * pipeline (validation, normalization, serialization) and compares the
   * resulting bytes to the current blob, without mutating. Non-tx callers get a
   * short-lived read-only core transaction.
   */
  async willChange(record: T, opts: UpsertOptions = {}): Promise<WillChangeResult> {
    const config = await this.readConfig();
    const bodyField = config.format.body;
    if (
      bodyField !== undefined &&
      !opts.allowMissingBody &&
      (record as Record<string, unknown>)[bodyField] === undefined
    ) {
      throw new TypeError(
        `Sheet.upsert: record is missing the body field ${JSON.stringify(bodyField)}. Pass { allowMissingBody: true } to opt in, or use Sheet.patch for body-preserving frontmatter updates.`,
      );
    }
    let input: RecordLike = stripSymbols(record as RecordLike);
    if (this.#validator !== undefined) {
      input = await validateRecord({
        record: input,
        schema: config.schema,
        schemaSourcePath: this.#configPath,
        validator: this.#validator,
      });
    }
    const previous = (record as Record<symbol, unknown>)[RECORD_PATH_KEY];
    const prevArg = typeof previous === 'string' ? previous : undefined;

    const wc = (await this.#withCoreTx((coreTx) =>
      callCore(() => coreTx.willChange(this.#name, input, prevArg, opts.allowMissingBody ?? false)),
    )) as unknown as { changed: boolean; path: string; currentBlobHash: string | null; nextText: string };

    const out: WillChangeResult = { changed: wc.changed, path: wc.path, nextText: wc.nextText };
    if (wc.currentBlobHash !== null) {
      Object.assign(out, { currentBlobHash: wc.currentBlobHash });
    }
    return out;
  }

  /**
   * Run `fn` against a core transaction with this sheet opened. Tx-bound sheets
   * reuse their bound transaction; standalone sheets get a short-lived,
   * read-only core transaction (opened at HEAD) that is discarded without
   * committing — used by `willChange`'s prepare pipeline.
   */
  async #withCoreTx<R>(fn: (coreTx: CoreTransaction) => R): Promise<R> {
    if (this.#transaction !== undefined) {
      this.#ensureCoreSheetOpened();
      return fn(this.#transaction.coreTx);
    }
    const author = { name: 'gitsheets', email: 'gitsheets@local' };
    const coreTx = callCore(() =>
      CoreTransaction.begin(this.#gitDir, {
        message: 'willChange',
        author,
        committer: author,
        timeSeconds: Math.floor(Date.now() / 1000),
        offsetMinutes: -new Date().getTimezoneOffset(),
      }),
    );
    try {
      callCore(() => coreTx.openSheet(this.#name, this.#configPath, '.', this.#prefix));
      return fn(coreTx);
    } finally {
      callCore(() => coreTx.discard());
    }
  }

  async #deleteInTx(target: T | string): Promise<void> {
    this.#ensureCoreSheetOpened();
    const recordPath =
      typeof target === 'string' ? target : await this.pathForRecord(target);
    // The core deletes the record file and cascade-deletes its attachment dir;
    // a missing record throws NotFoundError(record_not_found).
    callCore(() => this.#transaction!.coreTx.delete(this.#name, recordPath));
    this.#invalidateIndexes();
  }

  #invalidateIndexes(): void {
    for (const state of this.#indexes.values()) {
      state.built = false;
    }
  }

  async #ensureIndexBuilt(state: IndexState<T>): Promise<void> {
    // Non-tx reads resolve against the stable open snapshot, so the index can be
    // cached by it; a tx-bound sheet's tree mutates, so rebuild each time.
    const currentHash: string | null =
      this.#transaction !== undefined ? null : this.#readRef ?? null;
    if (state.built && currentHash !== null && state.treeHashAtBuild === currentHash) return;

    state.uniqueMap.clear();
    state.multiMap.clear();
    // Index builds always use body-less reads. Indexing by body content is
    // not a supported use case; consumers needing the body should call
    // sheet.loadBody(record) after findByIndex returns.
    // @see specs/behaviors/content-types.md#lazy-body-loading
    for await (const record of this.query({}, { withBody: false })) {
      const rawKey = state.keyFn(record);
      if (rawKey === undefined || rawKey === null) continue;
      const key = String(rawKey);
      if (state.unique) {
        const existing = state.uniqueMap.get(key);
        if (existing) {
          const a = (existing as Record<symbol, unknown>)[RECORD_PATH_KEY];
          const b = (record as Record<symbol, unknown>)[RECORD_PATH_KEY];
          const paths = [a, b].filter((p): p is string => typeof p === 'string');
          throw new IndexError(
            'index_unique_conflict',
            `index "${state.name}" on sheet "${this.#name}": key ${JSON.stringify(key)} appears in multiple records`,
            paths.length > 0 ? { conflictingPaths: paths } : undefined,
          );
        }
        state.uniqueMap.set(key, record);
      } else {
        let arr = state.multiMap.get(key);
        if (!arr) {
          arr = [];
          state.multiMap.set(key, arr);
        }
        arr.push(record);
      }
    }
    state.treeHashAtBuild = currentHash;
    state.built = true;
  }

  #readRecordFromText(
    text: string,
    path: string,
    config: SheetConfig,
    opts: { headerOnly?: boolean } = {},
  ): RecordLike {
    const format = this.#getFormat(config);
    let parsed: RecordLike;
    try {
      parsed = opts.headerOnly
        ? format.parseHeaderOnly(text, config.format)
        : format.parse(text, config.format);
    } catch (err) {
      throw new ConfigError(
        'config_invalid',
        `failed to parse record at ${path}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    (parsed as Record<symbol, unknown>)[RECORD_SHEET_KEY] = this.#name;
    (parsed as Record<symbol, unknown>)[RECORD_PATH_KEY] = path;
    return parsed;
  }
}

function stripSymbols(record: RecordLike): RecordLike {
  // Object spread preserves enumerable string-keyed props; Symbol-keyed props
  // (RECORD_SHEET_KEY, RECORD_PATH_KEY) are dropped — exactly what we want
  // before writing to disk.
  return { ...record };
}
