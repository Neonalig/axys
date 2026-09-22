// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DSP quality properties of the real compiled core, measured over the generated
 * fixtures.
 *
 * Every bullet under "DSP fixtures" in `docs/testing.md` has a test here. Ground truth
 * is the synthesis in `fixtures/generate.mjs`, not a recorded expectation, so a
 * regeneration that changes a fixture also changes what these assert against. Nothing
 * is mocked: the pitch track comes from `analyse`, the audio from `PlaybackRenderer`
 * and the export figures from `Session.exportWav`.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  analyseFixture,
  correlation,
  decodeWavBytes,
  loadTestCore,
  measureF0,
  medianMidi,
  peak,
  rms,
  type AnalysedFixture,
  type TestCore,
} from './helpers/core';

/** Analysis hop the core runs at, in seconds; `docs/testing.md` quotes 5 ms. */
const HOP = 0.005;

/** One voiced analysis frame. */
interface VoicedFrame {
  /** Frame centre in source seconds. */
  time: number;
  /** Fractional MIDI at A4 = 440 Hz. */
  midi: number;
}

/** Voiced frames of an analysis whose centres fall inside `[from, to]`. */
function voicedBetween(fixture: AnalysedFixture, from: number, to: number): VoicedFrame[] {
  const times = fixture.analysis.times();
  const midi = fixture.analysis.midi();
  const frames: VoicedFrame[] = [];
  for (let i = 0; i < times.length; i += 1) {
    const time = times[i];
    const value = midi[i];
    if (time === undefined || value === undefined) continue;
    if (time >= from && time <= to && Number.isFinite(value)) frames.push({ time, midi: value });
  }
  return frames;
}

/** How many frames of an analysis fall inside `[from, to]`, and how many are voiced. */
function voicingCounts(fixture: AnalysedFixture, from: number, to: number): [number, number] {
  const times = fixture.analysis.times();
  const midi = fixture.analysis.midi();
  let total = 0;
  let voiced = 0;
  for (let i = 0; i < times.length; i += 1) {
    const time = times[i];
    const value = midi[i];
    if (time === undefined || value === undefined) continue;
    if (time < from || time > to) continue;
    total += 1;
    if (Number.isFinite(value)) voiced += 1;
  }
  return [total, voiced];
}

/** Largest absolute sample-to-sample step in a buffer. */
function maxStep(samples: ArrayLike<number>): number {
  let largest = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const step = Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0));
    if (step > largest) largest = step;
  }
  return largest;
}

/** Short-window RMS envelope, one value per `window` samples. */
function envelope(samples: Float32Array, window: number): number[] {
  const out: number[] = [];
  for (let at = 0; at + window <= samples.length; at += window) {
    out.push(rms(samples.subarray(at, at + window)));
  }
  return out;
}

/** Centre seconds of each run of envelope values above `threshold`. */
function burstTimes(env: number[], window: number, rate: number, threshold: number): number[] {
  const times: number[] = [];
  let runStart = -1;
  for (let i = 0; i <= env.length; i += 1) {
    const above = i < env.length && (env[i] ?? 0) > threshold;
    if (above && runStart < 0) runStart = i;
    if (!above && runStart >= 0) {
      times.push((((runStart + i) / 2) * window) / rate);
      runStart = -1;
    }
  }
  return times;
}

/** Moving average over an odd `width` samples, clamped at both ends. */
function movingAverage(values: number[], width: number): number[] {
  const half = width >> 1;
  return values.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let k = -half; k <= half; k += 1) {
      const value = values[i + k];
      if (value !== undefined) {
        sum += value;
        count += 1;
      }
    }
    return count === 0 ? 0 : sum / count;
  });
}

/** Mean of a list, or 0 when empty. */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Builds the JSON for a `RenderPlan` that shifts pitch and time by fixed amounts. */
function uniformPlan(options: {
  /** Render sample rate in Hz. */
  sampleRate: number;
  /** Source duration in seconds. */
  duration: number;
  /** Frequency multiplier held across the whole source. */
  ratio: number;
  /** Output seconds per source second; 1.4 expands time by 1.4x. */
  stretch: number;
}): string {
  const { sampleRate, duration, ratio, stretch } = options;
  return JSON.stringify({
    sampleRate,
    timeMap: {
      points: [
        [0, 0],
        [duration * stretch, duration],
      ],
    },
    pitchRatio: { start: 0, hop: duration, values: [ratio, ratio] },
    formant: 'preserve',
  });
}

