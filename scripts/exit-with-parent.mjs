// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ends this process when the dev launcher that started it is gone.
 *
 * `scripts/dev.mjs` names itself in `AXYS_DEV_PARENT`. A launcher stopped cleanly takes its
 * children down itself; this catches the stops that run no handler at all, such as an IDE's Stop
 * button or a closed terminal on Windows, which otherwise leave the dev server holding its port.
 * Does nothing when the variable is unset.
 */
export function exitWithParent() {
  const parent = Number(process.env.AXYS_DEV_PARENT);
  if (!Number.isInteger(parent) || parent <= 0) return;
  const timer = setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      process.exit(0);
    }
  }, 1000);
  timer.unref();
}
