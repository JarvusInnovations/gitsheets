// Store — typed wrapper over Repository.openSheets with per-sheet validators.
// See specs/api/store.md.

import { ConfigError } from './errors.js';
import type { Repository } from './repository.js';
import type { Sheet } from './sheet.js';
import type {
  TransactionHandler,
  TransactionOptions,
  TransactionResult,
} from './transaction.js';
import type { StandardSchemaV1 } from './validation.js';

export type ValidatorMap = Readonly<Record<string, StandardSchemaV1>>;

export interface OpenStoreOptions<V extends ValidatorMap = ValidatorMap> {
  readonly validators?: V;
}

/**
 * tx object passed into store.transact's handler. tx.<sheet> aliases mirror
 * the store's sheets, scoped to the transaction's tree, with validators
 * threaded through.
 */
export type StoreTx = {
  readonly [sheetName: string]: Sheet;
};

export interface Store {
  /** Every declared sheet, keyed by name. Sheets with validators have them attached. */
  readonly [sheetName: string]: Sheet | StoreTransactFn;
  readonly transact: StoreTransactFn;
}

export type StoreTransactFn = <T>(
  opts: TransactionOptions,
  handler: (tx: StoreTx) => Promise<T>,
) => Promise<TransactionResult<T>>;

/**
 * Open a typed Store over the repo. Discovers every `.gitsheets/<name>.toml`,
 * attaches per-sheet validators from `opts.validators`, and returns an object
 * whose properties are the sheets plus a `transact` method.
 *
 * Throws `ConfigError(config_missing)` if a sheet named in `validators` has no
 * config file declared.
 */
export async function openStore<V extends ValidatorMap = ValidatorMap>(
  repo: Repository,
  opts: OpenStoreOptions<V> = {},
): Promise<Store> {
  const sheetsBase = await repo.openSheets();
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
      sheets[name] = await repo.openSheet(name, { validator });
    } else {
      sheets[name] = sheetsBase[name]!;
    }
  }

  const transact: StoreTransactFn = <T>(
    txOpts: TransactionOptions,
    handler: (tx: StoreTx) => Promise<T>,
  ): Promise<TransactionResult<T>> => {
    const innerHandler: TransactionHandler<T> = async (rawTx) => {
      const txObj: Record<string, Sheet> = {};
      for (const name of declared) {
        const validator = opts.validators?.[name];
        txObj[name] = rawTx.sheet(name, validator !== undefined ? { validator } : undefined);
      }
      return handler(txObj as StoreTx);
    };
    return repo.transact(txOpts, innerHandler);
  };

  return Object.assign(Object.create(null), sheets, { transact }) as Store;
}