/** What `Session.lastExportReport` returns. */
interface ExportReport {
  /** Frames written per channel. */
  frames: number;
  /** Largest input magnitude seen, before clamping. */
  peak: number;
  /** Samples that exceeded the representable range and were clamped. */
  clippedSamples: number;
}

describe('DSP quality over the generated fixtures', () => {
  let core: TestCore;

  beforeAll(async () => {
    core = await loadTestCore();
  });

  describe('F0 accuracy', () => {
    let vowel: AnalysedFixture;
    let slide: AnalysedFixture;

    beforeAll(async () => {
      vowel = await analyseFixture('sustained-vowel.wav');
      slide = await analyseFixture('slide.wav');
    });

    it('detects the sustained C4 within 5 cents of the synthesised value', () => {
      // generate.mjs writes sustained-vowel.wav as a flat MIDI 60 over 2 s with a 30 ms
      // attack and 60 ms release; 0.2..1.8 s is the span the envelope leaves steady.
      const frames = voicedBetween(vowel, 0.2, 1.8);
      expect(frames.length).toBeGreaterThan(300);
      // docs/testing.md: within 5 cents.
      expect(Math.abs(medianMidi(frames.map((f) => f.midi)) - 60) * 100).toBeLessThan(5);
    });

    it('holds every steady frame of the sustained vowel inside the same 5 cents', () => {
      const frames = voicedBetween(vowel, 0.2, 1.8);
      let worst = 0;
      for (const frame of frames) worst = Math.max(worst, Math.abs(frame.midi - 60) * 100);
      // The per-frame bound is the same 5 cents rather than a looser one: the fixture is
      // a stationary tone, so any frame that misses by more than the documented accuracy
      // is a detector fault and not envelope movement.
      expect(worst).toBeLessThan(5);
    });

    it('tracks the octave glissando within 20 cents and never steps backwards', () => {
      // generate.mjs writes slide.wav as MIDI 55 + 12 * (t / 2), so 6 semitones a second
      // over 2 s. 0.15..1.85 s excludes the attack and release the envelope imposes.
      const frames = voicedBetween(slide, 0.15, 1.85);
      expect(frames.length).toBeGreaterThan(300);
      let worst = 0;
      for (const frame of frames) {
        worst = Math.max(worst, Math.abs(frame.midi - (55 + 6 * frame.time)) * 100);
      }
      // docs/testing.md: within 20 cents.
      expect(worst).toBeLessThan(20);

      let backStep = 0;
      for (let i = 1; i < frames.length; i += 1) {
        const previous = frames[i - 1];
        const current = frames[i];
        if (previous === undefined || current === undefined) continue;
        backStep = Math.min(backStep, current.midi - previous.midi);
      }
      // "Monotone" is asserted with a 5 cent slack, not exactly: the glissando rises
      // 3 cents per 5 ms hop, so quantisation of the detector's own estimate can put two
      // neighbouring frames in the wrong order without the track being non-monotone in
      // any audible sense. A real octave jump or a stuck region is orders of magnitude
      // larger than this.
      expect(backStep * 100).toBeGreaterThan(-5);
    });
  });

  describe('modulation', () => {
    let vibrato: AnalysedFixture;
    let drift: AnalysedFixture;

    beforeAll(async () => {
      vibrato = await analyseFixture('vibrato.wav');
      drift = await analyseFixture('drift.wav');
    });

    it('measures the vibrato depth within 15 percent of the synthesised depth', () => {
      // generate.mjs writes vibrato.wav as MIDI 64 with 0.55 semitones of 5.5 Hz vibrato
      // from t = 0.35 s. 0.5..2.3 s is whole cycles inside the steady part of the envelope.
      const frames = voicedBetween(vibrato, 0.5, 2.3);
      expect(frames.length).toBeGreaterThan(300);
      const centre = mean(frames.map((f) => f.midi));
      const ac = frames.map((f) => f.midi - centre);
      // Amplitude from RMS rather than peak to peak: for a sinusoid the two agree, but a
      // single mis-detected frame moves a peak-to-peak reading and does not move this one.
      const depth = Math.SQRT2 * rms(ac);
      // docs/testing.md: within 15 percent of the synthesised depth.
      expect(Math.abs(depth - 0.55) / 0.55).toBeLessThan(0.15);
    });

    it('tracks the slow drift and does not read it as vibrato', () => {
      // generate.mjs writes drift.wav as MIDI 57 + 0.9 * sin(2*pi*0.35*t) + 0.4 * t over
      // 3 s, so all of its movement sits at 0.35 Hz, well under the 3 Hz split that
      // ModulationSettings uses to separate drift from vibrato.
      const frames = voicedBetween(drift, 0.2, 2.8);
      expect(frames.length).toBeGreaterThan(400);
      const model = frames.map(
        (f) => 57 + 0.9 * Math.sin(2 * Math.PI * 0.35 * f.time) + 0.4 * f.time,
      );
      const detected = frames.map((f) => f.midi);
      expect(correlation(detected, model)).toBeGreaterThan(0.99);
      let worst = 0;
      for (let i = 0; i < frames.length; i += 1) {
        const value = detected[i];
        const expected = model[i];
        if (value === undefined || expected === undefined) continue;
        worst = Math.max(worst, Math.abs(value - expected) * 100);
      }
      // 20 cents, the same bound docs/testing.md sets for the glissando: this fixture is
      // also a continuously moving contour, so it is the detector's moving-pitch accuracy
      // being measured, not its steady-tone accuracy.
      expect(worst).toBeLessThan(20);

      // Split the contour at 3 Hz with a boxcar one third of a second wide and compare
      // the two halves. Reading drift as vibrato would put the fixture's 0.9 semitone
      // movement above the split instead of below it.
      const width = (Math.round(1 / 3 / HOP) | 1) + 0;
      const low = movingAverage(detected, width);
      const lowCentre = mean(low);
      const lowEnergy = rms(low.map((v) => v - lowCentre));
      const highEnergy = rms(detected.map((v, i) => v - (low[i] ?? v)));
      // A quarter, not something tighter: a boxcar is a poor lowpass, so part of the
      // 0.35 Hz drift necessarily leaks into the residual. The check that matters is that
      // the above-split component is a small fraction of the drift rather than comparable
      // to it, which is what a vibrato misreading would produce.
      expect(highEnergy).toBeLessThan(0.25 * lowEnergy);
    });
  });

  describe('octave stability', () => {
    it('keeps every frame of octave-ambiguity.wav well inside an octave of the truth', async () => {
      // generate.mjs writes octave-ambiguity.wav as a flat MIDI 40 with 24 harmonics.
      const fixture = await analyseFixture('octave-ambiguity.wav');
      const [total, voiced] = voicingCounts(fixture, 0.15, 1.85);
      expect(total).toBeGreaterThan(300);
      // Otherwise the frame check below passes by having nothing to check.
      expect(voiced / total).toBeGreaterThan(0.95);
      let worst = 0;
      for (const frame of voicedBetween(fixture, 0.15, 1.85)) {
        worst = Math.max(worst, Math.abs(frame.midi - 40));
      }
      // docs/testing.md asks that no frame land a full octave from the truth. Six
      // semitones is that requirement stated as a decision boundary: past half an octave
      // a frame is nearer the wrong octave than the right one.
      expect(worst).toBeLessThan(6);
    });
  });

  describe('voicing', () => {
    let consonants: AnalysedFixture;

    beforeAll(async () => {
      consonants = await analyseFixture('consonants.wav');
    });

    // generate.mjs concatenates consonants.wav as: 20 ms plosive, 0.5 s vowel at MIDI 62,
    // 0.22 s sibilant, 0.55 s vowel at 64, 20 ms plosive, 0.5 s vowel at 60, 0.2 s
    // sibilant, 0.15 s silence. Each span below is trimmed by 40 ms at each end, which is
    // the analysis frame length, so no frame straddles a boundary.
    const spans: { name: string; from: number; to: number; voiced: boolean }[] = [
      { name: 'first vowel', from: 0.06, to: 0.48, voiced: true },
      { name: 'first sibilant', from: 0.56, to: 0.7, voiced: false },
      { name: 'second vowel', from: 0.78, to: 1.25, voiced: true },
      { name: 'third vowel', from: 1.35, to: 1.77, voiced: true },
      { name: 'second sibilant', from: 1.85, to: 1.97, voiced: false },
      { name: 'trailing silence', from: 2.05, to: 2.14, voiced: false },
    ];

    for (const span of spans) {
      it(`classifies the ${span.name} as ${span.voiced ? 'voiced' : 'unvoiced'}`, () => {
        const [total, voiced] = voicingCounts(consonants, span.from, span.to);
        expect(total).toBeGreaterThan(10);
        // Every frame, not a majority: the spans are trimmed to the frame length, so a
        // single wrong frame inside one is a classification fault and not a boundary.
        expect(voiced).toBe(span.voiced ? total : 0);
      });
    }

    it('cannot assert the 20 ms plosives frame by frame, only that they are not voiced', () => {
      // The plosives are 20 ms, shorter than the 40 ms analysis frame, so no frame lies
      // wholly inside one and there is no frame whose classification is theirs alone.
      // The closest real property is that neither plosive turns its neighbourhood voiced.
      for (const centre of [0.01, 1.3]) {
        const [total, voiced] = voicingCounts(consonants, centre - 0.01, centre + 0.01);
        expect(total).toBeGreaterThan(0);
        expect(voiced).toBe(0);
      }
    });
  });

  describe('pitch fidelity after transformation', () => {
    let vowel: AnalysedFixture;
    let duration: number;

    beforeAll(async () => {
      vowel = await analyseFixture('sustained-vowel.wav');
      duration = vowel.samples.length / vowel.sampleRate;
    });

    for (const semitones of [3, 7, -5]) {
      it(`lands rendered F0 within 15 cents of a ${semitones > 0 ? '+' : ''}${semitones} semitone move`, async () => {
        const plan = uniformPlan({
          sampleRate: vowel.sampleRate,
          duration,
          ratio: Math.pow(2, semitones / 12),
          stretch: 1,
        });
        const renderer = core.PlaybackRenderer.create(
          vowel.samples,
          vowel.analysis.trackJson(),
          plan,
          true,
        );
        try {
          const rendered = renderer.render(0, renderer.outputFrames());
          // Re-analyse only the steady span, matching the span the source F0 test uses.
          const steady = rendered.slice(
            Math.round(0.2 * vowel.sampleRate),
            Math.round(1.8 * vowel.sampleRate),
          );
          const measured = await measureF0(steady, vowel.sampleRate);
          const landed = medianMidi(measured.midi);
          // docs/testing.md: within 15 cents of the target.
          expect(Math.abs(landed - (60 + semitones)) * 100).toBeLessThan(15);
          // A silent stub would also pass an F0 check on silence, so require audio.
          expect(rms(steady)).toBeGreaterThan(
            0.5 *
              rms(
                vowel.samples.subarray(
                  Math.round(0.2 * vowel.sampleRate),
                  Math.round(1.8 * vowel.sampleRate),
                ),
              ),
          );
        } finally {
          renderer.free();
        }
      });
    }
  });

  describe('continuity', () => {
    it('introduces no sample step larger than the source step scaled by the pitch ratio', async () => {
      const vowel = await analyseFixture('sustained-vowel.wav');
      const duration = vowel.samples.length / vowel.sampleRate;
      const ratio = Math.pow(2, 3 / 12);
      // A plan whose pitch ratio steps from 1.0 to +3 semitones half way through the
      // note: the hard edge is exactly the edit boundary the requirement is about.
      const points = 401;
      const hop = duration / (points - 1);
      const values = Array.from({ length: points }, (_, i) => (i * hop < duration / 2 ? 1 : ratio));
      const plan = JSON.stringify({
        sampleRate: vowel.sampleRate,
        timeMap: {
          points: [
            [0, 0],
            [duration, duration],
          ],
        },
        pitchRatio: { start: 0, hop, values },
        formant: 'preserve',
      });
      const renderer = core.PlaybackRenderer.create(
        vowel.samples,
        vowel.analysis.trackJson(),
        plan,
        true,
      );
      try {
        const rendered = renderer.render(0, renderer.outputFrames());
        // docs/testing.md states the bound exactly: the largest source step scaled by the
        // pitch ratio. Raising a waveform's frequency by `ratio` raises its maximum slope
        // by the same factor, so anything above this is a click and not the edit.
        expect(maxStep(rendered)).toBeLessThanOrEqual(maxStep(vowel.samples) * ratio);
        expect(peak(rendered)).toBeGreaterThan(0.05);
      } finally {
        renderer.free();
      }
    });
  });

  describe('transients', () => {
    it('keeps each plosive a single peak at the position the time map predicts', async () => {
      const consonants = await analyseFixture('consonants.wav');
      const { sampleRate } = consonants;
      const duration = consonants.samples.length / sampleRate;
      const stretch = 1.4;
      const renderer = core.PlaybackRenderer.create(
        consonants.samples,
        consonants.analysis.trackJson(),
        uniformPlan({ sampleRate, duration, ratio: 1, stretch }),
        true,
      );
      try {
        const rendered = renderer.render(0, renderer.outputFrames());
        expect(renderer.outputFrames()).toBe(Math.round(duration * stretch * sampleRate));

        const window = Math.round(0.005 * sampleRate);
        const sourceEnv = envelope(consonants.samples, window);
        const renderedEnv = envelope(rendered, window);
        // The two plosives are the only 5 ms windows in the source above 0.12 RMS; the
        // vowels sit near 0.079 and the sibilants near 0.09, so the threshold is halfway
        // between the sibilants and the 0.16 the plosives reach. Reading it off the
        // source rather than hard-coding a rendered figure keeps the test tied to the
        // fixture.
        const threshold = 0.12;
        const sourceBursts = burstTimes(sourceEnv, window, sampleRate, threshold);
        expect(sourceBursts.length).toBe(2);

        const renderedBursts = burstTimes(renderedEnv, window, sampleRate, threshold);
        // One burst per plosive: a smeared transient splits into several windows above
        // the threshold, or drops below it entirely, and either fails this.
        expect(renderedBursts.length).toBe(sourceBursts.length);
        for (let i = 0; i < sourceBursts.length; i += 1) {
          const source = sourceBursts[i];
          const landed = renderedBursts[i];
          if (source === undefined || landed === undefined) throw new Error('missing burst');
          // docs/testing.md: within 10 ms of the position the time map predicts. The
          // 5 ms envelope window puts a 2.5 ms floor under the measurement, so 10 ms is
          // roughly four times the resolution of the measurement itself.
          expect(Math.abs(landed - source * stretch) * 1000).toBeLessThan(10);
        }
      } finally {
        renderer.free();
      }
    });
  });

  describe('peak and clipping on export', () => {
    it('reports the true peak of the rendered output', async () => {
      const phrase = await analyseFixture('phrase.wav');
      const session = core.Session.create(
        phrase.samples,
        phrase.sampleRate,
        'phrase',
        phrase.analysis,
        '',
      );
      try {
        const bytes = session.exportWav(0, -1, phrase.sampleRate, 'pcm16');
        const report = JSON.parse(session.lastExportReport()) as ExportReport;
        const decoded = decodeWavBytes(bytes).samples;
        expect(report.frames).toBe(decoded.length);
        expect(report.clippedSamples).toBe(0);

        const renderer = core.PlaybackRenderer.create(
          session.source(),
          session.trackJson(),
          session.planJson(),
          true,
        );
        try {
          const rendered = renderer.render(0, renderer.outputFrames());
          // Export and a direct offline render read the same plan, so the reported peak
          // is the rendered peak exactly. Both sides go through Math.fround because the
          // report is an f32 written as its shortest decimal, which parses back to a
          // different f64 than the same f32 widened; rounding both to f32 undoes that
          // and leaves an exact comparison rather than a tolerance.
          expect(Math.fround(report.peak)).toBe(Math.fround(peak(rendered)));
        } finally {
          renderer.free();
        }
        // The decoded file cannot exceed the reported peak by more than one 16-bit step.
        expect(peak(decoded)).toBeLessThanOrEqual(report.peak + 1 / 32768);
      } finally {
        session.free();
      }
    });

    it('reports clipping rather than wrapping when the render exceeds full scale', async () => {
      const phrase = await analyseFixture('phrase.wav');
      // phrase.wav peaks near 0.27, so five times it renders past full scale. Scaling the
      // source is the only way to reach clipping through the public API: every edit
      // operation moves pitch or time, none of them sets a gain.
      const hot = phrase.samples.map((value) => value * 5);
      const analysis = core.analyse(hot, phrase.sampleRate, '');
      const session = core.Session.create(hot, phrase.sampleRate, 'hot', analysis, '');
      try {
        const bytes = session.exportWav(0, -1, phrase.sampleRate, 'pcm16');
        const report = JSON.parse(session.lastExportReport()) as ExportReport;
        expect(report.peak).toBeGreaterThan(1);
        expect(report.clippedSamples).toBeGreaterThan(0);

        const decoded = decodeWavBytes(bytes).samples;
        // Clamped, not wrapped: a wrap turns the loudest positive samples into large
        // negative ones, which would leave the file peaking at full scale on both signs
        // with a sign flip inside the loud spans. Clamping leaves it at full scale and
        // nothing beyond.
        expect(peak(decoded)).toBeLessThanOrEqual(1);
        let flips = 0;
        for (let i = 1; i < decoded.length; i += 1) {
          const previous = decoded[i - 1] ?? 0;
          const current = decoded[i] ?? 0;
          if (Math.abs(previous) > 0.98 && Math.abs(current) > 0.98 && previous * current < 0) {
            flips += 1;
          }
        }
        expect(flips).toBe(0);
      } finally {
        session.free();
        analysis.free();
      }
    });
  });

  describe('determinism', () => {
    let vowel: AnalysedFixture;
    let plan: string;

    beforeAll(async () => {
      vowel = await analyseFixture('sustained-vowel.wav');
      const duration = vowel.samples.length / vowel.sampleRate;
      // A plan that both moves pitch and stretches time, so the check covers the grain
      // scheduler and not only a passthrough.
      plan = JSON.stringify({
        sampleRate: vowel.sampleRate,
        timeMap: {
          points: [
            [0, 0],
            [duration * 1.25, duration],
          ],
        },
        pitchRatio: { start: 0, hop: duration / 2, values: [1, 1.12, 0.94] },
        formant: 'preserve',
      });
    });

    it('renders the same plan bit-identically twice', () => {
      const first = core.PlaybackRenderer.create(
        vowel.samples,
        vowel.analysis.trackJson(),
        plan,
        true,
      );
      const second = core.PlaybackRenderer.create(
        vowel.samples,
        vowel.analysis.trackJson(),
        plan,
        true,
      );
      try {
        const frames = first.outputFrames();
        expect(second.outputFrames()).toBe(frames);
        const a = first.render(0, frames);
        const b = second.render(0, frames);
        // Bit-identical, so an exact comparison rather than a tolerance.
        expect(Array.from(b)).toEqual(Array.from(a));
        expect(rms(a)).toBeGreaterThan(0.01);
      } finally {
        first.free();
        second.free();
      }
    });

    it('renders block by block bit-identically to one call', () => {
      const renderer = core.PlaybackRenderer.create(
        vowel.samples,
        vowel.analysis.trackJson(),
        plan,
        true,
      );
      try {
        const frames = renderer.outputFrames();
        const whole = renderer.render(0, frames);
        const split = new Float32Array(frames);
        // Deliberately uneven blocks, including sizes that are not a power of two and do
        // not divide the grain hop, so a renderer that only happens to work on 128-sample
        // boundaries fails here.
        const sizes = [128, 512, 37, 1024, 5];
        let at = 0;
        let i = 0;
        while (at < frames) {
          const size = sizes[i % sizes.length] ?? 128;
          const length = Math.min(size, frames - at);
          split.set(renderer.render(at, length), at);
          at += length;
          i += 1;
        }
        expect(Array.from(split)).toEqual(Array.from(whole));
      } finally {
        renderer.free();
      }
    });
  });
});
