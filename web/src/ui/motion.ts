// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Enter and exit animation for chrome that is added to and removed from the document.
 *
 * An element entering can animate from its own stylesheet rule, because it is in the document
 * for the length of the animation. An element leaving cannot: removing it ends the animation
 * before it is seen. This file holds the leaving half, so a menu, a tooltip or a toast fades out
 * rather than blinking away.
 *
 * Nothing the editor draws per frame goes through here. The playhead, a canvas drag, a value
 * scrub and zoom are answered on the frame they are asked for; an eased delay on any of them
 * reads as lag.
 */

/** Whether the device asks for motion to be kept to a minimum. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Plays an element's exit animation, then finishes with `then`.
 *
 * @remarks `then` runs exactly once whether the animation finishes, is cancelled, or never
 * starts because the element carries no animation at this setting. Under reduced motion, or in a
 * hidden page, it runs immediately. A page that stops painting pauses its animations, so a timer
 * set to the animation's own length finishes it regardless.
 */
export function animateOut(element: HTMLElement, className: string, then: () => void): void {
  let done = false;
  const finish = (): void => {
    if (done) {
      return;
    }
    done = true;
    element.classList.remove(className);
    then();
  };

  if (prefersReducedMotion() || !element.isConnected || document.hidden) {
    finish();
    return;
  }

  element.classList.add(className);
  const animations = element.getAnimations();
  if (animations.length === 0) {
    finish();
    return;
  }
  void Promise.all(animations.map((animation) => animation.finished)).then(finish, finish);
  const length = Math.max(
    ...animations.map((animation) => Number(animation.effect?.getComputedTiming().endTime ?? 0)),
  );
  setTimeout(finish, (Number.isFinite(length) ? length : 0) + EXIT_GRACE_MS);
}

/** Time past an exit animation's own length before the timer finishes it anyway. */
const EXIT_GRACE_MS = 100;
