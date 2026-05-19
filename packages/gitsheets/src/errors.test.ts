import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  GitsheetsError,
  IndexError,
  NotFoundError,
  PathTemplateError,
  RefError,
  TransactionError,
  ValidationError,
} from './errors.js';
import type { ValidationIssue } from './errors.js';

describe('GitsheetsError hierarchy', () => {
  it('every subclass extends GitsheetsError and Error', () => {
    const instances: GitsheetsError[] = [
      new ConfigError('config_missing', 'x'),
      new ValidationError('validation_failed', 'x', { issues: [] }),
      new TransactionError('transaction_in_progress', 'x'),
      new IndexError('index_unique_conflict', 'x'),
      new RefError('ref_not_found', 'x'),
      new PathTemplateError('path_render_failed', 'x'),
      new NotFoundError('record_not_found', 'x'),
    ];

    for (const err of instances) {
      expect(err).toBeInstanceOf(GitsheetsError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('each instance carries its class name on `name`', () => {
    expect(new ConfigError('config_missing', 'x').name).toBe('ConfigError');
    expect(new ValidationError('validation_failed', 'x', { issues: [] }).name).toBe(
      'ValidationError',
    );
    expect(new TransactionError('parent_moved', 'x').name).toBe('TransactionError');
    expect(new IndexError('index_unique_conflict', 'x').name).toBe('IndexError');
    expect(new RefError('not_an_ancestor', 'x').name).toBe('RefError');
    expect(new PathTemplateError('path_invalid_chars', 'x').name).toBe('PathTemplateError');
    expect(new NotFoundError('record_not_found', 'x').name).toBe('NotFoundError');
  });

  it('preserves the constructor message', () => {
    const err = new ConfigError('config_invalid', '.gitsheets/users.toml: malformed');
    expect(err.message).toBe('.gitsheets/users.toml: malformed');
  });

  it('threads `cause` through ES2022 native Error.cause', () => {
    const inner = new Error('underlying');
    const err = new TransactionError('commit_failed', 'commit-tree exit 1', { cause: inner });
    expect(err.cause).toBe(inner);
  });

  it('leaves `cause` unset when no cause is provided', () => {
    const err = new ConfigError('config_missing', 'x');
    expect('cause' in err && err.cause !== undefined).toBe(false);
  });
});

describe('code → status mapping', () => {
  it.each([
    ['config_missing', 500, () => new ConfigError('config_missing', 'x')],
    ['config_invalid', 500, () => new ConfigError('config_invalid', 'x')],
    [
      'validation_failed',
      422,
      () => new ValidationError('validation_failed', 'x', { issues: [] }),
    ],
    [
      'transaction_in_progress',
      409,
      () => new TransactionError('transaction_in_progress', 'x'),
    ],
    [
      'transaction_required',
      409,
      () => new TransactionError('transaction_required', 'x'),
    ],
    ['parent_moved', 409, () => new TransactionError('parent_moved', 'x')],
    ['commit_failed', 500, () => new TransactionError('commit_failed', 'x')],
    [
      'index_unique_conflict',
      409,
      () => new IndexError('index_unique_conflict', 'x'),
    ],
    ['index_not_defined', 500, () => new IndexError('index_not_defined', 'x')],
    ['ref_not_found', 404, () => new RefError('ref_not_found', 'x')],
    ['not_an_ancestor', 409, () => new RefError('not_an_ancestor', 'x')],
    [
      'path_render_failed',
      422,
      () => new PathTemplateError('path_render_failed', 'x'),
    ],
    [
      'path_invalid_chars',
      422,
      () => new PathTemplateError('path_invalid_chars', 'x'),
    ],
    ['record_not_found', 404, () => new NotFoundError('record_not_found', 'x')],
  ])('%s → %i', (code, expectedStatus, build) => {
    const err = build();
    expect(err.code).toBe(code);
    expect(err.status).toBe(expectedStatus);
  });
});

describe('ValidationError', () => {
  it('exposes the issues array', () => {
    const issues: ValidationIssue[] = [
      {
        path: ['email'],
        message: 'must match format "email"',
        source: 'json-schema',
        schemaPath: '#/properties/email/format',
        code: 'format',
      },
      {
        path: ['slug'],
        message: 'must match pattern',
        source: 'standard-schema',
        code: 'pattern',
      },
    ];
    const err = new ValidationError('validation_failed', 'invalid record', { issues });
    expect(err.issues).toEqual(issues);
  });

  it('propagates cause alongside issues', () => {
    const inner = new Error('underlying');
    const err = new ValidationError('validation_failed', 'x', {
      issues: [],
      cause: inner,
    });
    expect(err.cause).toBe(inner);
    expect(err.issues).toEqual([]);
  });
});

describe('IndexError', () => {
  it('exposes optional conflictingPaths when provided', () => {
    const err = new IndexError('index_unique_conflict', 'unique conflict', {
      conflictingPaths: ['users/alice.toml', 'users/alice2.toml'],
    });
    expect(err.conflictingPaths).toEqual(['users/alice.toml', 'users/alice2.toml']);
  });

  it('leaves conflictingPaths undefined when not provided', () => {
    const err = new IndexError('index_not_defined', 'no such index');
    expect(err.conflictingPaths).toBeUndefined();
  });
});

describe('consumer narrowing patterns', () => {
  it('catches by instanceof GitsheetsError as documented', () => {
    function classify(err: unknown): { code?: string; status?: number; rethrow?: boolean } {
      if (err instanceof ValidationError) return { code: err.code, status: err.status };
      if (err instanceof GitsheetsError) return { code: err.code, status: err.status };
      return { rethrow: true };
    }

    expect(classify(new ValidationError('validation_failed', 'x', { issues: [] }))).toEqual({
      code: 'validation_failed',
      status: 422,
    });
    expect(classify(new RefError('ref_not_found', 'x'))).toEqual({
      code: 'ref_not_found',
      status: 404,
    });
    expect(classify(new Error('other'))).toEqual({ rethrow: true });
  });
});
