// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Scrollbars for the editor canvas.
 *
 * The canvas scrolls by wheel, by drag and by keyboard, none of which says how much material
 * there is or where in it the view sits. A scrollbar answers both at a glance and gives a way to
 * travel a long take without a gesture that has to be repeated.
 */

/** A scrollbar's window over its content. */
export interface ScrollRange {
  /** Start of the whole content. */
  min: number;
  /** End of the whole content. */
  max: number;
  /** Start of the visible window. */
  start: number;
  /** End of the visible window. */
  end: number;
}

/** How a scrollbar is built and what it reports. */
export interface ScrollbarOptions {
  orientation: 'horizontal' | 'vertical';
  /** Accessible name, such as `Scroll Time`. */
  label: string;
  /** Reports the window start the user has dragged to, in content units. */
  onScroll(start: number): void;
}

/** Shortest thumb in pixels, so a long take still leaves something to grab. */
const MIN_THUMB = 24;

/**
 * One draggable scrollbar.
 *
 * @remarks Reports intent only; the caller owns the view and decides what the new start means.
 * A vertical bar runs high value at the top, matching pitch on the canvas beside it.
 */
export class Scrollbar {
  readonly element: HTMLElement;
  readonly #thumb: HTMLElement;
  readonly #options: ScrollbarOptions;
  #range: ScrollRange = { min: 0, max: 1, start: 0, end: 1 };
  #pointerId: number | null = null;
  #grabOffset = 0;

  constructor(options: ScrollbarOptions) {
    this.#options = options;
    const element = document.createElement('div');
    element.className = `axys-scrollbar axys-scrollbar-${options.orientation}`;
    element.setAttribute('role', 'scrollbar');
    element.setAttribute('aria-label', options.label);
    element.setAttribute('aria-orientation', options.orientation);

    const thumb = document.createElement('div');
    thumb.className = 'axys-scrollbar-thumb';
    element.append(thumb);

    element.addEventListener('pointerdown', this.#onDown);
    element.addEventListener('pointermove', this.#onMove);
    element.addEventListener('pointerup', this.#onUp);
    element.addEventListener('pointercancel', this.#onUp);

    this.element = element;
    this.#thumb = thumb;
  }

  /** Redraws the thumb for a new window over the content. */
  update(range: ScrollRange): void {
    this.#range = range;
    const content = Math.max(1e-9, range.max - range.min);
    const window = Math.max(1e-9, range.end - range.start);
    const covered = Math.min(1, window / content);
    const offset = clamp01((range.start - range.min) / content);

    const track = this.#trackLength();
    const size = Math.max(MIN_THUMB, covered * track);
    const travel = Math.max(0, track - size);
    const position = travel * clamp01(offset / Math.max(1e-9, 1 - covered));

    this.element.hidden = covered >= 1;
    this.element.setAttribute('aria-valuemin', String(Math.round(range.min)));
    this.element.setAttribute('aria-valuemax', String(Math.round(range.max)));
    this.element.setAttribute('aria-valuenow', String(Math.round(range.start)));

    if (this.#options.orientation === 'horizontal') {
      this.#thumb.style.width = `${String(Math.round(size))}px`;
      this.#thumb.style.transform = `translateX(${String(Math.round(position))}px)`;
    } else {
      this.#thumb.style.height = `${String(Math.round(size))}px`;
      // A vertical bar reads high at the top, so the thumb travels from the far end.
      this.#thumb.style.transform = `translateY(${String(Math.round(travel - position))}px)`;
    }
  }

  /** Detaches the scrollbar's listeners. */
  dispose(): void {
    this.element.removeEventListener('pointerdown', this.#onDown);
    this.element.removeEventListener('pointermove', this.#onMove);
    this.element.removeEventListener('pointerup', this.#onUp);
    this.element.removeEventListener('pointercancel', this.#onUp);
    this.element.remove();
  }

  #onDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    const thumb = this.#thumbBounds();
    const along = this.#along(event);
    this.#pointerId = event.pointerId;
    try {
      this.element.setPointerCapture(event.pointerId);
    } catch {
      // Capture keeps a drag alive off the track; without it the drag simply ends there.
    }
    // Grabbing the thumb keeps the point under the pointer; grabbing the track centres it there.
    this.#grabOffset =
      along >= thumb.start && along <= thumb.end ? along - thumb.start : thumb.size / 2;
    this.#scrollTo(along);
    event.preventDefault();
  };

  #onMove = (event: PointerEvent): void => {
    if (this.#pointerId !== event.pointerId) {
      return;
    }
    this.#scrollTo(this.#along(event));
    event.preventDefault();
  };

  #onUp = (event: PointerEvent): void => {
    if (this.#pointerId !== event.pointerId) {
      return;
    }
    if (this.element.hasPointerCapture(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }
    this.#pointerId = null;
  };

  /** Turns a pointer position along the track into a window start and reports it. */
  #scrollTo(along: number): void {
    const range = this.#range;
    const content = Math.max(1e-9, range.max - range.min);
    const window = Math.max(1e-9, range.end - range.start);
    const track = this.#trackLength();
    const size = this.#thumbBounds().size;
    const travel = Math.max(1e-9, track - size);
    const raw = clamp01((along - this.#grabOffset) / travel);
    const fraction = this.#options.orientation === 'vertical' ? 1 - raw : raw;
    this.#options.onScroll(range.min + fraction * (content - window));
  }

  #along(event: PointerEvent): number {
    const bounds = this.element.getBoundingClientRect();
    return this.#options.orientation === 'horizontal'
      ? event.clientX - bounds.left
      : event.clientY - bounds.top;
  }

  #trackLength(): number {
    const bounds = this.element.getBoundingClientRect();
    return Math.max(1, this.#options.orientation === 'horizontal' ? bounds.width : bounds.height);
  }

  #thumbBounds(): { start: number; end: number; size: number } {
    const track = this.element.getBoundingClientRect();
    const thumb = this.#thumb.getBoundingClientRect();
    if (this.#options.orientation === 'horizontal') {
      return {
        start: thumb.left - track.left,
        end: thumb.right - track.left,
        size: Math.max(1, thumb.width),
      };
    }
    return {
      start: thumb.top - track.top,
      end: thumb.bottom - track.top,
      size: Math.max(1, thumb.height),
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
