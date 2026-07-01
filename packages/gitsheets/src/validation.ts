// Validation pipeline — JSON Schema in the core, then optional Standard Schema.
// See specs/behaviors/validation.md.
//
// The JSON-Schema step is the core's native validator (`validateBatch`, the
// pure-Rust `jsonschema` crate configured to mirror the former `ajv` setup:
// Draft 7, formats asserted, all errors). It is the bytes-authority-adjacent,
// cross-binding-consistent persisted-shape check. The consumer-supplied
// Standard Schema validator runs host-side on the native object — a consumer
// app concern, allowed to be language-specific, and NOT part of the on-disk
// contract. See specs/rust-core.md.
//
// **Enumerated divergence from the former `ajv` pass:** `ajv` ran `strict:
// true`, rejecting *unknown JSON-Schema keywords* (and disabling `$data`) at
// compile with `ConfigError(config_invalid)`. The core's `jsonschema` crate is
// lenient — it silently ignores unknown keywords — so a schema with a typo'd or
// `$data` keyword now compiles where `ajv` would have rejected it. This is a
// deliberate, documented core behavior (see gitsheets-core::validation and the
// node-binding-thin plan Notes).

import { addon, callCore } from './core.js';
import { ValidationError, type ValidationIssue } from './errors.js';

export type JSONSchema = Record<string, unknown>;

// Subset of the Standard Schema v1 interface used here. Consumers may pass any
// validator (Zod, Valibot, ArkType, Effect Schema) that implements `~standard`.
// See https://standardschema.dev for the full interface.
export interface StandardSchemaPathSegment {
  readonly key: string | number;
}
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<string | number | StandardSchemaPathSegment>;
}
export interface StandardSchemaSuccess<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}
export interface StandardSchemaFailure {
  readonly issues: ReadonlyArray<StandardSchemaIssue>;
}
export type StandardSchemaResult<Output> = StandardSchemaSuccess<Output> | StandardSchemaFailure;
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  };
  /** unused — only here so consumers' generic type can flow Input/Output. */
  readonly __types__?: { input: Input; output: Output };
}

// --- Public validate ---

export async function validateRecord(opts: {
  record: Record<string, unknown>;
  schema: JSONSchema | null;
  schemaSourcePath?: string;
  validator?: StandardSchemaV1 | undefined;
}): Promise<Record<string, unknown>> {
  const issues: ValidationIssue[] = [];
  let value: Record<string, unknown> = opts.record;

  if (opts.schema) {
    // Compile-once + validate in the core; a schema that won't compile surfaces
    // as a typed ConfigError(config_invalid) via callCore.
    const [recordIssues = []] = callCore(() => addon.validateBatch(opts.schema, [value]));
    for (const issue of recordIssues) {
      issues.push(coreIssueToIssue(issue));
    }
  }

  if (issues.length > 0) {
    throw new ValidationError('validation_failed', 'record failed JSON Schema validation', {
      issues,
    });
  }

  if (opts.validator) {
    const result = await opts.validator['~standard'].validate(value);
    if (isFailure(result)) {
      for (const issue of result.issues) {
        issues.push(standardIssueToIssue(issue));
      }
      throw new ValidationError(
        'validation_failed',
        'record failed Standard Schema validation',
        { issues },
      );
    }
    value = result.value as Record<string, unknown>;
  }

  return value;
}

/** Map a core `JsValidationIssue` onto the package `ValidationIssue` shape. */
function coreIssueToIssue(issue: {
  path: string[];
  message: string;
  source: string;
  schemaPath?: string;
  code?: string;
}): ValidationIssue {
  const out: ValidationIssue = {
    path: issue.path,
    message: issue.message,
    source: issue.source === 'standard-schema' ? 'standard-schema' : 'json-schema',
  };
  if (issue.schemaPath !== undefined) {
    Object.assign(out, { schemaPath: issue.schemaPath });
  }
  if (issue.code !== undefined) {
    Object.assign(out, { code: issue.code });
  }
  return out;
}

function standardIssueToIssue(issue: StandardSchemaIssue): ValidationIssue {
  const path: string[] = [];
  for (const seg of issue.path ?? []) {
    if (typeof seg === 'string' || typeof seg === 'number') {
      path.push(String(seg));
    } else if (seg && typeof seg === 'object' && 'key' in seg) {
      path.push(String(seg.key));
    }
  }
  return {
    path,
    message: issue.message,
    source: 'standard-schema',
  };
}

function isFailure<T>(result: StandardSchemaResult<T>): result is StandardSchemaFailure {
  return 'issues' in result && Array.isArray(result.issues);
}
