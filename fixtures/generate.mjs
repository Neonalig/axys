// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Generates the Axys test fixtures.
 *
 * Everything here is synthesised, so the fixtures carry no third-party rights and
 * are redistributable under the project licence. Run with `node fixtures/generate.mjs`.
 * Output is deterministic: the same script always writes byte-identical files.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const audioDir = resolve(here, 'audio');
const midiDir = resolve(here, 'midi');
mkdirSync(audioDir, { recursive: true });
mkdirSync(midiDir, { recursive: true });

const RATE = 48000;

/** Deterministic pseudo-random noise, so fixtures never change between runs. */
function makeNoise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0x100000000) * 2 - 1;
  };
}

/** Converts a MIDI note number to Hz at A4 = 440. */
function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Synthesises a voice-like tone by summing harmonics under a fixed formant envelope,
 * with the fundamental following `pitchAt` and the level following `gainAt`.
 */
function voice(seconds, pitchAt, gainAt, harmonics = 12) {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  // Two broad resonances near 700 Hz and 1200 Hz read as an "ah" vowel.
  const formants = [
    { hz: 700, q: 90 },
    { hz: 1220, q: 110 },
    { hz: 2600, q: 160 },
  ];
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const f0 = midiToHz(pitchAt(t));
    phase += (2 * Math.PI * f0) / RATE;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    let sample = 0;
    for (let h = 1; h <= harmonics; h += 1) {
      const hz = f0 * h;
      if (hz > RATE / 2 - 1000) break;
      let amp = 1 / h;
      let shaped = 0;
      for (const f of formants) {
        shaped += 1 / (1 + Math.pow((hz - f.hz) / f.q, 2));
      }
      amp *= 0.25 + shaped;
      sample += amp * Math.sin(phase * h);
    }
    out[i] = sample * gainAt(t) * 0.16;
  }
  return out;
}

/** Fades the first and last `seconds` of a buffer so fixtures never click. */
function fade(buffer, seconds = 0.01) {
  const n = Math.min(Math.round(seconds * RATE), Math.floor(buffer.length / 2));
  for (let i = 0; i < n; i += 1) {
    const g = i / n;
    buffer[i] *= g;
    buffer[buffer.length - 1 - i] *= g;
  }
  return buffer;
}

/** Joins buffers end to end. */
function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A buffer of silence. */
function silence(seconds) {
  return new Float32Array(Math.round(seconds * RATE));
}

/** Band-limited noise shaped like a sibilant. */
function sibilant(seconds, seed) {
  const rand = makeNoise(seed);
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  let hp = 0;
  for (let i = 0; i < n; i += 1) {
    const raw = rand();
    // One-pole high-pass pushes the energy up where a /s/ lives.
    hp = 0.92 * (hp + raw - (out[i - 1] ?? 0));
    out[i] = hp * 0.09;
  }
  return fade(out, 0.004);
}

/** A short broadband burst shaped like a plosive. */
function plosive(seed) {
  const rand = makeNoise(seed);
  const n = Math.round(0.02 * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = rand() * 0.5 * Math.exp((-i / n) * 6);
  }
  return out;
}

/** Writes 16-bit PCM mono WAV. */
function writeWav(path, samples) {
  const header = Buffer.alloc(44);
  const bytes = samples.length * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(bytes, 40);
  const body = Buffer.alloc(bytes);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    body.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  writeFileSync(path, Buffer.concat([header, body]));
  console.info(`  ${path.replace(here, 'fixtures')}  ${(bytes / 1024).toFixed(0)} kB`);
}

const flat = (m) => () => m;
const level = (v) => () => v;
/** An attack-sustain-release gain envelope over `seconds`. */
const env =
  (seconds, attack = 0.03, release = 0.06) =>
  (t) => {
    if (t < attack) return t / attack;
    if (t > seconds - release) return Math.max(0, (seconds - t) / release);
    return 1;
  };

console.info('\nGenerating Axys fixtures\n');
console.info('Audio');

writeWav(join(audioDir, 'sustained-vowel.wav'), fade(voice(2, flat(60), env(2))));

writeWav(
  join(audioDir, 'vibrato.wav'),
  fade(
    voice(
      2.5,
      (t) => 64 + (t > 0.35 ? 0.55 * Math.sin(2 * Math.PI * 5.5 * (t - 0.35)) : 0),
      env(2.5),
    ),
  ),
);

