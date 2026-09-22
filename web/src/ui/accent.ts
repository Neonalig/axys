// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The accent ramp: one hue in, every accent-derived colour token out.
 *
 * Accent is not one colour. Focus, selection, the selection fill and three blob colours all hang
 * off it, and hand-picking seven values per accent per theme is how a set drifts apart. Each
 * accent supplies only a hue and a chroma multiplier here; the lightness and the chroma ceiling
 * are fixed per role, so every accent lands on the same contrast relationships.
 *
 * The ramp is computed rather than stored because `resolveTheme()` hands token text straight to
 * Canvas 2D, and a `color-mix()` token would reach `fillStyle` as unresolved text. Everything
 * this file returns is a plain hex string.
 */

/** Name of one selectable accent. */
export type AccentName =
  'cerulean' | 'lagoon' | 'seaGlass' | 'abyssal' | 'kelp' | 'coral' | 'ember' | 'slate';

/** Every accent in selection order. */
export const ACCENT_NAMES: readonly AccentName[] = [
  'cerulean',
  'lagoon',
  'seaGlass',
  'abyssal',
  'kelp',
  'coral',
  'ember',
  'slate',
];

/** The accent a device with nothing stored starts from, and the product's own identity colour. */
export const DEFAULT_ACCENT: AccentName = 'cerulean';

/** Short Title Case name per accent, used as the swatch's accessible name. */
export const ACCENT_LABELS: Readonly<Record<AccentName, string>> = {
  cerulean: 'Cerulean',
  lagoon: 'Lagoon',
  seaGlass: 'Sea Glass',
  abyssal: 'Abyssal',
  kelp: 'Kelp',
  coral: 'Coral',
  ember: 'Ember',
  slate: 'Slate',
};

/**
 * What an accent contributes to the ramp.
 *
 * @remarks Every hue sits at least 25 degrees from `pitchTarget`, `pitchDetected`, `midiNote` and
 * `playhead`, which is why the set leans blue and green rather than spreading round the wheel.
 * `chroma` is a multiplier on the role's ceiling, so Slate is Cerulean at a third of its chroma
 * and costs no hue budget of its own.
 */
export interface Accent {
  /** OKLCH hue in degrees. */
  hue: number;
  /** Fraction of the role's chroma ceiling this accent takes, from 0 to 1. */
  chroma: number;
}

/** Hue and chroma per accent. */
export const ACCENTS: Readonly<Record<AccentName, Accent>> = {
  cerulean: { hue: 248, chroma: 1 },
  lagoon: { hue: 212, chroma: 1 },
  seaGlass: { hue: 190, chroma: 1 },
  abyssal: { hue: 270, chroma: 1 },
  kelp: { hue: 130, chroma: 1 },
  coral: { hue: 22, chroma: 1 },
  ember: { hue: 48, chroma: 1 },
  slate: { hue: 248, chroma: 0.35 },
};

/** The colour tokens derived from the accent rather than authored per theme. */
export const ACCENT_TOKENS = [
  'accent',
  'accentText',
  'focus',
  'selection',
  'selectionFill',
  'blobFill',
  'blobFillSelected',
  'blobBounds',
] as const;

/** Name of one accent-derived colour token. */
export type AccentTokenName = (typeof ACCENT_TOKENS)[number];

/**
 * One role's place on the ramp.
 *
 * @remarks `chroma` multiplies the gamut ceiling at `lightness`, and the accent's own multiplier
 * applies on top of it. An omitted `alpha` is opaque.
 */
interface Role {
  lightness: number;
  chroma: number;
  alpha?: number;
}

/*
 * Lightness 0.70 in dark and 0.52 in light because blue runs out of gamut early: above 0.77 every
 * blue washes out to a maximum chroma near 0.12, while at 0.70 the same hues hold 0.16.
 */

const DARK_ROLES: Readonly<Record<Exclude<AccentTokenName, 'accentText'>, Role>> = {
  accent: { lightness: 0.7, chroma: 1 },
  focus: { lightness: 0.8, chroma: 0.75 },
  selection: { lightness: 0.7, chroma: 1 },
  selectionFill: { lightness: 0.7, chroma: 1, alpha: 0.2 },
  blobFill: { lightness: 0.45, chroma: 1, alpha: 0.35 },
  blobFillSelected: { lightness: 0.55, chroma: 1, alpha: 0.5 },
  blobBounds: { lightness: 0.82, chroma: 0.5 },
};

const LIGHT_ROLES: Readonly<Record<Exclude<AccentTokenName, 'accentText'>, Role>> = {
  accent: { lightness: 0.52, chroma: 1 },
  focus: { lightness: 0.52, chroma: 1 },
  selection: { lightness: 0.52, chroma: 1 },
  selectionFill: { lightness: 0.52, chroma: 1, alpha: 0.15 },
  blobFill: { lightness: 0.52, chroma: 1, alpha: 0.14 },
  blobFillSelected: { lightness: 0.52, chroma: 1, alpha: 0.28 },
  blobBounds: { lightness: 0.45, chroma: 0.7 },
};

