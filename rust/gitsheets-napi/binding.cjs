'use strict';

// Thin JS surface over the napi addon. The addon (./index.js) marshals records
// with full type fidelity and throws *structured* errors (own `code`, `status`,
// `gitsheetsClass`, and `issues`/`conflictingPaths` payloads). This wrapper owns
// the one genuinely host-specific concern the Rust side can't: constructing real
// instances of the typed `GitsheetsError` subclasses from `specs/api/errors.md`
// so consumers can `instanceof` and switch on `err.code`.

const addon = require('./index.js');

class GitsheetsError extends Error {
  constructor(message, { code, status, cause } = {}) {
    super(message);
    this.name = 'GitsheetsError';
    this.code = code;
    this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

class ConfigError extends GitsheetsError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'ConfigError';
  }
}

class ValidationError extends GitsheetsError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'ValidationError';
    this.issues = opts.issues ?? [];
  }
}

class TransactionError extends GitsheetsError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'TransactionError';
  }
}

class IndexError extends GitsheetsError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'IndexError';
    if (opts.conflictingPaths !== undefined) this.conflictingPaths = opts.conflictingPaths;
  }
}

class RefError extends GitsheetsError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'RefError';
  }
}

class PathTemplateError extends GitsheetsError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'PathTemplateError';
  }
}

class NotFoundError extends GitsheetsError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'NotFoundError';
  }
}

const CLASS_BY_NAME = {
  ConfigError,
  ValidationError,
  TransactionError,
  IndexError,
  RefError,
  PathTemplateError,
  NotFoundError,
};

// Map a structured error raised by the addon onto its typed class. The mapping
// keys off the `gitsheetsClass` discriminant the core sets — never the message.
function mapCoreError(raw) {
  const Cls = CLASS_BY_NAME[raw && raw.gitsheetsClass] ?? GitsheetsError;
  const opts = { code: raw.code, status: raw.status, cause: raw };
  if (raw.issues !== undefined) opts.issues = raw.issues;
  if (raw.conflictingPaths !== undefined) opts.conflictingPaths = raw.conflictingPaths;
  return new Cls(raw.message, opts);
}

// Wrap an addon call so any structured core error surfaces as its typed class.
function wrap(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (raw) {
      if (raw && typeof raw.gitsheetsClass === 'string') throw mapCoreError(raw);
      throw raw;
    }
  };
}

module.exports = {
  // Marshalling entry points (batch-first).
  roundtrip: addon.roundtrip,
  // Canonical TOML bytes-authority (batch-first). Parse/serialize can raise a
  // structured core error (`config_invalid`), surfaced as its typed class.
  parseRecords: wrap(addon.parseRecords),
  serializeRecords: wrap(addon.serializeRecords),
  // Definition logic (batch-first). Path rendering raises a typed
  // PathTemplateError; schema compilation raises a typed ConfigError.
  renderPathsBatch: wrap(addon.renderPathsBatch),
  validateBatch: wrap(addon.validateBatch),
  runComparator: wrap(addon.runComparator),
  // Stateful compiled definition (compile-once / reuse). Raw class — its
  // structured errors carry `gitsheetsClass`; map with `mapCoreError` if needed.
  CompiledDefinition: addon.CompiledDefinition,
  // Record CRUD over the holo-tree substrate (batch-first). Substrate / record
  // parse failures surface as typed core errors.
  recordRead: wrap(addon.recordRead),
  recordWrite: wrap(addon.recordWrite),
  recordDelete: wrap(addon.recordDelete),
  recordList: wrap(addon.recordList),
  diffRecords: wrap(addon.diffRecords),
  // Query traversal + filtering (batch-first): the template prunes the walk and
  // the filter (equality / nested / `$pred` engine snippets) runs in the core.
  recordQuery: wrap(addon.recordQuery),
  recordQueryCandidates: wrap(addon.recordQueryCandidates),
  templateFieldNames: wrap(addon.templateFieldNames),
  // Secondary indexing (lazy, in-memory). A unique conflict surfaces as a typed
  // IndexError(index_unique_conflict).
  recordIndexUnique: wrap(addon.recordIndexUnique),
  recordIndexMulti: wrap(addon.recordIndexMulti),
  // Substrate (holo-tree) read/write counters — bulk benchmark instrumentation.
  substrateStats: addon.substrateStats,
  substrateReset: addon.substrateReset,
  // Diff / patch primitives (RFC 6902 createPatch, RFC 7396 mergePatch).
  createPatch: wrap(addon.createPatch),
  applyMergePatch: wrap(addon.applyMergePatch),
  // Orchestration: Sheet / Transaction / Store state machine (sheet-store-core).
  // CoreTransaction is the stateful two-phase-protocol driver. Raw class — its
  // methods throw structured errors carrying `gitsheetsClass`/`code`; map with
  // `mapCoreError` where a typed instance is wanted.
  CoreTransaction: addon.CoreTransaction,
  coreDiscoverSheets: wrap(addon.coreDiscoverSheets),
  coreCheckValidators: wrap(addon.coreCheckValidators),
  // Markdown / mdx content-type codec (markdown-codec-core). serialize/parse can
  // raise a typed ValidationError/ConfigError; the H1 + lint-config helpers are
  // pure. The body markdownlint NORMALIZATION is a host-side pre-pass — the core
  // frames the body verbatim (see the gitsheets_core::codec module docs).
  markdownSerialize: wrap(addon.markdownSerialize),
  markdownParse: wrap(addon.markdownParse),
  markdownParseHeaderOnly: wrap(addon.markdownParseHeaderOnly),
  markdownExtractH1: addon.markdownExtractH1,
  markdownRewriteH1: addon.markdownRewriteH1,
  markdownResolveLintConfig: addon.markdownResolveLintConfig,
  // Boundary-test entry: throws the typed class for a given stable code.
  simulateCoreError: wrap(addon.simulateCoreError),
  // Error machinery.
  mapCoreError,
  GitsheetsError,
  ConfigError,
  ValidationError,
  TransactionError,
  IndexError,
  RefError,
  PathTemplateError,
  NotFoundError,
};
