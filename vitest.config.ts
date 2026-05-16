import { defineConfig } from 'vitest/config';
import { cpus } from 'node:os';

// Cap parallel test files at ~half the cores. Most of the suite is
// integration-style (git command spawns under a fresh tmpdir-backed repo);
// piling test files past that exhausts disk/process bandwidth and lights
// up timeouts that aren't reflecting real hangs. With this cap + the
// 20s testTimeout, a stuck process still shows up as a hang.
const halfCpus = Math.max(2, Math.floor(cpus().length / 2));

export default defineConfig({
  test: {
    testTimeout: 20_000,
    poolOptions: {
      forks: { maxForks: halfCpus },
      threads: { maxThreads: halfCpus },
    },
  },
});
