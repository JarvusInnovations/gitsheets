import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AxiError } from 'axi-sdk-js';
import { ConfigError, type Repository, type Sheet } from 'gitsheets';

import { translateError } from '../errors.js';

/**
 * Open a sheet, translating failures to AxiError. When the sheet config is
 * missing from the committed tree but `.gitsheets/<name>.toml` exists in the
 * working tree, emit a targeted hint: gitsheets reads sheet configs from the
 * committed git tree, not the working tree, so a freshly-authored config must
 * be committed before any record command can see it. This is a common first-run
 * trap — author the config, run upsert, get an opaque "not found".
 */
export async function openSheetForCommand(
  repo: Repository,
  name: string,
  opts: { prefix?: string } = {},
): Promise<Sheet> {
  try {
    return await repo.openSheet(name, opts);
  } catch (error) {
    if (error instanceof ConfigError && error.code === 'config_missing') {
      const configPath = join('.gitsheets', `${name}.toml`);
      const workDir = dirname(repo.gitDir);
      if (existsSync(join(workDir, configPath))) {
        throw new AxiError(
          `Sheet '${name}' isn't in the committed tree, but ${configPath} exists in your working tree.`,
          'CONFIG_INVALID',
          [
            `Commit the config first — gitsheets reads sheet configs from the committed git tree, not the working tree: git add ${configPath} && git commit -m "add ${name} sheet"`,
          ],
        );
      }
    }
    throw translateError(error);
  }
}
