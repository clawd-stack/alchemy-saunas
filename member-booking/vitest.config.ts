import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // The concurrency test spawns many overlapping bookings; give it room.
    testTimeout: 20_000,
  },
});
