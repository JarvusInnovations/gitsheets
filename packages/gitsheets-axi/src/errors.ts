import { AxiError } from 'axi-sdk-js';
import {
  ConfigError,
  GitsheetsError,
  IndexError,
  NotFoundError,
  PathTemplateError,
  RefError,
  TransactionError,
  ValidationError,
  type ValidationIssue,
} from 'gitsheets';

/**
 * Translate a thrown gitsheets error into an AxiError. Centralizes the
 * error→AXI code map so individual commands can `try { ... } catch (e)
 * { throw translateError(e); }` once.
 *
 * The library throws structured `GitsheetsError` subclasses with stable
 * codes. We map each to an AxiError code that aligns with AXI conventions
 * + add tailored next-step suggestions so agents see actionable hints
 * rather than bare error messages.
 */
export function translateError(error: unknown): AxiError {
  if (error instanceof AxiError) return error;

  if (error instanceof ValidationError) {
    const issues = formatValidationIssues(error.issues);
    return new AxiError(
      `Record failed validation: ${issues[0] ?? 'unknown issue'}`,
      'VALIDATION_FAILED',
      issues.slice(1).length > 0 ? issues.slice(1) : [],
    );
  }

  if (error instanceof NotFoundError) {
    return new AxiError(error.message, 'NOT_FOUND', []);
  }

  if (error instanceof ConfigError) {
    return new AxiError(error.message, 'CONFIG_INVALID', [
      'Inspect `.gitsheets/<sheet>.toml` — the sheet config is malformed or missing.',
    ]);
  }

  if (error instanceof IndexError) {
    return new AxiError(error.message, 'INDEX_CONFLICT', []);
  }

  if (error instanceof PathTemplateError) {
    return new AxiError(error.message, 'PATH_TEMPLATE_ERROR', [
      'Check the sheet config\'s `path` template against the record fields.',
    ]);
  }

  if (error instanceof RefError) {
    return new AxiError(error.message, 'REF_ERROR', []);
  }

  if (error instanceof TransactionError) {
    return new AxiError(error.message, 'TRANSACTION_ERROR', []);
  }

  if (error instanceof GitsheetsError) {
    return new AxiError(error.message, error.code.toUpperCase(), []);
  }

  if (error instanceof Error) {
    return new AxiError(error.message, 'UNKNOWN_ERROR', []);
  }

  return new AxiError(String(error), 'UNKNOWN_ERROR', []);
}

function formatValidationIssues(
  issues: readonly ValidationIssue[] | undefined,
): string[] {
  if (!issues || issues.length === 0) return ['(no issue details)'];
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}
