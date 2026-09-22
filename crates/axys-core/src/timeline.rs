// SPDX-License-Identifier: AGPL-3.0-or-later

//! Tempo and meter maps, and the conversions among ticks, beats, bars, seconds and samples.
//!
//! Tempo is integrated piecewise across events, never collapsed to one project-wide bpm, and
//! meter changes start a new bar at the change. `origin_seconds` places musical tick 0 in the
//! source recording, so a negative origin expresses a pickup before audio zero.

use serde::{Deserialize, Serialize};

use crate::{limits, AxysError, Result};

/// Tempo used where a map has no event of its own: 120 bpm.
pub const DEFAULT_MICROS_PER_QUARTER: u32 = 500_000;
/// Fastest accepted tempo event, 1000 bpm.
pub const MIN_MICROS_PER_QUARTER: u32 = 60_000;
/// Slowest accepted tempo event, the largest value a Standard MIDI File can carry.
pub const MAX_MICROS_PER_QUARTER: u32 = 0x00FF_FFFF;

const FALLBACK_PPQ: f64 = 480.0;
const FALLBACK_SAMPLE_RATE: f64 = 48_000.0;
const EPS: f64 = 1e-9;
/// Ticks stepped past a bar line before asking for the next one.
const BAR_STEP_NUDGE: f64 = 1e-6;

/// A tempo change expressed in MIDI ticks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoEvent {
    /// Musical position of the change.
    pub tick: u64,
    /// Microseconds per quarter note from this tick onwards.
    pub micros_per_quarter: u32,
}

/// A time-signature change expressed in MIDI ticks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterEvent {
    /// Musical position of the change.
    pub tick: u64,
    /// Beats per bar.
    pub numerator: u8,
    /// Note value of one beat, a power of two.
    pub denominator: u8,
}

/// A musical position.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarBeat {
    /// Bar 1 is the first full bar at or after the musical origin.
    pub bar: i64,
    /// Position within the bar, 1-based and fractional.
    pub beat: f64,
    /// Beats the containing bar holds.
    pub beats_in_bar: u8,
    /// Note value of one beat in the containing bar.
    pub beat_unit: u8,
}

/// One entry of the visible beat grid.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatGridPoint {
    /// Source seconds of the grid line.
    pub seconds: f64,
    /// Musical tick of the grid line.
    pub tick: f64,
    /// Bar the line falls in.
    pub bar: i64,
    /// Position within the bar, 1-based and fractional.
    pub beat: f64,
    /// The line opens a bar.
    pub is_bar_line: bool,
    /// The line lands on a whole beat rather than a subdivision.
    pub is_beat: bool,
}

/// Ordered tempo and meter maps with a deterministic conversion between ticks,
/// beats, bars, seconds and samples.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMap {
    /// Pulses per quarter note.
    pub ppq: u16,
    /// Tempo changes, sorted and always carrying a tick 0 event.
    pub tempo: Vec<TempoEvent>,
    /// Meter changes, sorted and always carrying a tick 0 event.
    pub meter: Vec<MeterEvent>,
    /// Source seconds at musical tick 0. Negative places the musical origin before audio
    /// zero, which is how a pickup is represented.
    pub origin_seconds: f64,
    /// Sample rate the sample conversions use.
    pub sample_rate: f64,
}

impl Default for TimelineMap {
    fn default() -> Self {
        Self {
            ppq: 480,
            tempo: vec![TempoEvent {
                tick: 0,
                micros_per_quarter: DEFAULT_MICROS_PER_QUARTER,
            }],
            meter: vec![MeterEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            }],
            origin_seconds: 0.0,
            sample_rate: FALLBACK_SAMPLE_RATE,
        }
    }
}

/// A stretch of one meter, with the bar numbers it owns.
#[derive(Debug, Clone, Copy)]
struct MeterSegment {
    start_tick: f64,
    end_tick: Option<f64>,
    first_bar: i64,
    bar_count: Option<i64>,
    bar_ticks: f64,
    beat_ticks: f64,
    numerator: u8,
    denominator: u8,
}

impl MeterSegment {
    fn holds_bar(&self, bar: i64) -> bool {
        match self.bar_count {
            Some(count) => bar >= self.first_bar && bar < self.first_bar.saturating_add(count),
            None => bar >= self.first_bar,
        }
    }
}

/// True for a meter denominator Axys accepts.
fn valid_denominator(denominator: u8) -> bool {
    (1..=128).contains(&denominator) && denominator.is_power_of_two()
}

/// Sorts by tick and keeps the last event at each tick.
fn collapse<T: Copy, K: Fn(&T) -> u64>(mut events: Vec<T>, tick_of: K) -> Vec<T> {
    events.sort_by_key(&tick_of);
    let mut out: Vec<T> = Vec::with_capacity(events.len());
    for event in events {
        match out.last_mut() {
            Some(last) if tick_of(last) == tick_of(&event) => *last = event,
            _ => out.push(event),
        }
    }
    out
}

