// Typed exception hierarchy with stable codes.
// See specs/api/errors.md for the contract.

export interface ValidationIssue {
  readonly path: string[];
  readonly message: string;
  readonly source: 'json-schema' | 'standard-schema';
  readonly schemaPath?: string;
  readonly code?: string;
  /** The contract name, when the failing branch is a declared contract composed via `allOf`. */
  readonly contract?: string;
  /**
   * The record's sheet-relative path, in a multi-record conformance report
   * (`ContractError.issues` from consumer-side contract verification — see
   * specs/behaviors/contracts.md "Consumer verification").
   */
  readonly record?: string;
}

const STATUS_BY_CODE = {
  config_missing: 500,
  config_invalid: 500,
  validation_failed: 422,
  transaction_in_progress: 409,
  transaction_required: 409,
  parent_moved: 409,
  commit_failed: 500,
  index_unique_conflict: 409,
  index_not_defined: 500,
  push_daemon_running: 409,
  transaction_closed: 409,
  lock_held: 409,
  ref_not_found: 404,
  not_an_ancestor: 409,
  path_render_failed: 422,
  path_invalid_chars: 422,
  record_not_found: 404,
  contract_missing: 500,
  contract_invalid: 500,
  contract_unsatisfied: 422,
} as const satisfies Record<string, number>;

export type GitsheetsErrorCode = keyof typeof STATUS_BY_CODE;

interface GitsheetsErrorOptions {
  readonly cause?: unknown;
}

export class GitsheetsError extends Error {
  readonly code: GitsheetsErrorCode;
  readonly status: number;

  constructor(code: GitsheetsErrorCode, message: string, options?: GitsheetsErrorOptions) {
    // Avoid passing { cause: undefined } when no cause was provided — keeps
    // err.cause unset for clean inspection, and satisfies exactOptionalPropertyTypes.
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.name = new.target.name;
  }
}

export type ConfigErrorCode = 'config_missing' | 'config_invalid';

export class ConfigError extends GitsheetsError {
  constructor(code: ConfigErrorCode, message: string, options?: GitsheetsErrorOptions) {
    super(code, message, options);
  }
}

export type ValidationErrorCode = 'validation_failed';

interface ValidationErrorOptions extends GitsheetsErrorOptions {
  readonly issues: readonly ValidationIssue[];
}

export class ValidationError extends GitsheetsError {
  readonly issues: readonly ValidationIssue[];

  constructor(code: ValidationErrorCode, message: string, options: ValidationErrorOptions) {
    super(code, message, options.cause === undefined ? undefined : { cause: options.cause });
    this.issues = options.issues;
  }
}

export type TransactionErrorCode =
  | 'transaction_in_progress'
  | 'transaction_required'
  | 'parent_moved'
  | 'commit_failed'
  | 'push_daemon_running'
  | 'transaction_closed'
  | 'lock_held';

export class TransactionError extends GitsheetsError {
  constructor(code: TransactionErrorCode, message: string, options?: GitsheetsErrorOptions) {
    super(code, message, options);
  }
}

export type IndexErrorCode = 'index_unique_conflict' | 'index_not_defined';

interface IndexErrorOptions extends GitsheetsErrorOptions {
  readonly conflictingPaths?: readonly string[];
}

export class IndexError extends GitsheetsError {
  readonly conflictingPaths?: readonly string[];

  constructor(code: IndexErrorCode, message: string, options?: IndexErrorOptions) {
    super(code, message, options?.cause === undefined ? undefined : { cause: options.cause });
    if (options?.conflictingPaths !== undefined) {
      this.conflictingPaths = options.conflictingPaths;
    }
  }
}

export type RefErrorCode = 'ref_not_found' | 'not_an_ancestor';

export class RefError extends GitsheetsError {
  constructor(code: RefErrorCode, message: string, options?: GitsheetsErrorOptions) {
    super(code, message, options);
  }
}

export type PathTemplateErrorCode = 'path_render_failed' | 'path_invalid_chars';

export class PathTemplateError extends GitsheetsError {
  constructor(code: PathTemplateErrorCode, message: string, options?: GitsheetsErrorOptions) {
    super(code, message, options);
  }
}

export type NotFoundErrorCode = 'record_not_found';

export class NotFoundError extends GitsheetsError {
  constructor(code: NotFoundErrorCode, message: string, options?: GitsheetsErrorOptions) {
    super(code, message, options);
  }
}

export type ContractErrorCode = 'contract_missing' | 'contract_invalid' | 'contract_unsatisfied';

interface ContractErrorOptions extends GitsheetsErrorOptions {
  /** The contract name in scope, when known. */
  readonly contract?: string;
  /** The conformance report, present on `contract_unsatisfied`. */
  readonly issues?: readonly ValidationIssue[];
}

export class ContractError extends GitsheetsError {
  readonly contract?: string;
  readonly issues?: readonly ValidationIssue[];

  constructor(code: ContractErrorCode, message: string, options?: ContractErrorOptions) {
    super(code, message, options?.cause === undefined ? undefined : { cause: options.cause });
    if (options?.contract !== undefined) this.contract = options.contract;
    if (options?.issues !== undefined) this.issues = options.issues;
  }
}
