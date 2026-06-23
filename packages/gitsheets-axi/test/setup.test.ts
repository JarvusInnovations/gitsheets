// `setup hooks` command surface. The actual hook install writes to the real
// ~/.claude (os.homedir ignores $HOME), so we only cover the dispatcher-level
// argument handling here — `--help`, the unknown-action guard, and that the
// command is registered in the surface. The install path is exercised by the
// SDK's own tests.

import { describe, expect, it } from 'vitest';

import { SETUP_HELP, setupCommand } from '../src/commands/setup.js';

describe('setup', () => {
  it('returns help for --help', async () => {
    const out = await setupCommand(['--help']);
    expect(out).toBe(SETUP_HELP);
    expect(out).toContain('gitsheets-axi setup hooks');
  });

  it('rejects an unknown action with VALIDATION_ERROR', async () => {
    await expect(setupCommand(['frobnicate'])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects a missing action with VALIDATION_ERROR', async () => {
    await expect(setupCommand([])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});