writeWav(
  join(audioDir, 'drift.wav'),
  fade(voice(3, (t) => 57 + 0.9 * Math.sin(2 * Math.PI * 0.35 * t) + 0.4 * t, env(3))),
);

writeWav(
  join(audioDir, 'scoop-and-fall.wav'),
  fade(
    voice(
      2.4,
      (t) => {
        if (t < 0.18) return 62 - 3 * (1 - t / 0.18);
        if (t > 2.05) return 62 - 4 * ((t - 2.05) / 0.35);
        return 62;
      },
      env(2.4),
    ),
  ),
);

writeWav(join(audioDir, 'slide.wav'), fade(voice(2, (t) => 55 + 12 * (t / 2), env(2))));

writeWav(
  join(audioDir, 'rapid-transitions.wav'),
  concat(
    [60, 64, 67, 64, 62, 59, 60, 67].map((m) =>
      fade(voice(0.16, flat(m), env(0.16, 0.012, 0.03)), 0.006),
    ),
  ),
);

writeWav(
  join(audioDir, 'breathy.wav'),
  (() => {
    const tone = voice(2.2, (t) => 61 + 0.25 * Math.sin(2 * Math.PI * 4.2 * t), env(2.2), 6);
    const rand = makeNoise(4242);
    const out = new Float32Array(tone.length);
    for (let i = 0; i < tone.length; i += 1) {
      out[i] = (tone[i] ?? 0) * 0.62 + rand() * 0.035 * env(2.2)(i / RATE);
    }
    return fade(out);
  })(),
);

writeWav(
  join(audioDir, 'consonants.wav'),
  concat([
    plosive(11),
    fade(voice(0.5, flat(62), env(0.5))),
    sibilant(0.22, 77),
    fade(voice(0.55, flat(64), env(0.55))),
    plosive(23),
    fade(voice(0.5, flat(60), env(0.5))),
    sibilant(0.2, 91),
    silence(0.15),
  ]),
);

writeWav(join(audioDir, 'octave-ambiguity.wav'), fade(voice(2, flat(40), env(2), 24)));

writeWav(
  join(audioDir, 'low-confidence.wav'),
  (() => {
    const tone = voice(1.8, flat(58), level(0.35), 5);
    const rand = makeNoise(9090);
    const out = new Float32Array(tone.length);
    for (let i = 0; i < tone.length; i += 1) out[i] = (tone[i] ?? 0) * 0.3 + rand() * 0.09;
    return fade(out);
  })(),
);

writeWav(
  join(audioDir, 'phrase.wav'),
  concat([
    silence(0.1),
    fade(voice(0.45, flat(60), env(0.45))),
    silence(0.05),
    fade(voice(0.45, flat(62), env(0.45))),
    silence(0.05),
    sibilant(0.12, 31),
    fade(voice(0.6, flat(64), env(0.6))),
    silence(0.06),
    fade(
      voice(0.9, (t) => 65 + (t > 0.3 ? 0.4 * Math.sin(2 * Math.PI * 5 * (t - 0.3)) : 0), env(0.9)),
    ),
    silence(0.15),
  ]),
);

console.info('\nMIDI');

/** Encodes a MIDI variable-length quantity. */
function vlq(value) {
  const bytes = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

/** Builds a Standard MIDI File from track event lists. */
function buildSmf(ppq, tracks) {
  const chunks = [];
  const header = Buffer.alloc(14);
  header.write('MThd', 0, 'ascii');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(tracks.length > 1 ? 1 : 0, 8);
  header.writeUInt16BE(tracks.length, 10);
  header.writeUInt16BE(ppq, 12);
  chunks.push(header);
  for (const events of tracks) {
    const body = [];
    for (const e of events) body.push(...vlq(e.delta), ...e.bytes);
    body.push(...vlq(0), 0xff, 0x2f, 0x00);
    const track = Buffer.alloc(8 + body.length);
    track.write('MTrk', 0, 'ascii');
    track.writeUInt32BE(body.length, 4);
    Buffer.from(body).copy(track, 8);
    chunks.push(track);
  }
  return Buffer.concat(chunks);
}

/** A set-tempo meta event in microseconds per quarter note. */
function tempo(delta, bpm) {
  const us = Math.round(60000000 / bpm);
  return { delta, bytes: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] };
}

