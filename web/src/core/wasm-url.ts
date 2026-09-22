// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Absolute URL of the compiled core module, valid at a domain root and at a repository subpath.
 *
 * @remarks Resolved against this module's own URL, so no origin or deployment path is baked in.
 * Usable from the main thread, a worker and an AudioWorklet.
 */
export function wasmModuleUrl(): URL {
  return new URL('../wasm/axys_wasm_bg.wasm', import.meta.url);
}
