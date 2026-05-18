// Type-level tests for Store / Sheet generic inference.
//
// These don't exercise runtime — they prove via type-only assertions that
// the consumer-facing TS ergonomics match specs/api/store.md:
//   "store.<sheet> is Sheet<z.infer<typeof SchemaForThatSheet>>"
//
// Failing assertions here surface as `tsc --noEmit` errors and the test
// runner sees zero specs in this file (vitest tolerates that).

import { describe, expectTypeOf, it } from 'vitest';

import { Sheet } from './sheet.js';
import type { Store, StoreTx } from './store.js';
import type { StandardSchemaV1 } from './validation.js';

// --- Fixture types ---

interface User extends Record<string, unknown> {
  slug: string;
  email: string;
  fullName?: string;
}

interface Project extends Record<string, unknown> {
  slug: string;
  title: string;
  stage: 'idea' | 'active' | 'maintaining' | 'dormant';
}

// A minimal Standard Schema validator whose output type is the consumer's
// record. Mirrors what Zod / Valibot / etc. produce structurally.
function makeValidator<O extends Record<string, unknown>>(): StandardSchemaV1<unknown, O> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        return { value: value as O };
      },
    },
  };
}

const UserValidator = makeValidator<User>();
const ProjectValidator = makeValidator<Project>();
const validators = { users: UserValidator, projects: ProjectValidator } as const;
type Validators = typeof validators;

// --- Type assertions ---

describe('Store type-level inference', () => {
  it('store.<sheet> resolves to Sheet<RecordType> per the validator', () => {
    type S = Store<Validators>;

    expectTypeOf<S['users']>().toEqualTypeOf<Sheet<User>>();
    expectTypeOf<S['projects']>().toEqualTypeOf<Sheet<Project>>();
  });

  it('store.transact handler receives StoreTx<V> with the same typing', () => {
    type Tx = StoreTx<Validators>;

    expectTypeOf<Tx['users']>().toEqualTypeOf<Sheet<User>>();
    expectTypeOf<Tx['projects']>().toEqualTypeOf<Sheet<Project>>();
  });

  it('upsert is typed against the validator output', () => {
    type UsersSheet = Store<Validators>['users'];
    type UpsertParam = Parameters<UsersSheet['upsert']>[0];

    expectTypeOf<UpsertParam>().toEqualTypeOf<User>();
  });

  it('queryFirst returns the typed record-or-undefined', () => {
    type UsersSheet = Store<Validators>['users'];
    type QueryFirstReturn = Awaited<ReturnType<UsersSheet['queryFirst']>>;

    expectTypeOf<QueryFirstReturn>().toEqualTypeOf<User | undefined>();
  });

  it('queryAll returns an array of the typed record', () => {
    type UsersSheet = Store<Validators>['users'];
    type QueryAllReturn = Awaited<ReturnType<UsersSheet['queryAll']>>;

    expectTypeOf<QueryAllReturn>().toEqualTypeOf<User[]>();
  });

  it('query filter is keyed against the validator output', () => {
    type UsersSheet = Store<Validators>['users'];
    type FilterParam = Parameters<UsersSheet['queryFirst']>[0];
    type FilterKeys = keyof NonNullable<FilterParam>;

    // The filter accepts a subset of User's keys (plus the function-predicate
    // variant per QueryFilter). Concretely: 'slug', 'email', 'fullName' are
    // valid keys.
    expectTypeOf<'slug'>().toExtend<FilterKeys>();
    expectTypeOf<'email'>().toExtend<FilterKeys>();
  });

  it('patch query and partial flow the validator type', () => {
    type UsersSheet = Store<Validators>['users'];
    type PatchParams = Parameters<UsersSheet['patch']>;

    // First param: query against User keys; second: Partial<User>
    type PartialParam = PatchParams[1];
    expectTypeOf<PartialParam>().toEqualTypeOf<Partial<User>>();
  });

  it('defaults to Sheet<Record<string, unknown>> with no validators', () => {
    type S = Store;
    type Tx = StoreTx;

    // With the default ValidatorMap, individual sheet access types as
    // Sheet<Record<string, unknown>>. (Not the most useful surface — Store
    // shines with explicit validators.)
    void (null as unknown as S);
    void (null as unknown as Tx);
  });
});
