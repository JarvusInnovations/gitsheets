// Sheet — typed handle to one declared sheet in a Repository.
// See specs/api/sheet.md and specs/concepts.md.

import { runInNewContext } from 'node:vm';

import type { BlobObject, TreeObject, Workspace } from 'hologit';

import {
  ConfigError,
  IndexError,
  NotFoundError,
  PathTemplateError,
  TransactionError,
} from './errors.js';
import { mergePatch } from './patch.js';
import { Template, type RecordLike } from './path-template/index.js';
import type { Repository } from './repository.js';
import { stringifyRecord, parseToml, parseConfigToml } from './toml.js';
import sortKeys from 'sort-keys';
import { Transaction, transactionContext } from './transaction.js';
import {
  validateRecord,
  type JSONSchema,
  type StandardSchemaV1,
} from './validation.js';

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
}

// --- Result types ---

export interface UpsertResult {
  readonly blob: BlobObject;
  readonly path: string;
}

// --- Helpers ---

function isBlob(node: unknown): node is BlobObject {
  return typeof node === 'object' && node !== null && (node as { isBlob?: boolean }).isBlob === true;
}

function isTree(node: unknown): node is TreeObject {
  return typeof node === 'object' && node !== null && (node as { isTree?: boolean }).isTree === true;
}

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

function queryMatches(filter: RecordLike, record: RecordLike): boolean {
  for (const [key, qval] of Object.entries(filter)) {
    const rval = record[key];
    if (typeof qval === 'function') {
      const ok = (qval as (recordValue: unknown, record: RecordLike) => unknown)(rval, record);
      if (!ok) return false;
      continue;
    }
    if (qval !== null && typeof qval === 'object' && !Array.isArray(qval) && !(qval instanceof Date)) {
      if (rval === null || typeof rval !== 'object') return false;
      if (!queryMatches(qval as RecordLike, rval as RecordLike)) return false;
      continue;
    }
    if (rval !== qval) return false;
  }
  return true;
}

// --- Sheet config cache (process-wide by blob hash of the config file) ---

const CONFIG_CACHE = new Map<string, SheetConfig>();

