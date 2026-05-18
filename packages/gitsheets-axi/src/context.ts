import { AxiError } from 'axi-sdk-js';
import { openRepo, type Repository } from 'gitsheets';

/**
 * Lazy gitsheets repo resolver. Opens the repo when a command actually needs
 * it. Commands that operate without a repo (currently: none — even `home`
 * shows the repo) call `requireRepo()` to surface a structured error when
 * the cwd isn't inside a git repo.
 */
export interface GitsheetsContext {
  repo(): Promise<Repository>;
  /**
   * Returns `null` rather than throwing when the cwd isn't inside a git repo —
   * `home` uses this to render a "no repo here" message instead of erroring.
   */
  tryRepo(): Promise<Repository | null>;
}

export function createContext(): GitsheetsContext {
  let cached: Repository | null | undefined;
  let cachedError: unknown;

  async function load(): Promise<Repository | null> {
    if (cached !== undefined) return cached;
    if (cachedError !== undefined) throw cachedError;
    try {
      cached = await openRepo();
      return cached;
    } catch (error) {
      cached = null;
      cachedError = error;
      throw error;
    }
  }

  return {
    async repo() {
      try {
        const result = await load();
        if (!result) {
          throw new AxiError(
            'Not inside a git repository.',
            'NOT_A_REPOSITORY',
            ['Run this command from a directory inside a gitsheets-managed git repository.'],
          );
        }
        return result;
      } catch (error) {
        if (error instanceof AxiError) throw error;
        // openRepo throws when there's no git repo. Translate.
        throw new AxiError(
          'Not inside a git repository.',
          'NOT_A_REPOSITORY',
          ['Run this command from a directory inside a gitsheets-managed git repository.'],
        );
      }
    },

    async tryRepo() {
      try {
        return await load();
      } catch {
        return null;
      }
    },
  };
}