impl TimelineMap {
    /// Builds a default 120 bpm, 4/4 map at the given resolution and sample rate.
    pub fn new(ppq: u16, sample_rate: f64) -> Result<Self> {
        if ppq == 0 {
            return Err(AxysError::Invalid("ppq must be greater than zero".into()));
        }
        if !sample_rate.is_finite()
            || sample_rate < f64::from(limits::MIN_SAMPLE_RATE)
            || sample_rate > f64::from(limits::MAX_SAMPLE_RATE)
        {
            return Err(AxysError::Invalid(format!(
                "sample rate {sample_rate} outside {}..={}",
                limits::MIN_SAMPLE_RATE,
                limits::MAX_SAMPLE_RATE
            )));
        }
        Ok(Self {
            ppq,
            sample_rate,
            ..Self::default()
        })
    }

    /// Replaces the tempo map, sorting, deduplicating by tick and ensuring a tick 0 event.
    pub fn set_tempo(&mut self, events: Vec<TempoEvent>) -> Result<()> {
        if events.len() > limits::MAX_MAP_EVENTS {
            return Err(AxysError::Invalid(format!(
                "tempo map of {} events exceeds {}",
                events.len(),
                limits::MAX_MAP_EVENTS
            )));
        }
        for event in &events {
            if event.micros_per_quarter < MIN_MICROS_PER_QUARTER
                || event.micros_per_quarter > MAX_MICROS_PER_QUARTER
            {
                return Err(AxysError::Invalid(format!(
                    "tempo {} at tick {} outside {MIN_MICROS_PER_QUARTER}..={MAX_MICROS_PER_QUARTER} microseconds per quarter",
                    event.micros_per_quarter, event.tick
                )));
            }
        }
        let mut events = collapse(events, |e| e.tick);
        if events.first().map(|e| e.tick) != Some(0) {
            events.insert(
                0,
                TempoEvent {
                    tick: 0,
                    micros_per_quarter: DEFAULT_MICROS_PER_QUARTER,
                },
            );
        }
        self.tempo = events;
        Ok(())
    }

    /// Replaces the meter map, sorting, deduplicating by tick and ensuring a tick 0 event.
    pub fn set_meter(&mut self, events: Vec<MeterEvent>) -> Result<()> {
        if events.len() > limits::MAX_MAP_EVENTS {
            return Err(AxysError::Invalid(format!(
                "meter map of {} events exceeds {}",
                events.len(),
                limits::MAX_MAP_EVENTS
            )));
        }
        for event in &events {
            if event.numerator == 0 {
                return Err(AxysError::Invalid(format!(
                    "meter at tick {} has a zero numerator",
                    event.tick
                )));
            }
            if !valid_denominator(event.denominator) {
                return Err(AxysError::Invalid(format!(
                    "meter denominator {} at tick {} is not a power of two in 1..=128",
                    event.denominator, event.tick
                )));
            }
        }
        let mut events = collapse(events, |e| e.tick);
        if events.first().map(|e| e.tick) != Some(0) {
            events.insert(
                0,
                MeterEvent {
                    tick: 0,
                    numerator: 4,
                    denominator: 4,
                },
            );
        }
        self.meter = events;
        Ok(())
    }

    /// Tempo in force at `tick`.
    pub fn tempo_at_tick(&self, tick: u64) -> TempoEvent {
        let events = self.normalised_tempo();
        let mut current = events[0];
        for event in &events {
            if event.tick <= tick {
                current = *event;
            } else {
                break;
            }
        }
        current
    }

    /// Meter in force at `tick`.
    pub fn meter_at_tick(&self, tick: u64) -> MeterEvent {
        let events = self.normalised_meter();
        let mut current = events[0];
        for event in &events {
            if event.tick <= tick {
                current = *event;
            } else {
                break;
            }
        }
        current
    }

    /// Quarter-note beats per minute in force at `tick`.
    pub fn bpm_at_tick(&self, tick: u64) -> f64 {
        60_000_000.0 / f64::from(self.tempo_at_tick(tick).micros_per_quarter)
    }

    /// Elapsed seconds from musical tick 0, ignoring `origin_seconds`.
    pub fn tick_to_musical_seconds(&self, tick: f64) -> f64 {
        let events = self.normalised_tempo();
        self.tick_to_musical_seconds_with(&events, tick)
    }

    /// Musical tick at `seconds` elapsed from tick 0, ignoring `origin_seconds`.
    pub fn musical_seconds_to_tick(&self, seconds: f64) -> f64 {
        let events = self.normalised_tempo();
        self.musical_seconds_to_tick_with(&events, seconds)
    }

    /// Source seconds, including `origin_seconds`.
    pub fn tick_to_seconds(&self, tick: f64) -> f64 {
        self.origin() + self.tick_to_musical_seconds(tick)
    }

    /// Musical tick at a source-seconds position.
    pub fn seconds_to_tick(&self, seconds: f64) -> f64 {
        if !seconds.is_finite() {
            return 0.0;
        }
        self.musical_seconds_to_tick(seconds - self.origin())
    }

    /// Quarter-note beats at `tick`, independent of meter.
    pub fn tick_to_beats(&self, tick: f64) -> f64 {
        if !tick.is_finite() {
            return 0.0;
        }
        tick / self.ppq_f64()
    }

