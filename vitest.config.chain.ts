import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.chain-spec.ts'],
    // Anvil, el despliegue y la base se comparten: un archivo a la vez, sin paralelismo.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
