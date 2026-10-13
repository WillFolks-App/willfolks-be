import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // La suite base corre con el libro simulado aunque el .env tenga la cadena encendida.
    env: { CHAIN_ENABLED: 'false' },
    // The specs share one database, so they run one file at a time.
    fileParallelism: false,
  },
});
