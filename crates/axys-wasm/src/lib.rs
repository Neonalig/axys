// SPDX-License-Identifier: AGPL-3.0-or-later

//! WebAssembly boundary for the Axys core.
//!
//! The surface is deliberately narrow. Audio crosses as typed arrays so large buffers
//! are never copied more than once, and everything structured crosses as JSON so the
//! contract is stable, versionable and testable from TypeScript without generated
//! struct bindings.
//!
//! Three entry points serve three threads: [`analyse`] runs in a worker, [`Session`]
//! owns edit state on the main thread, and [`PlaybackRenderer`] runs inside the
//! AudioWorklet.

use wasm_bindgen::prelude::*;

use axys_core::analysis::energy::{analyse_energy, EnergyTrack};
use axys_core::analysis::f0::{detect_f0, F0Params, PitchTrack};
use axys_core::analysis::segment::{segment, SegmentParams};
use axys_core::audio::wav::{encode_wav, BitDepth, ExportReport};
use axys_core::blob::BlobSet;
use axys_core::dsp::formant::FormantMode;
use axys_core::edit::{apply, EditOp, History};
use axys_core::midi::{measure_drift, parse_smf, propose_mappings, MidiFile};
use axys_core::project::{
    AnalysisInfo, EditState, Project, SourceInfo, ViewState, SCHEMA_VERSION,
};
use axys_core::render::{Quality, Renderer};
use axys_core::target::{compile_plan, GuideInputs, PlanInputs, RenderPlan};
use axys_core::timeline::TimelineMap;
use axys_core::AxysError;

/// Installs a panic hook that reports Rust panics to the browser console.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Version of the compiled core.
#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Project schema version this build reads and writes.
#[wasm_bindgen(js_name = schemaVersion)]
pub fn schema_version() -> u32 {
    SCHEMA_VERSION
}

fn to_js(err: AxysError) -> JsValue {
    JsValue::from_str(&err.to_string())
}

fn json_err(err: serde_json::Error) -> JsValue {
    JsValue::from_str(&format!("invalid json: {err}"))
}

fn parse<T: serde::de::DeserializeOwned>(json: &str) -> Result<T, JsValue> {
    serde_json::from_str(json).map_err(json_err)
}

fn dump<T: serde::Serialize>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(json_err)
}

/// Converts a frequency in Hz to a fractional MIDI note number.
///
/// Returns `NaN` for non-positive or non-finite input.
#[wasm_bindgen(js_name = hzToMidi)]
pub fn hz_to_midi(hz: f64, a4_hz: f64) -> f64 {
    axys_core::Tuning { a4_hz }
        .hz_to_midi(hz)
        .unwrap_or(f64::NAN)
}

/// Converts a fractional MIDI note number to a frequency in Hz.
#[wasm_bindgen(js_name = midiToHz)]
pub fn midi_to_hz(midi: f64, a4_hz: f64) -> f64 {
    axys_core::Tuning { a4_hz }.midi_to_hz(midi)
}

/// Parses a Standard MIDI File and returns it as JSON.
#[wasm_bindgen(js_name = parseMidi)]
pub fn parse_midi(bytes: &[u8]) -> Result<String, JsValue> {
    let file = parse_smf(bytes).map_err(to_js)?;
    dump(&file)
}

/// Pitch, energy and provisional segmentation for one source buffer.
#[wasm_bindgen]
pub struct Analysis {
    track: PitchTrack,
    energy: EnergyTrack,
    blobs: BlobSet,
}

#[wasm_bindgen]
impl Analysis {
    /// Frame times in seconds.
    pub fn times(&self) -> Vec<f32> {
        self.track.to_arrays().times
    }

    /// Fractional MIDI per frame, `NaN` where unvoiced.
    pub fn midi(&self) -> Vec<f32> {
        self.track.to_arrays().midi
    }

    /// Detection confidence per frame.
    pub fn confidence(&self) -> Vec<f32> {
        self.track.to_arrays().confidence
    }

    /// Frame RMS.
    pub fn rms(&self) -> Vec<f32> {
        self.track.to_arrays().rms
    }

    /// The full pitch track as JSON.
    #[wasm_bindgen(js_name = trackJson)]
    pub fn track_json(&self) -> Result<String, JsValue> {
        dump(&self.track)
    }

    /// The energy track as JSON.
    #[wasm_bindgen(js_name = energyJson)]
    pub fn energy_json(&self) -> Result<String, JsValue> {
        dump(&self.energy)
    }