/** A time-signature meta event. */
function meter(delta, num, den) {
  const dd = Math.log2(den);
  return { delta, bytes: [0xff, 0x58, 0x04, num, dd, 24, 8] };
}

/** A track-name meta event. */
function trackName(name) {
  const b = Buffer.from(name, 'ascii');
  return { delta: 0, bytes: [0xff, 0x03, b.length, ...b] };
}

/** Turns a note list into ordered note-on and note-off events. */
function notes(list, channel = 0) {
  const events = [];
  for (const n of list) {
    events.push({ at: n.start, bytes: [0x90 | channel, n.key, n.velocity ?? 96] });
    events.push({ at: n.start + n.length, bytes: [0x80 | channel, n.key, 0] });
  }
  events.sort((a, b) => a.at - b.at);
  let last = 0;
  return events.map((e) => {
    const delta = e.at - last;
    last = e.at;
    return { delta, bytes: e.bytes };
  });
}

const PPQ = 480;

function writeMidi(name, buffer) {
  const path = join(midiDir, name);
  writeFileSync(path, buffer);
  console.info(`  ${path.replace(here, 'fixtures')}  ${buffer.length} bytes`);
}

writeMidi(
  'melody.mid',
  buildSmf(PPQ, [
    [
      trackName('Melody'),
      tempo(0, 120),
      meter(0, 4, 4),
      ...notes([
        { start: 0, length: PPQ, key: 60 },
        { start: PPQ, length: PPQ, key: 62 },
        { start: PPQ * 2, length: PPQ, key: 64 },
        { start: PPQ * 3, length: PPQ * 2, key: 65 },
      ]),
    ],
  ]),
);

writeMidi(
  'tempo-change.mid',
  buildSmf(PPQ, [
    [
      trackName('Conductor'),
      tempo(0, 120),
      meter(0, 4, 4),
      tempo(PPQ * 4, 90),
      tempo(PPQ * 4, 140),
    ],
    [
      trackName('Melody'),
      ...notes([
        { start: 0, length: PPQ, key: 60 },
        { start: PPQ * 2, length: PPQ, key: 64 },
        { start: PPQ * 4, length: PPQ, key: 67 },
        { start: PPQ * 8, length: PPQ * 2, key: 72 },
      ]),
    ],
  ]),
);

writeMidi(
  'meter-change.mid',
  buildSmf(PPQ, [
    [
      trackName('Conductor'),
      tempo(0, 100),
      meter(0, 4, 4),
      meter(PPQ * 4, 3, 4),
      meter(PPQ * 3, 7, 8),
    ],
    [
      trackName('Melody'),
      ...notes([
        { start: 0, length: PPQ * 4, key: 60 },
        { start: PPQ * 4, length: PPQ * 3, key: 62 },
        { start: PPQ * 7, length: PPQ * 2, key: 64 },
      ]),
    ],
  ]),
);

writeMidi(
  'pickup.mid',
  buildSmf(PPQ, [
    [
      trackName('Pickup'),
      tempo(0, 120),
      meter(0, 4, 4),
      ...notes([
        { start: 0, length: PPQ, key: 67 },
        { start: PPQ, length: PPQ * 4, key: 72 },
      ]),
    ],
  ]),
);

writeMidi(
  'overlapping.mid',
  buildSmf(PPQ, [
    [
      trackName('Sloppy'),
      tempo(0, 120),
      meter(0, 4, 4),
      ...notes([
        { start: 0, length: PPQ * 2, key: 60 },
        { start: PPQ, length: PPQ * 2, key: 64 },
        { start: PPQ * 2, length: PPQ, key: 67 },
      ]),
    ],
  ]),
);

writeMidi(
  'percussion.mid',
  buildSmf(PPQ, [
    [
      trackName('Melody'),
      tempo(0, 120),
      meter(0, 4, 4),
      ...notes([{ start: 0, length: PPQ, key: 60 }]),
    ],
    [
      trackName('Drums'),
      ...notes(
        [
          { start: 0, length: 60, key: 36 },
          { start: PPQ, length: 60, key: 38 },
          { start: PPQ * 2, length: 60, key: 36 },
          { start: PPQ * 3, length: 60, key: 38 },
        ],
        9,
      ),
    ],
  ]),
);

console.info('\nDone.\n');
