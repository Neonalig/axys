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
 * starts because the element carries no animation at this setting. Under reduced motion it runs
 * immediately.
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

  if (prefersReducedMotion() || !element.isConnected) {
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
}
