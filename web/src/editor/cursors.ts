// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two custom cursors, built from the tools' own Lucide glyphs.
 *
 * A cursor image is composited by the host, not by the page, so it cannot take a colour from a
 * theme token and it has no ground behind it. Each is drawn twice: a heavy dark pass first and
 * the light shape over it, which is what keeps it legible over the waveform, over a light
 * surface and over a selection fill alike.
 *
 * Every custom cursor is 24px with a declared hotspot and a stock fallback, so a host that
 * refuses the image still shapes the pointer for what the tool does.
 */

import { ICONS } from '../ui/icons.js';
import type { IconName } from '../ui/icons.js';

/** Where a cursor's point actually is, in pixels from the image's top left. */
interface Hotspot {
  x: number;
  y: number;
}

/**
 * A CSS `cursor` value drawing a glyph, with its hotspot and a stock fallback.
 *
 * @remarks Lucide draws on a 24 grid, which is the size the cursor is rendered at, so the glyph
 * is taken unscaled.
 */
function glyphCursor(icon: IconName, hotspot: Hotspot, fallback: string): string {
  const body = ICONS[icon]
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>$/, '')
    .trim();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ` +
    `fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<g stroke="#000" stroke-width="4" opacity="0.65">${body}</g>` +
    `<g stroke="#fff" stroke-width="2">${body}</g>` +
    `</svg>`;
  const encoded = encodeURIComponent(svg).replace(/'/g, '%27').replace(/"/g, '%22');
  return `url("data:image/svg+xml,${encoded}") ${String(hotspot.x)} ${String(hotspot.y)}, ${fallback}`;
}

/**
 * The pen's cursor, with its point at the nib.
 *
 * @remarks The nib is the glyph's top left corner, so the ink lands where the pointer is rather
 * than where the barrel is.
 */
export const PEN_CURSOR = glyphCursor('pen', { x: 2, y: 2 }, 'crosshair');

/** The band a marquee drag draws, while it is being dragged. */
export const MARQUEE_CURSOR = 'crosshair';