    /// Tick of a quarter-note beat position.
    pub fn beats_to_tick(&self, beats: f64) -> f64 {
        if !beats.is_finite() {
            return 0.0;
        }
        beats * self.ppq_f64()
    }

    /// Sample position of a source-seconds position.
    pub fn seconds_to_samples(&self, seconds: f64) -> f64 {
        if !seconds.is_finite() {
            return 0.0;
        }
        seconds * self.rate()
    }

    /// Source seconds of a sample position.
    pub fn samples_to_seconds(&self, samples: f64) -> f64 {
        if !samples.is_finite() {
            return 0.0;
        }
        samples / self.rate()
    }

    /// Bar and beat at `tick`.
    pub fn tick_to_bar_beat(&self, tick: f64) -> BarBeat {
        let segments = self.meter_segments();
        Self::bar_beat_in(&segments, tick)
    }

    /// Tick of a bar and beat position. Bars below 1 extend the first meter backwards.
    pub fn bar_beat_to_tick(&self, bar: i64, beat: f64) -> f64 {
        let segments = self.meter_segments();
        let beat = if beat.is_finite() { beat } else { 1.0 };
        let segment = segments
            .iter()
            .find(|s| s.holds_bar(bar))
            .unwrap_or(&segments[0]);
        let bars = bar.saturating_sub(segment.first_bar) as f64;
        segment.start_tick + bars * segment.bar_ticks + (beat - 1.0) * segment.beat_ticks
    }

    /// Bar and beat at a source-seconds position.
    pub fn seconds_to_bar_beat(&self, seconds: f64) -> BarBeat {
        self.tick_to_bar_beat(self.seconds_to_tick(seconds))
    }

    /// Tick of the first bar line at or after `tick`.
    pub fn next_bar_tick(&self, tick: f64) -> f64 {
        let segments = self.meter_segments();
        Self::next_bar_tick_in(&segments, tick)
    }

    /// Bar numbers and their ticks in `[from_seconds, to_seconds]`, for ruler drawing.
    pub fn bar_lines(&self, from_seconds: f64, to_seconds: f64) -> Vec<(i64, f64)> {
        let Some((from_tick, to_tick)) = self.tick_window(from_seconds, to_seconds) else {
            return Vec::new();
        };
        let segments = self.meter_segments();
        let mut out = Vec::new();
        let mut tick = Self::next_bar_tick_in(&segments, from_tick);
        while tick <= to_tick + EPS && out.len() < limits::MAX_MAP_EVENTS {
            let bar = Self::bar_beat_in(&segments, tick).bar;
            out.push((bar, tick));
            let next = Self::next_bar_tick_in(&segments, tick + BAR_STEP_NUDGE);
            if !next.is_finite() || next <= tick {
                break;
            }
            tick = next;
        }
        out
    }

    /// Beat ticks subdivided by `division` (1 = beats, 2 = eighths ...) in a time window,
    /// each paired with its source seconds and whether it lands on a bar line.
    pub fn beat_grid(
        &self,
        from_seconds: f64,
        to_seconds: f64,
        division: u32,
    ) -> Vec<BeatGridPoint> {
        let Some((from_tick, to_tick)) = self.tick_window(from_seconds, to_seconds) else {
            return Vec::new();
        };
        let division = division.max(1);
        let segments = self.meter_segments();
        let tempo = self.normalised_tempo();
        let origin = self.origin();
        let mut out = Vec::new();

        for (index, segment) in segments.iter().enumerate() {
            let seg_end = segment.end_tick.unwrap_or(f64::INFINITY);
            if seg_end < from_tick - EPS {
                continue;
            }
            if segment.start_tick > to_tick + EPS && index > 0 {
                break;
            }
            let step = segment.beat_ticks / f64::from(division);
            if !step.is_finite() || step <= 0.0 {
                continue;
            }
            // The first segment extends backwards so a pickup still gets a grid.
            let lower = if index == 0 {
                from_tick
            } else {
                from_tick.max(segment.start_tick)
            };
            let mut step_index = ((lower - segment.start_tick) / step).floor();
            if segment.start_tick + step_index * step < lower - EPS {
                step_index += 1.0;
            }
            loop {
                if out.len() >= limits::MAX_MAP_EVENTS {
                    return out;
                }
                let tick = segment.start_tick + step_index * step;
                if tick > to_tick + EPS || tick > seg_end - EPS {
                    break;
                }
                let bar_beat = Self::bar_beat_in(&segments, tick);
                let sub = step_index.rem_euclid(f64::from(division));
                let is_beat = sub.abs() < EPS;
                out.push(BeatGridPoint {
                    seconds: origin + self.tick_to_musical_seconds_with(&tempo, tick),
                    tick,
                    bar: bar_beat.bar,
                    beat: bar_beat.beat,
                    is_bar_line: is_beat && (bar_beat.beat - 1.0).abs() < 1e-6,
                    is_beat,
                });
                step_index += 1.0;
            }
        }
        out
    }

