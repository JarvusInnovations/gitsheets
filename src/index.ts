// Public exports for gitsheets.
// See specs/api/ for the full contract.

export * from './errors.js';

export { Repository, openRepo } from './repository.js';
export type { OpenRepoOptions, OpenSheetOptions } from './repository.js';

export { Sheet, RECORD_PATH_KEY, RECORD_SHEET_KEY } from './sheet.js';
export type {
  SheetConfig,
  SheetFieldConfig,
  SortRule,
  UpsertResult,
  SheetConstructorOptions,
  IndexKeyFn,
  DefineIndexOptions,
} from './sheet.js';

export { mergePatch } from './patch.js';

export { openStore } from './store.js';
export type {
  OpenStoreOptions,
  Store,
  StoreTx,
  StoreTransactFn,
  ValidatorMap,
} from './store.js';

export { Transaction } from './transaction.js';
export type {
  Author,
  TransactionOptions,
  TransactionResult,
  TransactionHandler,
} from './transaction.js';

export { Template } from './path-template/index.js';
export type {
  RecordLike,
  PathTemplateBlob,
  PathTemplateTree,
  PathTemplateQueryResult,
} from './path-template/index.js';

export type {
  JSONSchema,
  StandardSchemaV1,
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaFailure,
  StandardSchemaSuccess,
  StandardSchemaPathSegment,
} from './validation.js';
