// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'web/src') },
  },
  define: {
    __AXYS_VERSION__: JSON.stringify('test'),
    __AXYS_REVISION__: JSON.stringify('test'),
    __AXYS_REPOSITORY__: JSON.stringify('https://example.invalid/axys'),
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'web/src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
