import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = import.meta.dirname;
const alias = {
  '@shared': resolve(root, 'src/shared'),
  '@main': resolve(root, 'src/main'),
  '@renderer': resolve(root, 'src/renderer'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx', 'tests/integration/**/*.test.ts'],
    // jsdom is opted into per file with a `@vitest-environment jsdom` docblock.
    environment: 'node',
    setupFiles: ['tests/setup/vitest.setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  plugins: [react()],
});