    /// Nearest grid position to `seconds` at `division`, in source seconds.
    pub fn snap_seconds(&self, seconds: f64, division: u32) -> f64 {
        if !seconds.is_finite() {
            return seconds;
        }
        let division = division.max(1);
        let segments = self.meter_segments();
        let tempo = self.normalised_tempo();
        let tick = self.musical_seconds_to_tick_with(&tempo, seconds - self.origin());
        let segment = Self::segment_at_tick(&segments, tick);
        let step = segment.beat_ticks / f64::from(division);
        if !step.is_finite() || step <= 0.0 {
            return seconds;
        }
        let mut snapped = segment.start_tick + ((tick - segment.start_tick) / step).round() * step;
        if let Some(end) = segment.end_tick {
            if snapped > end {
                snapped = end;
            }
        }
        if snapped < segment.start_tick {
            snapped = segment.start_tick;
        }
        self.origin() + self.tick_to_musical_seconds_with(&tempo, snapped)
    }

    fn ppq_f64(&self) -> f64 {
        if self.ppq == 0 {
            FALLBACK_PPQ
        } else {
            f64::from(self.ppq)
        }
    }

    fn rate(&self) -> f64 {
        if self.sample_rate.is_finite() && self.sample_rate > 0.0 {
            self.sample_rate
        } else {
            FALLBACK_SAMPLE_RATE
        }
    }

    fn origin(&self) -> f64 {
        if self.origin_seconds.is_finite() {
            self.origin_seconds
        } else {
            0.0
        }
    }

    /// Tempo map with a tick 0 event, sorted, with unusable values replaced.
    fn normalised_tempo(&self) -> Vec<TempoEvent> {
        let sane: Vec<TempoEvent> = self
            .tempo
            .iter()
            .take(limits::MAX_MAP_EVENTS)
            .map(|e| TempoEvent {
                tick: e.tick,
                micros_per_quarter: if e.micros_per_quarter < MIN_MICROS_PER_QUARTER
                    || e.micros_per_quarter > MAX_MICROS_PER_QUARTER
                {
                    DEFAULT_MICROS_PER_QUARTER
                } else {
                    e.micros_per_quarter
                },
            })
            .collect();
        let mut events = collapse(sane, |e| e.tick);
        if events.first().map(|e| e.tick) != Some(0) {
            events.insert(
                0,
                TempoEvent {
                    tick: 0,
                    micros_per_quarter: DEFAULT_MICROS_PER_QUARTER,
                },
            );
        }
        events
    }

    /// Meter map with a tick 0 event, sorted, with unusable values replaced.
    fn normalised_meter(&self) -> Vec<MeterEvent> {
        let sane: Vec<MeterEvent> = self
            .meter
            .iter()
            .take(limits::MAX_MAP_EVENTS)
            .map(|e| MeterEvent {
                tick: e.tick,
                numerator: if e.numerator == 0 { 4 } else { e.numerator },
                denominator: if valid_denominator(e.denominator) {
                    e.denominator
                } else {
                    4
                },
            })
            .collect();
        let mut events = collapse(sane, |e| e.tick);
        if events.first().map(|e| e.tick) != Some(0) {
            events.insert(
                0,
                MeterEvent {
                    tick: 0,
                    numerator: 4,
                    denominator: 4,
                },
            );
        }
        events
    }

    fn meter_segments(&self) -> Vec<MeterSegment> {
        let events = self.normalised_meter();
        let ppq = self.ppq_f64();
        let mut segments = Vec::with_capacity(events.len());
        let mut first_bar = 1i64;
        for (index, event) in events.iter().enumerate() {
            let beat_ticks = 4.0 * ppq / f64::from(event.denominator);
            let bar_ticks = beat_ticks * f64::from(event.numerator);
            let start_tick = event.tick as f64;
            let end_tick = events.get(index + 1).map(|next| next.tick as f64);
            let bar_count = end_tick.map(|end| {
                let span = (end - start_tick).max(0.0);
                let bars = (span / bar_ticks).ceil();
                if bars.is_finite() {
                    bars as i64
                } else {
                    0
                }
            });
            segments.push(MeterSegment {
                start_tick,
                end_tick,
                first_bar,
                bar_count,
                bar_ticks,
                beat_ticks,
                numerator: event.numerator,
                denominator: event.denominator,
            });
            if let Some(count) = bar_count {
                first_bar = first_bar.saturating_add(count);
            }
        }
        segments
    }

    fn segment_at_tick(segments: &[MeterSegment], tick: f64) -> MeterSegment {
        let mut current = segments[0];
        for segment in segments {
            if segment.start_tick <= tick + EPS {
                current = *segment;
            } else {
                break;
            }
        }
        current
    }

    fn bar_beat_in(segments: &[MeterSegment], tick: f64) -> BarBeat {
        let tick = if tick.is_finite() { tick } else { 0.0 };
        let segment = Self::segment_at_tick(segments, tick);
        let offset = tick - segment.start_tick;
        let bars = (offset / segment.bar_ticks).floor();
        let bars_i = if bars.is_finite() { bars as i64 } else { 0 };
        let within = offset - bars * segment.bar_ticks;
        BarBeat {
            bar: segment.first_bar.saturating_add(bars_i),
            beat: within / segment.beat_ticks + 1.0,
            beats_in_bar: segment.numerator,
            beat_unit: segment.denominator,
        }
    }

