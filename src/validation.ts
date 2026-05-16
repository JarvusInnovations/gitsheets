// Validation pipeline — JSON Schema via ajv, then optional Standard Schema.
// See specs/behaviors/validation.md.

// ajv v8 named-exports Ajv as a class; addFormats is a default-exported plugin
// in a CJS package — NodeNext gives us the namespace, so we pull `.default`.
import { Ajv, type ValidateFunction, type ErrorObject } from 'ajv';
import * as addFormatsNs from 'ajv-formats';
const addFormats: (ajv: Ajv) => Ajv =
  (addFormatsNs as unknown as { default: (a: Ajv) => Ajv }).default;

import { ConfigError, ValidationError, type ValidationIssue } from './errors.js';

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

// --- ajv setup ---

// Compiled validators are cached per schema-identity (object reference) so a
// Sheet's `Sheet.readConfig` returning the same schema object hits the cache.
const COMPILED_CACHE = new WeakMap<JSONSchema, ValidateFunction>();
let sharedAjv: Ajv | null = null;

function getAjv(): Ajv {
  if (!sharedAjv) {
    sharedAjv = new Ajv({ strict: true, allErrors: true, $data: false });
    addFormats(sharedAjv);
  }
  return sharedAjv;
}

export function compileSchema(schema: JSONSchema, sourcePath: string): ValidateFunction {
  const cached = COMPILED_CACHE.get(schema);
  if (cached) return cached;
  const ajv = getAjv();
  let compiled: ValidateFunction;
  try {
    compiled = ajv.compile(schema);
  } catch (err) {
    throw new ConfigError(
      'config_invalid',
      `${sourcePath}: [gitsheet.schema] failed to compile: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  COMPILED_CACHE.set(schema, compiled);
  return compiled;
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
    const compiled = compileSchema(opts.schema, opts.schemaSourcePath ?? '<schema>');
    const ok = compiled(value);
    if (!ok) {
      for (const err of compiled.errors ?? []) {
        issues.push(ajvErrorToIssue(err));
      }
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

function ajvErrorToIssue(err: ErrorObject): ValidationIssue {
  const path = err.instancePath
    ? err.instancePath.split('/').slice(1).map(unescapeJsonPointer)
    : [];
  const issue: ValidationIssue = {
    path,
    message: err.message ?? 'validation failed',
    source: 'json-schema',
  };
  if (err.schemaPath !== undefined) {
    Object.assign(issue, { schemaPath: err.schemaPath });
  }
  if (err.keyword !== undefined) {
    Object.assign(issue, { code: err.keyword });
  }
  return issue;
}

function unescapeJsonPointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
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
