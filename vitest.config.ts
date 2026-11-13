import { existsSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';

// These circuit tests read the original Proteus .DSN lab circuits from cours/. That folder is course
// material and is not part of this repository, so the files below only run when it is present.
const needsCourseFiles = [
  'packages/circuit/test/dsn.test.ts',
  'packages/circuit/test/leds.test.ts',
  'packages/circuit/test/netlist.test.ts',
  'packages/circuit/test/schematic-io.test.ts',
  'packages/circuit/test/simulator.test.ts',
  'packages/circuit/test/templates.test.ts',
  'packages/circuit/test/review/led-step-display.test.ts',
];
const hasCourseFiles = existsSync(new URL('./cours', import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'app/src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(hasCourseFiles ? [] : needsCourseFiles)],
  },
});
