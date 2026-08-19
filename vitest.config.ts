import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Each test file gets its own state directory; see the setup file.
    setupFiles: ['tests/setup-state-home.ts'],
  },
});
