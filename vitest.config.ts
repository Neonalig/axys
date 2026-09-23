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
    __AXYS_SIGNATURE__: JSON.stringify(''),
    __AXYS_OFFICIAL_REPOSITORY__: JSON.stringify('https://example.invalid/axys'),
    __AXYS_OFFICIAL_KEY__: JSON.stringify(''),
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'web/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