/**
 * Every accent-derived colour for one accent on one ground.
 *
 * @remarks `accentText` is a constant per theme rather than a computed value, because the fixed
 * role lightness makes it resolve the same way for all eight accents.
 */
export function accentTokens(
  name: AccentName,
  dark: boolean,
): Readonly<Record<AccentTokenName, string>> {
  const accent = ACCENTS[name];
  const roles = dark ? DARK_ROLES : LIGHT_ROLES;
  const resolved = {} as Record<AccentTokenName, string>;
  for (const token of ACCENT_TOKENS) {
    if (token === 'accentText') {
      resolved[token] = dark ? '#000000' : '#ffffff';
      continue;
    }
    const role = roles[token];
    const chroma = maxChroma(role.lightness, accent.hue) * role.chroma * accent.chroma;
    resolved[token] = oklchToHex(role.lightness, chroma, accent.hue, role.alpha);
  }
  return resolved;
}

/**
 * Largest chroma an OKLCH lightness and hue can take inside sRGB.
 *
 * @remarks Found by bisection rather than in closed form; the sRGB boundary in OKLCH has no
 * simple analytic solution, and the search converges well inside a display step.
 */
export function maxChroma(lightness: number, hue: number): number {
  let low = 0;
  let high = 0.4;
  for (let step = 0; step < 32; step += 1) {
    const middle = (low + high) / 2;
    if (inGamut(lightness, middle, hue)) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * An OKLCH colour as `#rrggbb`, or `#rrggbbaa` when an alpha is given.
 *
 * @remarks Out-of-gamut components are clipped per channel. Pair it with `maxChroma` to stay
 * inside the gamut rather than relying on the clip.
 */
export function oklchToHex(lightness: number, chroma: number, hue: number, alpha?: number): string {
  const radians = (hue * Math.PI) / 180;
  const linear = oklabToLinearRgb(
    lightness,
    chroma * Math.cos(radians),
    chroma * Math.sin(radians),
  );
  const channels = linear.map((value) => byte(gammaEncode(value)));
  if (alpha !== undefined) {
    channels.push(byte(alpha));
  }
  return `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * WCAG contrast ratio between two opaque `#rrggbb` colours, from 1 to 21.
 *
 * @remarks An alpha suffix is ignored rather than composited, so pass the colours as they land
 * on screen.
 */
export function contrastRatio(first: string, second: string): number {
  const one = relativeLuminance(first);
  const other = relativeLuminance(second);
  return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
}

/**
 * How far apart two `#rrggbb` colours look, as an OKLab distance.
 *
 * @remarks Contrast ratio answers whether text on a colour is readable; it does not answer
 * whether two colours beside each other are telling apart. OKLab is near enough perceptually
 * uniform for that, so a plain distance in it is the measure. Roughly, 0.02 is where a large
 * area starts to read as a different colour at all.
 */
export function perceptualDistance(first: string, second: string): number {
  const [l1, a1, b1] = oklabOf(first);
  const [l2, a2, b2] = oklabOf(second);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Oklab coordinates of a `#rrggbb` colour. */
function oklabOf(color: string): [number, number, number] {
  const digits = color.replace('#', '');
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    gammaDecode(parseInt(digits.slice(offset, offset + 2), 16) / 255),
  ) as [number, number, number];
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  ];
}

/** Whether an OKLCH colour lands inside sRGB, within a rounding step. */
function inGamut(lightness: number, chroma: number, hue: number): boolean {
  const radians = (hue * Math.PI) / 180;
  const linear = oklabToLinearRgb(
    lightness,
    chroma * Math.cos(radians),
    chroma * Math.sin(radians),
  );
  return linear.every((value) => value >= -EPSILON && value <= 1 + EPSILON);
}

/** Tolerance on the gamut test, well under one eight-bit step. */
const EPSILON = 1e-6;

/** Oklab to linear sRGB, on Ottosson's published matrices. */
function oklabToLinearRgb(lightness: number, a: number, b: number): [number, number, number] {
  const longRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mediumRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const shortRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const long = longRoot ** 3;
  const medium = mediumRoot ** 3;
  const short = shortRoot ** 3;
  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
}

function gammaEncode(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function gammaDecode(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function byte(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

function relativeLuminance(color: string): number {
  const digits = color.replace('#', '');
  const channels = [0, 2, 4].map((offset) =>
    gammaDecode(parseInt(digits.slice(offset, offset + 2), 16) / 255),
  );
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}
