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
// **Strict-mode parity with the former `ajv` pass:** `ajv` ran `strict: true`,
// rejecting *unknown JSON-Schema keywords* at compile with
// `ConfigError(config_invalid)`. The core's `jsonschema` crate is lenient on its
// own, so gitsheets-core walks the schema at compile time and raises
// `config_invalid` on any keyword outside the known Draft-07 vocabulary —
// restoring ajv's guard. A typo'd keyword therefore surfaces here as a
// ConfigError via `callCore` (see gitsheets-core::validation).

import { addon, callCore } from './core.js';
import { ValidationError, type ValidationIssue } from './errors.js';

export type JSONSchema = Record<string, unknown>;

// Subset of the Standard Schema v1 interface used here. Consumers may pass any
// validator (Zod, Valibot, ArkType, Effect Schema) that implements `~standard`.
// See https://standardschema.dev for the full interface.
// The declarations mirror the published interface EXACTLY (issue path keys
// are `PropertyKey`, results carry the optional `types` metadata object) so a
// compliant validator's own types assign here with no `as` cast — see
// specs/behaviors/validation.md#type-level-contract-no-casts-required (#237).
export interface StandardSchemaPathSegment {
  readonly key: PropertyKey;
}
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | StandardSchemaPathSegment> | undefined;
}
export interface StandardSchemaSuccess<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}
export interface StandardSchemaFailure {
  readonly issues: ReadonlyArray<StandardSchemaIssue>;
}
export type StandardSchemaResult<Output> = StandardSchemaSuccess<Output> | StandardSchemaFailure;
/** The compile-time-only Input/Output carrier on `~standard.types`. */
export interface StandardSchemaTypes<Input = unknown, Output = Input> {
  readonly input: Input;
  readonly output: Output;
}
export interface StandardSchemaProps<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (
    value: unknown,
  ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  readonly types?: StandardSchemaTypes<Input, Output> | undefined;
}
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaProps<Input, Output>;
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
    if (typeof seg === 'string' || typeof seg === 'number' || typeof seg === 'symbol') {
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