    /// The provisional blobs as JSON.
    #[wasm_bindgen(js_name = blobsJson)]
    pub fn blobs_json(&self) -> Result<String, JsValue> {
        dump(self.blobs.blobs())
    }
}

/// Analyses mono source audio into pitch, energy and provisional blobs.
///
/// `params_json` carries `{ "f0": F0Params, "segment": SegmentParams }`; omit either to
/// take its default.
#[wasm_bindgen]
pub fn analyse(
    samples: &[f32],
    sample_rate: f64,
    params_json: &str,
) -> Result<Analysis, JsValue> {
    #[derive(serde::Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    struct Params {
        f0: F0Params,
        segment: SegmentParams,
    }

    let params: Params = if params_json.trim().is_empty() {
        Params::default()
    } else {
        parse(params_json)?
    };

    let track = detect_f0(samples, sample_rate, &params.f0).map_err(to_js)?;
    let energy = analyse_energy(
        samples,
        sample_rate,
        params.f0.frame_seconds,
        params.f0.hop_seconds,
    )
    .map_err(to_js)?;
    let blobs = segment(&track, &energy, &params.segment).map_err(to_js)?;
    Ok(Analysis {
        track,
        energy,
        blobs,
    })
}

/// An editing session over one source vocal.
///
/// Owns the immutable analysis, the mutable edit state and the undo history, and
/// compiles a [`RenderPlan`] on demand. It does not render audio; the worklet and the
/// export worker each build their own [`PlaybackRenderer`] from the plan.
#[wasm_bindgen]
pub struct Session {
    samples: Vec<f32>,
    sample_rate: f64,
    name: String,
    source: SourceInfo,
    analysis: AnalysisInfo,
    track: PitchTrack,
    state: EditState,
    history: History,
    midi: Option<MidiFile>,
    midi_bytes: Option<Vec<u8>>,
    plan: RenderPlan,
    plan_hop: f64,
    last_report: Option<ExportReport>,
}

#[wasm_bindgen]
impl Session {
    /// Builds a session from freshly analysed audio.
    pub fn create(
        samples: Vec<f32>,
        sample_rate: f64,
        name: String,
        analysis: &Analysis,
        params_json: &str,
    ) -> Result<Session, JsValue> {
        #[derive(serde::Deserialize, Default)]
        #[serde(rename_all = "camelCase", default)]
        struct Params {
            f0: F0Params,
            segment: SegmentParams,
        }
        let params: Params = if params_json.trim().is_empty() {
            Params::default()
        } else {
            parse(params_json)?
        };

        let duration = samples.len() as f64 / sample_rate;
        let source = SourceInfo {
            name: name.clone(),
            sample_rate: sample_rate as u32,
            channels: 1,
            frames: samples.len(),
            duration,
            fingerprint: axys_core::project::fingerprint(&samples),
            mime: None,
        };
        let info = AnalysisInfo {
            analyser_version: 1,
            f0: params.f0,
            segment: params.segment,
        };
        let mut timeline = TimelineMap::default();
        timeline.sample_rate = sample_rate;

        let state = EditState {
            blobs: analysis.blobs.clone(),
            scale: Default::default(),
            modulation: Default::default(),
            formant: FormantMode::default(),
            timeline,
            guide: None,
            mappings: Vec::new(),
            tuning: Default::default(),
            accidentals: Default::default(),
            global_bypass: false,
        };

        let mut session = Session {
            samples,
            sample_rate,
            name,
            source,
            analysis: info,
            track: analysis.track.clone(),
            state,
            history: History::new(),
            midi: None,
            midi_bytes: None,
            plan: RenderPlan::passthrough(sample_rate, duration),
            plan_hop: 0.005,
            last_report: None,
        };
        session.recompile()?;
        Ok(session)
    }

    /// Reopens a saved project against relinked source audio.
    ///
    /// Errors when the audio does not match the project's recorded fingerprint.
    #[wasm_bindgen(js_name = openProject)]
    pub fn open_project(
        project_json: &str,
        samples: Vec<f32>,
        sample_rate: f64,
    ) -> Result<Session, JsValue> {
        let project = Project::from_json(project_json).map_err(to_js)?;
        let fingerprint = axys_core::project::fingerprint(&samples);
        if fingerprint != project.source.fingerprint {
            return Err(JsValue::from_str(
                "this audio is not the file the project was made from",
            ));
        }

        let track = match project.track.clone() {
            Some(track) => track,
            None => detect_f0(&samples, sample_rate, &project.analysis.f0).map_err(to_js)?,
        };

        let midi_bytes = match &project.midi {
            Some(text) => Some(axys_core::project::from_base64(text).map_err(to_js)?),
            None => None,
        };
        let midi = match &midi_bytes {
            Some(bytes) => Some(parse_smf(bytes).map_err(to_js)?),
            None => None,
        };

        let duration = samples.len() as f64 / sample_rate;
        let mut session = Session {
            samples,
            sample_rate,
            name: project.name.clone(),
            source: project.source.clone(),
            analysis: project.analysis.clone(),
            track,
            state: project.edits.clone(),
            history: project.history.clone(),
            midi,
            midi_bytes,
            plan: RenderPlan::passthrough(sample_rate, duration),
            plan_hop: 0.005,
            last_report: None,
        };
        session.recompile()?;
        Ok(session)
    }

