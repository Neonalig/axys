// SPDX-License-Identifier: AGPL-3.0-or-later

/** Base bucket width in samples of the finest stored peak level. */
const BASE_BUCKET = 256;

/** Fraction of a bucket a column edge may be off by and still count as on the bucket edge. */
const BUCKET_TOLERANCE = 1e-6;

/** Ratio between successive peak levels. */
const LEVEL_RATIO = 4;

/** Smallest bucket count a coarser level is still worth storing at. */
const MIN_LEVEL_BUCKETS = 32;

/** One resolution of a peak envelope. */
interface PeakLevel {
  samplesPerBucket: number;
  min: Float32Array;
  max: Float32Array;
}

/** Minimum and maximum sample value per screen column. */
export interface PeakSpan {
  /** Column count actually filled. */
  count: number;
  min: Float32Array;
  max: Float32Array;
}

/**
 * Multi-resolution minimum and maximum envelope of the source PCM.
 *
 * @remarks Built once per source. Sampling a span picks the coarsest level that still has at
 * least one bucket per requested column, so the cost of a waveform frame is bounded by the
 * canvas width rather than by the file length.
 */
export class PeakEnvelope {
  readonly sampleRate: number;
  readonly frames: number;
  readonly #levels: readonly PeakLevel[];
  #scratchMin = new Float32Array(0);
  #scratchMax = new Float32Array(0);

  private constructor(sampleRate: number, frames: number, levels: readonly PeakLevel[]) {
    this.sampleRate = sampleRate;
    this.frames = frames;
    this.#levels = levels;
  }

  /** Total source duration in seconds. */
  get duration(): number {
    return this.sampleRate > 0 ? this.frames / this.sampleRate : 0;
  }

  /** Builds every resolution from mono source samples. */
  static build(samples: Float32Array, sampleRate: number): PeakEnvelope {
    const levels: PeakLevel[] = [];
    const baseBuckets = Math.max(1, Math.ceil(samples.length / BASE_BUCKET));
    const baseMin = new Float32Array(baseBuckets);
    const baseMax = new Float32Array(baseBuckets);
    for (let bucket = 0; bucket < baseBuckets; bucket += 1) {
      const start = bucket * BASE_BUCKET;
      const end = Math.min(samples.length, start + BASE_BUCKET);
      let low = 0;
      let high = 0;
      for (let i = start; i < end; i += 1) {
        const value = samples[i] ?? 0;
        if (value < low) {
          low = value;
        }
        if (value > high) {
          high = value;
        }
      }
      baseMin[bucket] = low;
      baseMax[bucket] = high;
    }
    levels.push({ samplesPerBucket: BASE_BUCKET, min: baseMin, max: baseMax });

    let previous = levels[0];
    while (previous !== undefined && previous.min.length > MIN_LEVEL_BUCKETS * LEVEL_RATIO) {
      const source = previous;
      const buckets = Math.ceil(source.min.length / LEVEL_RATIO);
      const min = new Float32Array(buckets);
      const max = new Float32Array(buckets);
      for (let bucket = 0; bucket < buckets; bucket += 1) {
        const start = bucket * LEVEL_RATIO;
        const end = Math.min(source.min.length, start + LEVEL_RATIO);
        let low = 0;
        let high = 0;
        for (let i = start; i < end; i += 1) {
          const lowValue = source.min[i] ?? 0;
          const highValue = source.max[i] ?? 0;
          if (lowValue < low) {
            low = lowValue;
          }
          if (highValue > high) {
            high = highValue;
          }
        }
        min[bucket] = low;
        max[bucket] = high;
      }
      const level: PeakLevel = {
        samplesPerBucket: source.samplesPerBucket * LEVEL_RATIO,
        min,
        max,
      };
      levels.push(level);
      previous = level;
    }
    return new PeakEnvelope(sampleRate, samples.length, levels);
  }

  /**
   * Fills one minimum and maximum pair per column across a time span.
   *
   * @remarks The returned arrays are owned by the envelope and are overwritten by the next call,
   * so a frame must consume them before sampling again. Columns outside the source read as
   * silence.
   */
  sample(start: number, end: number, columns: number): PeakSpan {
    const count = Math.max(0, Math.floor(columns));
    if (this.#scratchMin.length < count) {
      this.#scratchMin = new Float32Array(count);
      this.#scratchMax = new Float32Array(count);
    }
    const min = this.#scratchMin;
    const max = this.#scratchMax;
    min.fill(0, 0, count);
    max.fill(0, 0, count);
    if (count === 0 || !(end > start) || this.sampleRate <= 0) {
      return { count, min, max };
    }

    const samplesPerColumn = ((end - start) * this.sampleRate) / count;
    const level = this.#levelFor(samplesPerColumn);
    if (level === undefined) {
      return { count, min, max };
    }
    const buckets = level.min.length;
    for (let column = 0; column < count; column += 1) {
      const columnStart = start + ((end - start) * column) / count;
      const columnEnd = start + ((end - start) * (column + 1)) / count;
      // A column edge on a bucket edge is common once zoomed in. The tolerance keeps rounding
      // noise in the edge from taking the neighbouring bucket in on one frame and not the next.
      const firstBucket = Math.floor(
        (columnStart * this.sampleRate) / level.samplesPerBucket + BUCKET_TOLERANCE,
      );
      const lastBucket = Math.ceil(
        (columnEnd * this.sampleRate) / level.samplesPerBucket - BUCKET_TOLERANCE,
      );
      let low = 0;
      let high = 0;
      for (
        let bucket = Math.max(0, firstBucket);
        bucket < Math.min(buckets, lastBucket);
        bucket += 1
      ) {
        const lowValue = level.min[bucket] ?? 0;
        const highValue = level.max[bucket] ?? 0;
        if (lowValue < low) {
          low = lowValue;
        }
        if (highValue > high) {
          high = highValue;
        }
      }
      min[column] = low;
      max[column] = high;
    }
    return { count, min, max };
  }

  #levelFor(samplesPerColumn: number): PeakLevel | undefined {
    let chosen = this.#levels[0];
    for (const level of this.#levels) {
      if (level.samplesPerBucket <= samplesPerColumn * (1 + BUCKET_TOLERANCE)) {
        chosen = level;
      }
    }
    return chosen;
  }
}

const cache = new Map<string, PeakEnvelope>();

/**
 * Builds a peak envelope and keeps it against the source fingerprint.
 *
 * @remarks The cache holds derived data for every source of the open project, one envelope per
 * fingerprint, until {@link clearPeaks} closes it.
 */
export function buildPeaks(
  samples: Float32Array,
  sampleRate: number,
  fingerprint: string,
): PeakEnvelope {
  const envelope = PeakEnvelope.build(samples, sampleRate);
  cache.set(fingerprint, envelope);
  return envelope;
}

/** The cached envelope for a source fingerprint, if one has been built. */
export function peaksFor(fingerprint: string | null | undefined): PeakEnvelope | null {
  if (fingerprint === null || fingerprint === undefined) {
    return null;
  }
  return cache.get(fingerprint) ?? null;
}

/** Drops the envelope kept for one source fingerprint. */
export function dropPeaks(fingerprint: string): void {
  cache.delete(fingerprint);
}

/** Drops every cached envelope, for closing a project. */
export function clearPeaks(): void {
  cache.clear();
}