    fn next_bar_tick_in(segments: &[MeterSegment], tick: f64) -> f64 {
        let tick = if tick.is_finite() { tick } else { 0.0 };
        let segment = Self::segment_at_tick(segments, tick);
        let offset = tick - segment.start_tick;
        let steps = (offset / segment.bar_ticks - EPS).ceil();
        let candidate = segment.start_tick + steps.max(0.0) * segment.bar_ticks;
        let candidate = if candidate < tick - EPS {
            segment.start_tick + (steps + 1.0) * segment.bar_ticks
        } else {
            candidate
        };
        match segment.end_tick {
            // A meter change opens a bar, so it wins over the bar line it interrupts.
            Some(end) if candidate > end - EPS => end,
            _ => candidate,
        }
    }

    fn tick_to_musical_seconds_with(&self, events: &[TempoEvent], tick: f64) -> f64 {
        if !tick.is_finite() {
            return 0.0;
        }
        let ppq = self.ppq_f64();
        let seconds_per_tick = |mpq: u32| -> f64 { f64::from(mpq) / 1_000_000.0 / ppq };
        if tick <= 0.0 {
            return tick * seconds_per_tick(events[0].micros_per_quarter);
        }
        let mut seconds = 0.0;
        for (index, event) in events.iter().enumerate() {
            let start = if index == 0 { 0.0 } else { event.tick as f64 };
            if start >= tick {
                break;
            }
            let end = events
                .get(index + 1)
                .map(|next| next.tick as f64)
                .unwrap_or(f64::INFINITY);
            let upto = tick.min(end);
            if upto > start {
                seconds += (upto - start) * seconds_per_tick(event.micros_per_quarter);
            }
            if tick <= end {
                break;
            }
        }
        seconds
    }

    fn musical_seconds_to_tick_with(&self, events: &[TempoEvent], seconds: f64) -> f64 {
        if !seconds.is_finite() {
            return 0.0;
        }
        let ppq = self.ppq_f64();
        let seconds_per_tick = |mpq: u32| -> f64 { f64::from(mpq) / 1_000_000.0 / ppq };
        if seconds <= 0.0 {
            return seconds / seconds_per_tick(events[0].micros_per_quarter);
        }
        let mut elapsed = 0.0;
        for (index, event) in events.iter().enumerate() {
            let start = if index == 0 { 0.0 } else { event.tick as f64 };
            let spt = seconds_per_tick(event.micros_per_quarter);
            match events.get(index + 1) {
                Some(next) => {
                    let span = (next.tick as f64 - start).max(0.0);
                    let segment_seconds = span * spt;
                    if seconds <= elapsed + segment_seconds {
                        return start + (seconds - elapsed) / spt;
                    }
                    elapsed += segment_seconds;
                }
                None => return start + (seconds - elapsed) / spt,
            }
        }
        0.0
    }