    fn guide_inputs(&self) -> Option<(Vec<axys_core::midi::MidiNote>, ())> {
        let selection = self.state.guide.as_ref()?;
        let file = self.midi.as_ref()?;
        Some((file.notes_of(selection.track, selection.channel), ()))
    }

    fn recompile(&mut self) -> Result<(), JsValue> {
        let duration = self.samples.len() as f64 / self.sample_rate;
        let notes = self.guide_inputs().map(|(n, _)| n);
        let guide = match (&notes, &self.state.guide) {
            (Some(notes), Some(selection)) => Some(GuideInputs {
                notes,
                mappings: &self.state.mappings,
                timeline: &self.state.timeline,
                selection,
            }),
            _ => None,
        };
        let plan = {
            let inputs = PlanInputs {
                track: &self.track,
                blobs: &self.state.blobs,
                sample_rate: self.sample_rate,
                duration,
                scale: &self.state.scale,
                modulation: &self.state.modulation,
                formant: self.state.formant,
                guide,
                bypass: self.state.global_bypass,
                hop: self.plan_hop,
            };
            compile_plan(&inputs).map_err(to_js)?
        };
        self.plan = plan;
        Ok(())
    }

    /// Applies one edit operation and recompiles the plan.
    #[wasm_bindgen(js_name = applyEdit)]
    pub fn apply_edit(&mut self, op_json: &str) -> Result<(), JsValue> {
        let op: EditOp = parse(op_json)?;
        apply(&mut self.state, Some(&self.track), &op).map_err(to_js)?;
        self.history.push(op);
        self.recompile()
    }

    /// Undoes the newest operation by replaying the history from the analysis.
    pub fn undo(&mut self) -> Result<bool, JsValue> {
        if self.history.undo().is_none() {
            return Ok(false);
        }
        self.replay()?;
        Ok(true)
    }

    /// Redoes the most recently undone operation.
    pub fn redo(&mut self) -> Result<bool, JsValue> {
        let Some(op) = self.history.redo() else {
            return Ok(false);
        };
        apply(&mut self.state, Some(&self.track), &op).map_err(to_js)?;
        self.recompile()?;
        Ok(true)
    }

    /// Rebuilds edit state from the immutable analysis by replaying the applied history.
    fn replay(&mut self) -> Result<(), JsValue> {
        let ops: Vec<EditOp> = self.history.applied().to_vec();
        let mut timeline = TimelineMap::default();
        timeline.sample_rate = self.sample_rate;
        let energy = analyse_energy(
            &self.samples,
            self.sample_rate,
            self.analysis.f0.frame_seconds,
            self.analysis.f0.hop_seconds,
        )
        .map_err(to_js)?;
        let blobs = segment(&self.track, &energy, &self.analysis.segment).map_err(to_js)?;
        self.state = EditState {
            blobs,
            scale: Default::default(),
            modulation: Default::default(),
            formant: FormantMode::default(),
            timeline,
            guide: None,
            mappings: Vec::new(),
            tuning: Default::default(),
            accidentals: Default::default(),
            global_bypass: false,
        };
        for op in &ops {
            apply(&mut self.state, Some(&self.track), op).map_err(to_js)?;
        }
        self.recompile()
    }

    /// The current edit state as JSON.
    #[wasm_bindgen(js_name = stateJson)]
    pub fn state_json(&self) -> Result<String, JsValue> {
        dump(&self.state)
    }

    /// The current blobs as JSON.
    #[wasm_bindgen(js_name = blobsJson)]
    pub fn blobs_json(&self) -> Result<String, JsValue> {
        dump(self.state.blobs.blobs())
    }

    /// Overlaps and gaps produced by timing edits, as JSON.
    #[wasm_bindgen(js_name = conflictsJson)]
    pub fn conflicts_json(&self) -> Result<String, JsValue> {
        dump(&self.state.blobs.timing_conflicts())
    }

