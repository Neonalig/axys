// SPDX-License-Identifier: AGPL-3.0-or-later

import init, { coreVersion } from './wasm/axys_wasm.js';

const app = document.querySelector<HTMLDivElement>('#app');
await init();
if (app) {
  app.textContent = `Axys core ${coreVersion()}`;
}