    /// Tick bounds of a source-seconds window, or None when the window is empty or unusable.
    fn tick_window(&self, from_seconds: f64, to_seconds: f64) -> Option<(f64, f64)> {
        if !from_seconds.is_finite() || !to_seconds.is_finite() || to_seconds < from_seconds {
            return None;
        }
        let tempo = self.normalised_tempo();
        let origin = self.origin();
        Some((
            self.musical_seconds_to_tick_with(&tempo, from_seconds - origin),
            self.musical_seconds_to_tick_with(&tempo, to_seconds - origin),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    fn map_120() -> TimelineMap {
        TimelineMap::new(480, 48_000.0).expect("valid map")
    }

    #[test]
    fn default_is_120_bpm_four_four() {
        let map = TimelineMap::default();
        assert_eq!(map.ppq, 480);
        assert_eq!(map.tempo.len(), 1);
        assert_eq!(map.tempo[0].micros_per_quarter, 500_000);
        assert_eq!(map.meter[0].numerator, 4);
        assert_eq!(map.meter[0].denominator, 4);
        assert!(close(map.origin_seconds, 0.0));
        assert!(close(map.sample_rate, 48_000.0));
        assert!(close(map.bpm_at_tick(0), 120.0));
    }

    #[test]
    fn quarter_at_120_bpm_is_half_a_second() {
        let map = map_120();
        assert!(close(map.tick_to_seconds(480.0), 0.5));
        assert!(close(map.tick_to_seconds(1920.0), 2.0));
        assert!(close(map.seconds_to_tick(0.5), 480.0));
    }

    #[test]
    fn new_rejects_bad_inputs() {
        assert!(TimelineMap::new(0, 48_000.0).is_err());
        assert!(TimelineMap::new(480, 0.0).is_err());
        assert!(TimelineMap::new(480, f64::NAN).is_err());
        assert!(TimelineMap::new(480, 1_000_000.0).is_err());
        assert!(TimelineMap::new(96, 44_100.0).is_ok());
    }

    #[test]
    fn set_tempo_rejects_absurd_values() {
        let mut map = map_120();
        assert!(map
            .set_tempo(vec![TempoEvent {
                tick: 0,
                micros_per_quarter: 0
            }])
            .is_err());
        assert!(map
            .set_tempo(vec![TempoEvent {
                tick: 0,
                micros_per_quarter: u32::MAX
            }])
            .is_err());
        assert!(map
            .set_tempo(vec![TempoEvent {
                tick: 0,
                micros_per_quarter: 1_000_000
            }])
            .is_ok());
    }

    #[test]
    fn set_meter_rejects_bad_signatures() {
        let mut map = map_120();
        assert!(map
            .set_meter(vec![MeterEvent {
                tick: 0,
                numerator: 0,
                denominator: 4
            }])
            .is_err());
        assert!(map
            .set_meter(vec![MeterEvent {
                tick: 0,
                numerator: 4,
                denominator: 6
            }])
            .is_err());
        assert!(map
            .set_meter(vec![MeterEvent {
                tick: 0,
                numerator: 4,
                denominator: 0
            }])
            .is_err());
        assert!(map
            .set_meter(vec![MeterEvent {
                tick: 0,
                numerator: 7,
                denominator: 8
            }])
            .is_ok());
    }

    #[test]
    fn set_tempo_sorts_dedupes_and_adds_tick_zero() {
        let mut map = map_120();
        map.set_tempo(vec![
            TempoEvent {
                tick: 1920,
                micros_per_quarter: 600_000,
            },
            TempoEvent {
                tick: 960,
                micros_per_quarter: 400_000,
            },
            TempoEvent {
                tick: 1920,
                micros_per_quarter: 1_000_000,
            },
        ])
        .expect("accepted");
        assert_eq!(map.tempo.len(), 3);
        assert_eq!(map.tempo[0].tick, 0);
        assert_eq!(map.tempo[0].micros_per_quarter, 500_000);
        assert_eq!(map.tempo[1].tick, 960);
        assert_eq!(map.tempo[2].tick, 1920);
        assert_eq!(map.tempo[2].micros_per_quarter, 1_000_000);
    }

    #[test]
    fn oversized_maps_are_rejected() {
        let mut map = map_120();
        let events = vec![
            TempoEvent {
                tick: 0,
                micros_per_quarter: 500_000
            };
            limits::MAX_MAP_EVENTS + 1
        ];
        assert!(map.set_tempo(events).is_err());
    }

    #[test]
    fn tempo_change_lands_the_right_absolute_second() {
        let mut map = map_120();
        // 120 bpm for two bars, then 60 bpm.
        map.set_tempo(vec![
            TempoEvent {
                tick: 0,
                micros_per_quarter: 500_000,
            },
            TempoEvent {
                tick: 3840,
                micros_per_quarter: 1_000_000,
            },
        ])
        .expect("accepted");
        assert!(close(map.tick_to_seconds(3840.0), 4.0));
        // One further quarter now takes a whole second.
        assert!(close(map.tick_to_seconds(4320.0), 5.0));
        assert!(close(map.tick_to_seconds(5760.0), 8.0));
        assert!(close(map.bpm_at_tick(4000), 60.0));
        assert!(close(map.bpm_at_tick(3839), 120.0));
        assert_eq!(map.tempo_at_tick(3840).micros_per_quarter, 1_000_000);
    }

    #[test]
    fn seconds_tick_round_trip_across_tempo_changes() {
        let mut map = map_120();
        map.origin_seconds = 0.25;
        map.set_tempo(vec![
            TempoEvent {
                tick: 0,
                micros_per_quarter: 500_000,
            },
            TempoEvent {
                tick: 1000,
                micros_per_quarter: 750_000,
            },
            TempoEvent {
                tick: 5000,
                micros_per_quarter: 300_000,
            },
        ])
        .expect("accepted");
        for seconds in [-1.0, 0.0, 0.25, 1.0, 3.3, 7.75, 20.0] {
            let tick = map.seconds_to_tick(seconds);
            assert!(close(map.tick_to_seconds(tick), seconds), "{seconds}");
        }
        for tick in [-500.0, 0.0, 999.0, 1000.0, 4999.5, 5000.0, 9000.0] {
            let seconds = map.tick_to_seconds(tick);
            assert!(close(map.seconds_to_tick(seconds), tick), "{tick}");
        }
    }

    #[test]
    fn negative_ticks_use_the_tick_zero_tempo() {
        let mut map = map_120();
        map.set_tempo(vec![
            TempoEvent {
                tick: 0,
                micros_per_quarter: 500_000,
            },
            TempoEvent {
                tick: 480,
                micros_per_quarter: 250_000,
            },
        ])
        .expect("accepted");
        assert!(close(map.tick_to_musical_seconds(-480.0), -0.5));
        assert!(close(map.musical_seconds_to_tick(-0.5), -480.0));
    }

    #[test]
    fn four_four_to_three_four_renumbers_bars() {
        let mut map = map_120();
        map.set_meter(vec![
            MeterEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            },
            // Bars 1 and 2 are 4/4, bar 3 onwards is 3/4.
            MeterEvent {
                tick: 3840,
                numerator: 3,
                denominator: 4,
            },
        ])
        .expect("accepted");
        assert_eq!(map.tick_to_bar_beat(0.0).bar, 1);
        assert_eq!(map.tick_to_bar_beat(960.0).bar, 1);
        assert_eq!(map.tick_to_bar_beat(960.0).beat, 3.0);
        assert_eq!(map.tick_to_bar_beat(1920.0).bar, 2);
        assert_eq!(map.tick_to_bar_beat(1920.0).beats_in_bar, 4);
        assert_eq!(map.tick_to_bar_beat(3840.0).bar, 3);
        assert_eq!(map.tick_to_bar_beat(3840.0).beat, 1.0);
        assert_eq!(map.tick_to_bar_beat(3840.0).beats_in_bar, 3);
        // 3/4 bars are 1440 ticks.
        assert_eq!(map.tick_to_bar_beat(5280.0).bar, 4);
        assert!(close(map.bar_beat_to_tick(4, 1.0), 5280.0));
        assert!(close(map.bar_beat_to_tick(1, 3.0), 960.0));
        assert!(close(map.bar_beat_to_tick(3, 2.5), 4560.0));
    }

    #[test]
    fn meter_change_mid_bar_opens_a_new_bar() {
        let mut map = map_120();
        // The change lands halfway through what would be bar 2.
        map.set_meter(vec![
            MeterEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            },
            MeterEvent {
                tick: 2880,
                numerator: 6,
                denominator: 8,
            },
        ])
        .expect("accepted");
        assert_eq!(map.tick_to_bar_beat(2879.0).bar, 2);
        assert_eq!(map.tick_to_bar_beat(2880.0).bar, 3);
        assert_eq!(map.tick_to_bar_beat(2880.0).beat, 1.0);
        assert_eq!(map.tick_to_bar_beat(2880.0).beat_unit, 8);
        // A 6/8 bar is six eighths of 240 ticks.
        assert_eq!(map.tick_to_bar_beat(4320.0).bar, 4);
        assert!(close(map.next_bar_tick(2000.0), 2880.0));
        assert!(close(map.next_bar_tick(2880.0), 2880.0));
        assert!(close(map.next_bar_tick(2881.0), 4320.0));
    }

    #[test]
    fn bar_beat_round_trips_through_ticks() {
        let mut map = map_120();
        map.set_meter(vec![
            MeterEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            },
            MeterEvent {
                tick: 3840,
                numerator: 7,
                denominator: 8,
            },
        ])
        .expect("accepted");
        for tick in [0.0, 480.0, 1900.0, 3840.0, 4000.0, 6000.0, 12_345.0] {
            let bb = map.tick_to_bar_beat(tick);
            assert!(close(map.bar_beat_to_tick(bb.bar, bb.beat), tick), "{tick}");
        }
    }

