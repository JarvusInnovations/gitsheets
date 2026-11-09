// Store — typed wrapper over Repository.openSheets with per-sheet validators.
// See specs/api/store.md.

import { ConfigError } from './errors.js';
import type { RecordLike } from './path-template/index.js';
import type { Repository } from './repository.js';
import { Sheet } from './sheet.js';
import type {
  TransactionHandler,
  TransactionOptions,
  TransactionResult,
} from './transaction.js';
import type { StandardSchemaV1 } from './validation.js';

/** Map of sheet name → Standard Schema validator. */
export type ValidatorMap = Readonly<Record<string, StandardSchemaV1<unknown, RecordLike>>>;

/** Extract a validator's output record type, or fall back to `RecordLike`. */
export type InferRecord<V> =
  V extends StandardSchemaV1<unknown, infer Output>
    ? Output extends RecordLike
      ? Output
      : RecordLike
    : RecordLike;

export interface OpenStoreOptions<V extends ValidatorMap = ValidatorMap> {
  readonly validators?: V;
  /**
   * Pin every sheet at this ref (read-only store). `store.refresh()` then
   * re-resolves the ref for each sheet instead of delegating to
   * `repo.refresh()`. See specs/api/store.md "Pinned stores".
   */
  readonly ref?: string;
}

/**
 * Typed view of a Store: every key in `V.validators` becomes a property
 * typed as `Sheet<InferRecord<V[K]>>`. Plus `transact` for atomic bundles.
 *
 * Sheets present in `.gitsheets/` but absent from `validators` are not
 * accessible via property access — they fall outside the typed surface.
 * Use `Repository.openSheet(name)` for one-off un-typed access.
 */
export type Store<V extends ValidatorMap = ValidatorMap> = {
  readonly [K in keyof V]: Sheet<InferRecord<V[K]>>;
} & {
  readonly transact: StoreTransactFn<V>;
  /**
   * Rebind every sheet to the current tree of the repository's default
   * branch (specs/behaviors/default-branch.md) — delegates to
   * `repo.refresh()`. Use after out-of-band ref movement; not needed after
   * this store's own transact (a successful commit auto-refreshes).
   * See specs/behaviors/freshness.md.
   */
  readonly refresh: () => Promise<void>;
};

/** tx object passed into Store.transact's handler. */
export type StoreTx<V extends ValidatorMap = ValidatorMap> = {
  readonly [K in keyof V]: Sheet<InferRecord<V[K]>>;
};

export type StoreTransactFn<V extends ValidatorMap = ValidatorMap> = <T>(
  opts: TransactionOptions,
  handler: (tx: StoreTx<V>) => Promise<T>,
) => Promise<TransactionResult<T>>;

/**
 * Open a typed Store over the repo. Discovers every `.gitsheets/<name>.toml`
 * and attaches per-sheet validators from `opts.validators`. Returns an object
 * whose properties are the validated sheets, plus a `transact` method.
 *
 * Throws `ConfigError(config_missing)` if `validators` names a sheet that has
 * no `.gitsheets/<name>.toml`. Sheets present on disk but absent from
 * `validators` are accessible via `Repository.openSheet(name)`.
 */
export async function openStore<V extends ValidatorMap = ValidatorMap>(
  repo: Repository,
  opts: OpenStoreOptions<V> = {},
): Promise<Store<V>> {
  const sheetsBase = await repo.openSheets(opts.ref !== undefined ? { ref: opts.ref } : {});
  const declared = new Set(Object.keys(sheetsBase));

  // Verify the validator map only names sheets that exist.
  if (opts.validators) {
    for (const name of Object.keys(opts.validators)) {
      if (!declared.has(name)) {
        throw new ConfigError(
          'config_missing',
          `Store opens with validators.${name}, but .gitsheets/${name}.toml is not declared`,
        );
      }
    }
  }

  // Re-open each sheet with its validator (the validator changes per-sheet
  // behavior — easier to re-open than mutate the discovery result).
  const sheets: Record<string, Sheet> = {};
  for (const name of declared) {
    const validator = opts.validators?.[name];
    if (validator !== undefined) {
      sheets[name] = await repo.openSheet(name, opts.ref !== undefined ? { validator, ref: opts.ref } : { validator });
    } else {
      sheets[name] = sheetsBase[name]!;
    }
  }

  const transact: StoreTransactFn<V> = <R>(
    txOpts: TransactionOptions,
    handler: (tx: StoreTx<V>) => Promise<R>,
  ): Promise<TransactionResult<R>> => {
    const innerHandler: TransactionHandler<R> = async (rawTx) => {
      const txObj: Record<string, Sheet> = {};
      for (const name of declared) {
        const validator = opts.validators?.[name];
        txObj[name] = rawTx.sheet(
          name,
          validator !== undefined ? { validator } : undefined,
        );
      }
      return handler(txObj as unknown as StoreTx<V>);
    };
    return repo.transact(txOpts, innerHandler);
  };

  const refresh = async (): Promise<void> => {
    if (opts.ref === undefined) return repo.refresh();
    // A pinned store: repo.refresh() never touches pinned sheets, so
    // re-resolve the ref for each of ours.
    await Promise.all(Object.values(sheets).map((s) => s.refresh()));
  };

  return Object.assign(Object.create(null), sheets, { transact, refresh }) as Store<V>;
}