    /// The compiled render plan as JSON.
    #[wasm_bindgen(js_name = planJson)]
    pub fn plan_json(&self) -> Result<String, JsValue> {
        dump(&self.plan)
    }

    /// Undo and redo labels, as `{ "undo": string | null, "redo": string | null }`.
    #[wasm_bindgen(js_name = historyJson)]
    pub fn history_json(&self) -> Result<String, JsValue> {
        dump(&serde_json::json!({
            "undo": self.history.undo_label(),
            "redo": self.history.redo_label(),
        }))
    }

    /// The detected pitch track as JSON.
    #[wasm_bindgen(js_name = trackJson)]
    pub fn track_json(&self) -> Result<String, JsValue> {
        dump(&self.track)
    }

    /// The imported MIDI file as JSON, or `null` when none is loaded.
    #[wasm_bindgen(js_name = midiJson)]
    pub fn midi_json(&self) -> Result<String, JsValue> {
        match &self.midi {
            Some(file) => dump(file),
            None => Ok("null".to_string()),
        }
    }

    /// Imports a MIDI guide, adopting its tempo and meter maps.
    #[wasm_bindgen(js_name = loadMidi)]
    pub fn load_midi(&mut self, bytes: Vec<u8>) -> Result<String, JsValue> {
        let file = parse_smf(&bytes).map_err(to_js)?;
        let timeline = file
            .to_timeline(self.sample_rate, self.state.timeline.origin_seconds)
            .map_err(to_js)?;
        self.state.timeline = timeline;
        let json = dump(&file)?;
        self.midi = Some(file);
        self.midi_bytes = Some(bytes);
        self.recompile()?;
        Ok(json)
    }

    /// Proposes blob-to-note mappings, keeping manual ones, and returns the report.
    #[wasm_bindgen(js_name = proposeMappings)]
    pub fn propose_mappings_js(&mut self) -> Result<String, JsValue> {
        let Some((notes, _)) = self.guide_inputs() else {
            return Err(JsValue::from_str("no MIDI guide is selected"));
        };
        let (mappings, report) = propose_mappings(
            &self.state.blobs,
            &notes,
            &self.state.timeline,
            &self.state.mappings,
        );
        self.state.mappings = mappings;
        self.recompile()?;
        dump(&report)
    }

    /// Measures alignment error between mapped blobs and their guide notes.
    #[wasm_bindgen(js_name = driftJson)]
    pub fn drift_json(&self) -> Result<String, JsValue> {
        let Some((notes, _)) = self.guide_inputs() else {
            return Ok("null".to_string());
        };
        match measure_drift(
            &self.state.blobs,
            &notes,
            &self.state.mappings,
            &self.state.timeline,
        ) {
            Some(report) => dump(&report),
            None => Ok("null".to_string()),
        }
    }

    /// Source seconds that move the given guide note onto `target_seconds`.
    #[wasm_bindgen(js_name = anchorOffset)]
    pub fn anchor_offset(&self, note_tick: f64, target_seconds: f64) -> f64 {
        axys_core::midi::anchor_offset(&self.state.timeline, note_tick.max(0.0) as u64, target_seconds)
    }

    /// Bar lines and beats in a time window, as JSON, for the ruler and snapping.
    #[wasm_bindgen(js_name = beatGridJson)]
    pub fn beat_grid_json(&self, from: f64, to: f64, division: u32) -> Result<String, JsValue> {
        dump(&self.state.timeline.beat_grid(from, to, division))
    }

    /// Snaps a time to the musical grid at `division`.
    #[wasm_bindgen(js_name = snapSeconds)]
    pub fn snap_seconds(&self, seconds: f64, division: u32) -> f64 {
        self.state.timeline.snap_seconds(seconds, division)
    }

    /// Bar and beat reading at a source time, as JSON.
    #[wasm_bindgen(js_name = barBeatJson)]
    pub fn bar_beat_json(&self, seconds: f64) -> Result<String, JsValue> {
        dump(&self.state.timeline.seconds_to_bar_beat(seconds))
    }