    #[test]
    fn pickup_shifts_source_seconds_without_moving_ticks() {
        let mut map = map_120();
        // Musical zero sits half a second before audio zero.
        map.origin_seconds = -0.5;
        assert!(close(map.tick_to_seconds(0.0), -0.5));
        assert!(close(map.tick_to_seconds(480.0), 0.0));
        assert!(close(map.seconds_to_tick(0.0), 480.0));
        assert_eq!(map.seconds_to_bar_beat(0.0).bar, 1);
        assert_eq!(map.seconds_to_bar_beat(0.0).beat, 2.0);
        // Audio zero is already inside bar 1, so the pickup material is before the origin.
        let before = map.seconds_to_bar_beat(-1.0);
        assert_eq!(before.bar, 0);
        assert!(close(before.beat, 4.0));
        assert!(close(map.tick_to_musical_seconds(480.0), 0.5));
    }

    #[test]
    fn bar_lines_cover_a_window() {
        let map = map_120();
        let lines = map.bar_lines(0.0, 8.0);
        // Bars every two seconds at 120 bpm in 4/4.
        assert_eq!(lines.len(), 5);
        assert_eq!(lines[0], (1, 0.0));
        assert!(close(lines[1].1, 1920.0));
        assert_eq!(lines[4].0, 5);
        assert!(map.bar_lines(4.0, 1.0).is_empty());
        assert!(map.bar_lines(f64::NAN, 1.0).is_empty());
    }