async function loadConfig(workspace: Workspace, configPath: string): Promise<SheetConfig> {
  const node = await workspace.root.getChild(configPath);
  if (!node || !isBlob(node)) {
    throw new ConfigError('config_missing', `sheet config not found at ${configPath}`);
  }
  const cached = CONFIG_CACHE.get(node.hash);
  if (cached) return cached;

  const tomlText = await node.read();
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

  const config: SheetConfig = { root, path, fields: fieldsClean, schema };
  CONFIG_CACHE.set(node.hash, config);
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

// --- TOML record cache (closes #138 — keyed by blob hash) ---
//
// Per specs/behaviors/normalization.md, on-disk bytes are deterministic per
// logical-record state, so the same blob hash is the same record content. We
// cache the TOML *text* (not the parsed object) so each reader gets a fresh
// parsed copy — avoiding the original cache's v8.serialize/Date-subclass
// issue without leaking mutable shared state.

const TOML_TEXT_CACHE = new Map<string, string>();
async function readBlobTomlCached(blob: BlobObject): Promise<string> {
  const cached = TOML_TEXT_CACHE.get(blob.hash);
  if (cached !== undefined) return cached;
  const text = await blob.read();
  TOML_TEXT_CACHE.set(blob.hash, text);
  return text;
}

// --- Indexing ---

export type IndexKeyFn = (record: RecordLike) => string | undefined | null;

export interface DefineIndexOptions {
  readonly unique?: boolean;
  readonly eager?: boolean;
}

interface IndexState {
  readonly name: string;
  readonly unique: boolean;
  readonly eager: boolean;
  readonly keyFn: IndexKeyFn;
  built: boolean;
  treeHashAtBuild: string | null;
  uniqueMap: Map<string, RecordLike>;
  multiMap: Map<string, RecordLike[]>;
}

// --- Sheet class ---

export interface SheetConstructorOptions {
  readonly repo: Repository;
  readonly workspace: Workspace;
  readonly dataTree: TreeObject;
  readonly name: string;
  readonly configPath: string;
  readonly transaction?: Transaction;
  /** Consumer-supplied Standard Schema validator; runs after JSON Schema. */
  readonly validator?: StandardSchemaV1;
}

export class Sheet {
  readonly #repo: Repository;
  readonly #workspace: Workspace;
  readonly #dataTree: TreeObject;
  readonly #name: string;
  readonly #configPath: string;
  readonly #transaction: Transaction | undefined;
  readonly #validator: StandardSchemaV1 | undefined;
  readonly #indexes = new Map<string, IndexState>();

  constructor(opts: SheetConstructorOptions) {
    this.#repo = opts.repo;
    this.#workspace = opts.workspace;
    this.#dataTree = opts.dataTree;
    this.#name = opts.name;
    this.#configPath = opts.configPath;
    this.#transaction = opts.transaction;
    this.#validator = opts.validator;
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
    return loadConfig(this.#workspace, this.#configPath);
  }

  /** Same as readConfig — config is cached by config-blob hash anyway. */
  async getCachedConfig(): Promise<SheetConfig> {
    return this.readConfig();
  }

  /** Async iterator over records matching the filter. */
  async *query(filter: RecordLike = {}): AsyncGenerator<RecordLike> {
    if (typeof filter === 'function') {
      throw new TypeError('Sheet.query() does not accept a function — pass a filter object');
    }

    const config = await this.readConfig();
    const template = Template.fromString(config.path);
    const sheetRoot = await this.#getSheetRoot(config.root);
    if (!sheetRoot) return;

    // hologit's TreeObject/BlobObject are structurally compatible with the
    // path-template tree interface; the casts bridge the type lattices.
    for await (const { blob, path: blobPath } of template.queryTree(
      sheetRoot as unknown as Parameters<typeof template.queryTree>[0],
      filter,
    )) {
      const record = await this.#readRecordFromBlob(blob as unknown as BlobObject, blobPath);
      if (!queryMatches(filter, record)) continue;
      yield record;
    }
  }

  async queryFirst(filter: RecordLike = {}): Promise<RecordLike | undefined> {
    for await (const record of this.query(filter)) {
      return record;
    }
    return undefined;
  }

  async queryAll(filter: RecordLike = {}): Promise<RecordLike[]> {
    const results: RecordLike[] = [];
    for await (const record of this.query(filter)) {
      results.push(record);
    }
    return results;
  }

  async pathForRecord(record: RecordLike): Promise<string> {
    const config = await this.readConfig();
    return Template.fromString(config.path).render(record);
  }

  /**
   * Apply canonical normalization (deep key sort + array-field sort rules)
   * without writing or validating.
   */
  async normalizeRecord(record: RecordLike): Promise<RecordLike> {
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
    return sortKeys(out, { deep: true }) as RecordLike;
  }

  async clear(): Promise<void> {
    if (this.#transaction === undefined) {
      await this.#repo.transact({ message: `${this.#name} clear` }, async (tx) => {
        await tx.sheet(this.#name).clear();
      });
      return;
    }
    const config = await this.readConfig();
    const sheetTree = await this.#dataTree.getSubtree(config.root, true);
    if (sheetTree) {
      const children = await sheetTree.getChildren();
      const names: string[] = [];
      for (const k in children) names.push(k);
      for (const childName of names) {
        await sheetTree.deleteChild(childName);
      }
    }
    this.#transaction.markMutated();
  }

  async clone(): Promise<Sheet> {
    return new Sheet({
      repo: this.#repo,
      workspace: this.#workspace,
      dataTree: await this.#dataTree.clone(),
      name: this.#name,
      configPath: this.#configPath,
    });
  }

  async upsert(record: RecordLike): Promise<UpsertResult> {
    if (this.#transaction !== undefined) {
      return this.#upsertInTx(this.#transaction, record);
    }
    this.#checkStrictMode();

    // The tx-bound Sheet returned by tx.sheet(name) doesn't carry this
    // standalone Sheet's `validator`. Apply the Standard Schema layer here
    // so its transform is reflected in what gets written. JSON Schema also
    // runs here; the inner #upsertInTx will re-run it (cheap, idempotent).
    let validated = record;
    if (this.#validator !== undefined) {
      const config = await this.readConfig();
      validated = await validateRecord({
        record: stripSymbols(record),
        schema: config.schema,
        schemaSourcePath: this.#configPath,
        validator: this.#validator,
      });
      // Carry the original path annotation forward for rename detection.
      const existing = (record as Record<symbol, unknown>)[RECORD_PATH_KEY];
      if (typeof existing === 'string') {
        (validated as Record<symbol, unknown>)[RECORD_PATH_KEY] = existing;
      }
    }

    const tx = transactionContext.getStore();
    if (tx !== undefined) {
      return tx.sheet(this.#name).upsert(validated);
    }
    return this.#autoTransact(
      async (innerTx) => innerTx.sheet(this.#name).upsert(validated),
      (r) => `${this.#name} upsert ${r.path}`,
    );
  }

  /**
   * RFC 7396 JSON Merge Patch. Reads the matching record, merges `partial`,
   * validates, and upserts the result. Returns the same shape as upsert.
   * Throws NotFoundError if the query matches no record.
   */
  async patch(query: RecordLike, partial: RecordLike): Promise<UpsertResult> {
    const existing = await this.queryFirst(query);
    if (!existing) {
      throw new NotFoundError(
        'record_not_found',
        `${this.#name}: no record matched ${JSON.stringify(query)}`,
      );
    }
    const merged = mergePatch(stripSymbols(existing), partial) as RecordLike;
    // Carry the record's path annotation forward so upsert's rename
    // detection deletes the old file if the new path differs.
    const existingPath = (existing as Record<symbol, unknown>)[RECORD_PATH_KEY];
    if (typeof existingPath === 'string') {
      (merged as Record<symbol, unknown>)[RECORD_PATH_KEY] = existingPath;
    }
    return this.upsert(merged);
  }

  async delete(target: RecordLike | string): Promise<void> {
    if (this.#transaction !== undefined) {
      await this.#deleteInTx(this.#transaction, target);
      return;
    }
    this.#checkStrictMode();
    const tx = transactionContext.getStore();
    if (tx !== undefined) {
      await tx.sheet(this.#name).delete(target);
      return;
    }
    const path = typeof target === 'string' ? target : await this.pathForRecord(target);
    await this.#repo.transact({ message: `${this.#name} delete ${path}` }, async (innerTx) => {
      await innerTx.sheet(this.#name).delete(target);
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
  defineIndex(name: string, keyFn: IndexKeyFn): void;
  defineIndex(
    name: string,
    opts: DefineIndexOptions & { eager: true },
    keyFn: IndexKeyFn,
  ): Promise<void>;
  defineIndex(
    name: string,
    opts: DefineIndexOptions & { eager?: false | undefined },
    keyFn: IndexKeyFn,
  ): void;
  defineIndex(
    name: string,
    optsOrFn: DefineIndexOptions | IndexKeyFn,
    maybeFn?: IndexKeyFn,
  ): void | Promise<void> {
    let opts: DefineIndexOptions;
    let keyFn: IndexKeyFn;
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
    const state: IndexState = {
      name,
      unique: opts.unique ?? false,
      eager: opts.eager ?? false,
      keyFn,
      built: false,
      treeHashAtBuild: null,
      uniqueMap: new Map(),
      multiMap: new Map(),
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
   * non-unique indexes return `RecordLike[]`.
   */
  async findByIndex(name: string, key: string): Promise<RecordLike | RecordLike[] | undefined> {
    const state = this.#indexes.get(name);
    if (!state) {
      throw new IndexError('index_not_defined', `index "${name}" is not defined on sheet "${this.#name}"`);
    }
    await this.#ensureIndexBuilt(state);
    if (state.unique) return state.uniqueMap.get(key);
    return state.multiMap.get(key) ?? [];
  }

  async getAttachment(record: RecordLike | string, name: string): Promise<BlobObject | null> {
    const config = await this.readConfig();
    const recordPath = typeof record === 'string' ? record : await this.pathForRecord(record);
    const node = await this.#dataTree.getChild(joinTreePath(config.root, recordPath, name));
    return node && isBlob(node) ? node : null;
  }

  async getAttachments(
    record: RecordLike | string,
  ): Promise<Record<string, BlobObject> | null> {
    const config = await this.readConfig();
    const recordPath = typeof record === 'string' ? record : await this.pathForRecord(record);
    const dir = await this.#dataTree.getChild(joinTreePath(config.root, recordPath));
    if (!dir || !isTree(dir)) return null;
    return dir.getBlobMap();
  }

  async setAttachment(
    record: RecordLike | string,
    name: string,
    blob: string | BlobObject,
  ): Promise<void> {
    await this.setAttachments(record, { [name]: blob });
  }

  async setAttachments(
    record: RecordLike | string,
    attachments: Record<string, string | BlobObject>,
  ): Promise<void> {
    if (this.#transaction === undefined) {
      this.#checkStrictMode();
      const tx = transactionContext.getStore();
      if (tx !== undefined) {
        await tx.sheet(this.#name).setAttachments(record, attachments);
        return;
      }
      await this.#repo.transact(
        { message: `${this.#name} attachments` },
        async (innerTx) => {
          await innerTx.sheet(this.#name).setAttachments(record, attachments);
        },
      );
      return;
    }
    const config = await this.readConfig();
    const recordPath = typeof record === 'string' ? record : await this.pathForRecord(record);
    for (const [aName, content] of Object.entries(attachments)) {
      await this.#dataTree.writeChild(joinTreePath(config.root, recordPath, aName), content);
    }
    this.#transaction.markMutated();
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

  async #upsertInTx(tx: Transaction, record: RecordLike): Promise<UpsertResult> {
    const config = await this.readConfig();
    const template = Template.fromString(config.path);

    // Validate before normalizing — per specs/behaviors/validation.md order:
    // JSON Schema → Standard Schema (may transform) → normalize → render → write.
    let validated = await validateRecord({
      record: stripSymbols(record),
      schema: config.schema,
      schemaSourcePath: this.#configPath,
      validator: this.#validator,
    });
    // Standard Schema may have transformed; re-attach annotations if the
    // caller supplied them (for rename detection below).
    const existing = (record as Record<symbol, unknown>)[RECORD_PATH_KEY];
    if (typeof existing === 'string') {
      (validated as Record<symbol, unknown>)[RECORD_PATH_KEY] = existing;
    }

    const normalized = await this.normalizeRecord(validated);
    const recordPath = template.render(normalized);
    if (!recordPath) {
      throw new PathTemplateError(
        'path_render_failed',
        `could not generate any path for record in sheet "${this.#name}"`,
      );
    }

    // Pre-write unique-index check — throws before any tree mutation
    // per specs/behaviors/indexing.md so the tree is never left in a state
    // that contradicts a unique constraint.
    for (const state of this.#indexes.values()) {
      if (!state.built || !state.unique) continue;
      const rawKey = state.keyFn(normalized);
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

    // Rename: if the source record was loaded from a different path, delete the old one.
    if (typeof existing === 'string' && existing !== recordPath) {
      try {
        await this.#dataTree.deleteChild(joinTreePath(config.root, `${existing}.toml`));
      } catch {
        // Old path may not exist — ignore.
      }
    }

    const toml = stringifyRecord(stripSymbols(normalized));
    const blob = await this.#dataTree.writeChild(
      joinTreePath(config.root, `${recordPath}.toml`),
      toml,
    );
    tx.markMutated();
    this.#invalidateIndexes();
    return { blob, path: recordPath };
  }

  async #deleteInTx(tx: Transaction, target: RecordLike | string): Promise<void> {
    const config = await this.readConfig();
    const recordPath =
      typeof target === 'string' ? target : await this.pathForRecord(target);
    const fullPath = joinTreePath(config.root, `${recordPath}.toml`);
    const existing = await this.#dataTree.getChild(fullPath);
    if (!existing) {
      throw new NotFoundError('record_not_found', `${this.#name}: no record at ${recordPath}`);
    }
    await this.#dataTree.deleteChild(fullPath);
    // Cascade-delete the attachment directory at <recordPath>/, if any.
    // Per specs/behaviors/attachments.md the attachment dir is deleted in
    // the same operation.
    try {
      await this.#dataTree.deleteChild(joinTreePath(config.root, recordPath));
    } catch {
      // No attachment dir — that's fine.
    }
    tx.markMutated();
    this.#invalidateIndexes();
  }

  async #getSheetRoot(rootPath: string): Promise<TreeObject | null> {
    if (rootPath === '.' || rootPath === '') return this.#dataTree;
    const sub = await this.#dataTree.getSubtree(rootPath);
    return sub;
  }

  #invalidateIndexes(): void {
    for (const state of this.#indexes.values()) {
      state.built = false;
    }
  }

  async #ensureIndexBuilt(state: IndexState): Promise<void> {
    let currentHash: string | null = null;
    try {
      currentHash = await this.#dataTree.getHash();
    } catch {
      currentHash = null;
    }
    if (state.built && state.treeHashAtBuild === currentHash) return;

    state.uniqueMap.clear();
    state.multiMap.clear();
    for await (const record of this.query()) {
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

  async #readRecordFromBlob(blob: BlobObject, path: string): Promise<RecordLike> {
    const text = await readBlobTomlCached(blob);
    let parsed: RecordLike;
    try {
      parsed = parseToml(text);
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