    /// Serialises the whole project, including the imported MIDI bytes.
    #[wasm_bindgen(js_name = projectJson)]
    pub fn project_json(&self, view_json: &str) -> Result<String, JsValue> {
        let view: ViewState = if view_json.trim().is_empty() {
            ViewState::default()
        } else {
            parse(view_json)?
        };
        let project = Project {
            schema_version: SCHEMA_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            name: self.name.clone(),
            source: self.source.clone(),
            analysis: self.analysis.clone(),
            track: Some(self.track.clone()),
            edits: self.state.clone(),
            midi: self
                .midi_bytes
                .as_ref()
                .map(|b| axys_core::project::to_base64(b)),
            view,
            history: self.history.clone(),
        };
        project.to_json().map_err(to_js)
    }

    /// Output length of the current plan, in samples.
    #[wasm_bindgen(js_name = outputFrames)]
    pub fn output_frames(&self) -> u32 {
        let renderer = Renderer::new(
            self.samples.clone(),
            &self.track,
            self.plan.clone(),
            Quality::Preview,
        );
        renderer.output_frames() as u32
    }

    /// Renders and encodes a WAV file at export quality.
    ///
    /// `start` and `end` are output seconds; pass a negative `end` for the whole
    /// output. Returns the encoded bytes; call [`Session::last_export_report`] for the
    /// peak and clipping figures.
    #[wasm_bindgen(js_name = exportWav)]
    pub fn export_wav(
        &mut self,
        start: f64,
        end: f64,
        sample_rate: u32,
        depth: &str,
    ) -> Result<Vec<u8>, JsValue> {
        let depth = match depth {
            "pcm16" => BitDepth::Pcm16,
            "pcm24" => BitDepth::Pcm24,
            "float32" => BitDepth::Float32,
            other => return Err(JsValue::from_str(&format!("unknown bit depth {other}"))),
        };
        let renderer = Renderer::new(
            self.samples.clone(),
            &self.track,
            self.plan.clone(),
            Quality::Offline,
        );
        let range = if end > start && end > 0.0 {
            Some((start.max(0.0), end))
        } else {
            None
        };
        let rendered = renderer.render_all(range);
        let resampled = if sample_rate as f64 == self.sample_rate {
            rendered
        } else {
            axys_core::dsp::resample::resample(
                &rendered,
                self.sample_rate,
                sample_rate as f64,
                16,
            )
        };
        let (bytes, report) =
            encode_wav(&[resampled], sample_rate, depth).map_err(to_js)?;
        self.last_report = Some(report);
        Ok(bytes)
    }

    /// Report from the most recent export, as JSON, or `null` before any export.
    #[wasm_bindgen(js_name = lastExportReport)]
    pub fn last_export_report(&self) -> Result<String, JsValue> {
        match &self.last_report {
            Some(report) => dump(report),
            None => Ok("null".to_string()),
        }
    }

    /// Mono source samples, for handing to the worklet.
    pub fn source(&self) -> Vec<f32> {
        self.samples.clone()
    }

    /// Source facts recorded at import, as JSON.
    #[wasm_bindgen(js_name = sourceJson)]
    pub fn source_json(&self) -> Result<String, JsValue> {
        dump(&self.source)
    }
}

/// Renders a compiled plan to audio.
///
/// Built inside the AudioWorklet and inside the export worker. `render` is pure in the
/// output position, so preview and export cannot disagree.
#[wasm_bindgen]
pub struct PlaybackRenderer {
    inner: Renderer,
}

#[wasm_bindgen]
impl PlaybackRenderer {
    /// Builds a renderer from source audio, its pitch track and a compiled plan.
    pub fn create(
        samples: Vec<f32>,
        track_json: &str,
        plan_json: &str,
        offline: bool,
    ) -> Result<PlaybackRenderer, JsValue> {
        let track: PitchTrack = parse(track_json)?;
        let plan: RenderPlan = parse(plan_json)?;
        let quality = if offline {
            Quality::Offline
        } else {
            Quality::Preview
        };
        Ok(PlaybackRenderer {
            inner: Renderer::new(samples, &track, plan, quality),
        })
    }

    /// Replaces the plan without rebuilding the epoch map.
    #[wasm_bindgen(js_name = setPlan)]
    pub fn set_plan(&mut self, plan_json: &str) -> Result<(), JsValue> {
        let plan: RenderPlan = parse(plan_json)?;
        self.inner.set_plan(plan);
        Ok(())
    }

    /// Total output length in samples.
    #[wasm_bindgen(js_name = outputFrames)]
    pub fn output_frames(&self) -> u32 {
        self.inner.output_frames() as u32
    }

    /// Renders `len` samples starting at output sample `out_start`.
    pub fn render(&self, out_start: u32, len: usize) -> Vec<f32> {
        let mut out = vec![0.0f32; len];
        self.inner.render_range(out_start as u64, &mut out);
        out
    }
}
