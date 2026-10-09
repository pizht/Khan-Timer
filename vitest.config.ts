import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The question detector is exercised against a synthetic Khan Academy DOM,
    // so tests run in jsdom (spec 5.1 lists jsdom for exactly this purpose).
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    reporters: 'verbose',
  },
});