    #[test]
    fn bar_lines_follow_a_meter_change() {
        let mut map = map_120();
        map.set_meter(vec![
            MeterEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            },
            MeterEvent {
                tick: 2880,
                numerator: 3,
                denominator: 4,
            },
        ])
        .expect("accepted");
        let lines = map.bar_lines(0.0, 6.0);
        let ticks: Vec<f64> = lines.iter().map(|l| l.1).collect();
        assert!(close(ticks[0], 0.0));
        assert!(close(ticks[1], 1920.0));
        assert!(close(ticks[2], 2880.0));
        assert!(close(ticks[3], 4320.0));
        let bars: Vec<i64> = lines.iter().map(|l| l.0).collect();
        assert_eq!(&bars[..4], &[1, 2, 3, 4]);
    }

    #[test]
    fn beat_grid_marks_bars_beats_and_subdivisions() {
        let map = map_120();
        let grid = map.beat_grid(0.0, 2.0, 2);
        // Eighths every 0.25 s, nine of them across two seconds inclusive.
        assert_eq!(grid.len(), 9);
        assert!(grid[0].is_bar_line);
        assert!(grid[0].is_beat);
        assert!(!grid[1].is_beat);
        assert!(close(grid[1].seconds, 0.25));
        assert!(grid[2].is_beat);
        assert!(!grid[2].is_bar_line);
        assert!(close(grid[2].beat, 2.0));
        assert!(grid[8].is_bar_line);
        assert_eq!(grid[8].bar, 2);
        assert!(map.beat_grid(0.0, 1.0, 0).len() > 1);
    }

    #[test]
    fn beat_grid_spans_a_meter_change() {
        let mut map = map_120();
        map.set_meter(vec![
            MeterEvent {
                tick: 0,
                numerator: 4,
                denominator: 4,
            },
            MeterEvent {
                tick: 2880,
                numerator: 6,
                denominator: 8,
            },
        ])
        .expect("accepted");
        let grid = map.beat_grid(0.0, 4.0, 1);
        let change = grid
            .iter()
            .find(|p| close(p.tick, 2880.0))
            .expect("grid point at the meter change");
        assert!(change.is_bar_line);
        // Eighth-note beats after the change are 240 ticks apart.
        let after: Vec<f64> = grid
            .iter()
            .filter(|p| p.tick > 2880.0)
            .map(|p| p.tick)
            .collect();
        assert!(close(after[0], 3120.0));
    }

    #[test]
    fn snapping_to_eighths_follows_a_tempo_change() {
        let mut map = map_120();
        map.set_tempo(vec![
            TempoEvent {
                tick: 0,
                micros_per_quarter: 500_000,
            },
            TempoEvent {
                tick: 1920,
                micros_per_quarter: 1_000_000,
            },
        ])
        .expect("accepted");
        // Before the change an eighth is 0.25 s.
        assert!(close(map.snap_seconds(0.26, 2), 0.25));
        assert!(close(map.snap_seconds(0.4, 2), 0.5));
        // The change is at 2.0 s, after which an eighth is 0.5 s.
        assert!(close(map.snap_seconds(2.6, 2), 2.5));
        assert!(close(map.snap_seconds(2.9, 2), 3.0));
        // Quarters still land on the beat.
        assert!(close(map.snap_seconds(2.4, 1), 2.0));
        assert!(map.snap_seconds(f64::NAN, 2).is_nan());
    }

    #[test]
    fn snapping_respects_the_origin() {
        let mut map = map_120();
        map.origin_seconds = -0.5;
        assert!(close(map.snap_seconds(0.1, 1), 0.0));
        assert!(close(map.snap_seconds(-0.4, 1), -0.5));
    }

    #[test]
    fn sample_conversion_uses_the_map_rate() {
        let map = TimelineMap::new(480, 44_100.0).expect("valid map");
        assert!(close(map.seconds_to_samples(1.0), 44_100.0));
        assert!(close(map.samples_to_seconds(22_050.0), 0.5));
        assert!(close(
            map.samples_to_seconds(map.seconds_to_samples(3.7)),
            3.7
        ));
        assert!(close(map.seconds_to_samples(f64::INFINITY), 0.0));
    }

    #[test]
    fn beats_convert_in_quarter_notes() {
        let map = map_120();
        assert!(close(map.tick_to_beats(960.0), 2.0));
        assert!(close(map.beats_to_tick(2.5), 1200.0));
        assert!(close(map.beats_to_tick(map.tick_to_beats(777.0)), 777.0));
    }

    #[test]
    fn malformed_fields_do_not_panic() {
        let mut map = TimelineMap {
            ppq: 0,
            tempo: vec![TempoEvent {
                tick: 500,
                micros_per_quarter: 0,
            }],
            meter: vec![MeterEvent {
                tick: 100,
                numerator: 0,
                denominator: 5,
            }],
            origin_seconds: f64::NAN,
            sample_rate: 0.0,
        };
        let _ = map.tick_to_seconds(1000.0);
        let _ = map.seconds_to_tick(1.0);
        let _ = map.tick_to_bar_beat(f64::INFINITY);
        let _ = map.bar_beat_to_tick(i64::MIN, f64::NAN);
        let _ = map.beat_grid(0.0, 10.0, u32::MAX);
        let _ = map.bar_lines(0.0, 10.0);
        let _ = map.snap_seconds(1.0, 3);
        let _ = map.samples_to_seconds(1.0);
        map.origin_seconds = 0.0;
        // The tick 0 defaults fill in for the missing events.
        assert!(close(map.tick_to_seconds(480.0), 0.5));
        assert_eq!(map.meter_at_tick(0).denominator, 4);
    }

    #[test]
    fn grid_output_is_bounded() {
        let map = map_120();
        let grid = map.beat_grid(0.0, 3600.0, 64);
        assert!(grid.len() <= limits::MAX_MAP_EVENTS);
        let lines = map.bar_lines(0.0, 3600.0);
        assert!(lines.len() <= limits::MAX_MAP_EVENTS);
    }
}
