import { defineConfig } from 'vitest/config';
import { cpus } from 'node:os';

// Match the library package's vitest layout — integration-style tests
// against on-disk git repos benefit from the same worker cap + timeout.
const halfCpus = Math.max(2, Math.floor(cpus().length / 2));

export default defineConfig({
  test: {
    testTimeout: 20_000,
    maxWorkers: halfCpus,
    minWorkers: 1,
  },
});
