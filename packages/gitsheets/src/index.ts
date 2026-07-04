// Public exports for gitsheets.
// See specs/api/ for the full contract.

export * from './errors.js';

export { Repository, openRepo } from './repository.js';
export type {
  OpenRepoOptions,
  OpenSheetOptions,
  OpenSheetsOptions,
} from './repository.js';

export { Sheet, RECORD_PATH_KEY, RECORD_SHEET_KEY } from './sheet.js';
export type {
  SheetConfig,
  SheetFieldConfig,
  SortRule,
  UpsertResult,
  UpsertOptions,
  WillChangeResult,
  SheetConstructorOptions,
  IndexKeyFn,
  DefineIndexOptions,
  QueryFilter,
  QueryOptions,
  DiffStatus,
  DiffOptions,
  DiffChange,
  AttachmentBlobHandle,
  AttachmentContent,
  AttachmentEntry,
} from './sheet.js';

export {
  getFormat,
  hasFormat,
  registerFormat,
  resolveFormatConfig,
} from './format/index.js';
export type { Format, FormatConfig } from './format/index.js';

export { mergePatch } from './patch.js';

export type { BlobHandle } from './working-tree.js';

export { openStore } from './store.js';
export type {
  OpenStoreOptions,
  Store,
  StoreTx,
  StoreTransactFn,
  ValidatorMap,
  InferRecord,
} from './store.js';

export { PushDaemon } from './push-daemon.js';
export type {
  PushDaemonOptions,
  PushDaemonStatus,
  PushFailureReason,
  BackoffConfig,
} from './push-daemon.js';

export { Transaction } from './transaction.js';
export type {
  Author,
  TransactionOptions,
  TransactionResult,
  TransactionHandler,
} from './transaction.js';

export { parseToml, parseConfigToml, stringifyRecord } from './toml.js';

export { Template } from './path-template/index.js';
export type {
  RecordLike,
  PathTemplateBlob,
  PathTemplateTree,
  PathTemplateQueryResult,
} from './path-template/index.js';

export { validateRecord } from './validation.js';
export type {
  JSONSchema,
  StandardSchemaV1,
  StandardSchemaProps,
  StandardSchemaTypes,
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaFailure,
  StandardSchemaSuccess,
  StandardSchemaPathSegment,
} from './validation.js';
