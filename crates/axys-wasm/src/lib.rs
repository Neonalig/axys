// SPDX-License-Identifier: AGPL-3.0-or-later

//! WebAssembly boundary for the Axys core.
//!
//! The surface is deliberately narrow. Audio crosses as typed arrays so large buffers
//! are never copied more than once, and everything structured crosses as JSON so the
//! contract is stable, versionable and testable from TypeScript without generated
//! struct bindings.
//!
//! Three entry points serve three threads: [`analyse`] runs in a worker, or
//! [`observe_span`] across a pool of workers and [`analyse_spans`] after them, [`Session`] owns
//! edit state on the main thread, and [`PlaybackRenderer`] runs inside the AudioWorklet.

use wasm_bindgen::prelude::*;

use axys_core::analysis::energy::{
    analyse_energy, observe_energy, EnergyFrames, EnergyGrid, EnergyTrack,
};
use axys_core::analysis::f0::{
    decode_f0, detect_f0, observe_f0, F0Candidates, F0Frames, F0Params, PitchFrame, PitchTrack,
};
use axys_core::analysis::segment::{segment, SegmentParams};
use axys_core::audio::wav::{encode_wav, BitDepth, ExportReport};
use axys_core::blob::{Blob, BlobSet};
use axys_core::clip::{renumber, Clip, ClipId, Reference, ReferenceId};
use axys_core::dsp::formant::FormantMode;
use axys_core::edit::{apply_in, ClipSources, EditOp, History};
use axys_core::midi::{
    measure_drift, parse_smf, propose_mappings, MappingReport, MidiFile, NoteMapping,
};
use axys_core::project::{
    AnalysisInfo, ClipMedia, EditState, Project, SourceInfo, ViewState, SCHEMA_VERSION,
};
use axys_core::render::{Quality, Renderer};
use axys_core::target::{compile_plan, GuideInputs, PlanInputs, RenderPlan, SampledCurve, TimeMap};
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

fn dump<T: serde::Serialize + ?Sized>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(json_err)
}

/// The analyser settings the boundary accepts as one JSON object.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct AnalysisParams {
    f0: F0Params,
    segment: SegmentParams,
}

impl AnalysisParams {
    /// Parses the settings, taking every default when the text is blank.
    fn from_json(json: &str) -> Result<Self, JsValue> {
        if json.trim().is_empty() {
            Ok(Self::default())
        } else {
            parse(json)
        }
    }
}

/// Rejects an analysis that cannot have come from the given audio.
fn check_fits_audio(
    track: &PitchTrack,
    blobs: &BlobSet,
    sample_rate: f64,
    frames: usize,
) -> Result<(), String> {
    if !sample_rate.is_finite() || sample_rate <= 0.0 {
        return Err(format!(
            "sample rate {sample_rate} is not a positive number"
        ));
    }
    if track.sample_rate != sample_rate {
        return Err(format!(
            "the analysis ran at {} Hz but the audio is {sample_rate} Hz",
            track.sample_rate
        ));
    }
    let duration = frames as f64 / sample_rate;
    let slack = (track.hop_seconds.max(0.0) * 2.0).max(0.05);
    if track.duration() > duration + slack {
        return Err(format!(
            "the analysis covers {:.3}s but the audio is {duration:.3}s",
            track.duration()
        ));
    }
    if let Some(last) = blobs.blobs().last() {
        if last.end > duration + slack {
            return Err(format!(
                "a blob ends at {:.3}s, past the end of the {duration:.3}s audio",
                last.end
            ));
        }
    }
    Ok(())
}

/// Converts a frequency in Hz to a fractional MIDI note number.
///
/// Returns `NaN` for non-positive or non-finite input.
/// A project's opening name, from the file it was imported from with its extension stripped.
///
/// Only the last extension goes, so `take 3.final.wav` opens as `take 3.final`. A name that is
/// only an extension keeps it, so a file called `.wav` names a project `.wav` rather than nothing.
fn project_name(file_name: &str) -> String {
    let trimmed = file_name.trim();
    match trimmed.rfind('.') {
        Some(dot) if dot > 0 => trimmed[..dot].to_string(),
        _ => trimmed.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::project_name;

    #[test]
    fn a_project_opens_named_after_its_file_without_the_extension() {
        assert_eq!(project_name("phrase.wav"), "phrase");
        assert_eq!(project_name("  Take 3.FLAC  "), "Take 3");
        assert_eq!(project_name("take 3.final.wav"), "take 3.final");
    }

    #[test]
    fn a_name_with_no_extension_to_strip_is_kept_whole() {
        assert_eq!(project_name("phrase"), "phrase");
        assert_eq!(project_name(".wav"), ".wav");
        assert_eq!(project_name(""), "");
    }
}

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
/// Rewrites a project document of any supported schema version in the current one.
#[wasm_bindgen(js_name = migrateProject)]
pub fn migrate_project(json: &str) -> Result<String, JsValue> {
    Project::from_json(json)
        .and_then(|project| project.to_json())
        .map_err(to_js)
}

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
pub fn analyse(samples: &[f32], sample_rate: f64, params_json: &str) -> Result<Analysis, JsValue> {
    let params = AnalysisParams::from_json(params_json)?;
    let track = detect_f0(samples, sample_rate, &params.f0).map_err(to_js)?;
    let energy = analyse_energy(
        samples,
        sample_rate,
        params.f0.frame_seconds,
        params.f0.hop_seconds,
    )
    .map_err(to_js)?;
    finish_analysis(track, energy, &params)
}

/// Segments a pitch and energy track into provisional blobs.
fn finish_analysis(
    track: PitchTrack,
    energy: EnergyTrack,
    params: &AnalysisParams,
) -> Result<Analysis, JsValue> {
    let blobs = segment(&track, &energy, &params.segment).map_err(to_js)?;
    Ok(Analysis {
        track,
        energy,
        blobs,
    })
}

/// Pitch candidates and energy for one span of analysis frames, measured apart from the rest.
#[wasm_bindgen]
pub struct AnalysisSpan {
    candidates: F0Candidates,
    energy: EnergyFrames,
}

#[wasm_bindgen]
impl AnalysisSpan {
    /// Candidate frequencies in Hz, every frame's back to back.
    pub fn freq(&self) -> Vec<f64> {
        self.candidates.freq().to_vec()
    }

    /// Normalised difference at each candidate lag.
    pub fn dprime(&self) -> Vec<f64> {
        self.candidates.dprime().to_vec()
    }

    /// Observation cost of each candidate.
    pub fn cost(&self) -> Vec<f64> {
        self.candidates.cost().to_vec()
    }

    /// Candidates per frame.
    pub fn counts(&self) -> Vec<u32> {
        self.candidates.counts()
    }

    /// RMS of each frame's pitch window.
    pub fn rms(&self) -> Vec<f32> {
        self.candidates.rms().to_vec()
    }

    /// RMS of each frame's energy window.
    #[wasm_bindgen(js_name = energyRms)]
    pub fn energy_rms(&self) -> Vec<f32> {
        self.energy.rms().to_vec()
    }

    /// Unnormalised spectral flux per frame.
    pub fn flux(&self) -> Vec<f32> {
        self.energy.flux().to_vec()
    }

    /// Zero-crossing rate per frame.
    pub fn zcr(&self) -> Vec<f32> {
        self.energy.zcr().to_vec()
    }
}

/// The pitch and energy frame layouts of one analysis, which share a hop grid.
struct Layouts {
    f0: F0Frames,
    energy: EnergyGrid,
}

impl Layouts {
    fn new(len: usize, sample_rate: f64, params: &AnalysisParams) -> Result<Self, JsValue> {
        let f0 = F0Frames::new(len, sample_rate, &params.f0).map_err(to_js)?;
        let energy = EnergyGrid::new(
            len,
            sample_rate,
            params.f0.frame_seconds,
            params.f0.hop_seconds,
        )
        .map_err(to_js)?;
        if f0.count() != energy.count() {
            return Err(JsValue::from_str(&format!(
                "{} pitch frames but {} energy frames",
                f0.count(),
                energy.count()
            )));
        }
        Ok(Self { f0, energy })
    }
}

/// Frames an analysis of `len` source samples yields.
#[wasm_bindgen(js_name = analysisFrameCount)]
pub fn analysis_frame_count(
    len: usize,
    sample_rate: f64,
    params_json: &str,
) -> Result<usize, JsValue> {
    let params = AnalysisParams::from_json(params_json)?;
    Ok(Layouts::new(len, sample_rate, &params)?.f0.count())
}

/// The source samples that analysis frames `first..end` read, as `[start, end]`.
#[wasm_bindgen(js_name = spanSamples)]
pub fn span_samples(
    len: usize,
    sample_rate: f64,
    params_json: &str,
    first: usize,
    end: usize,
) -> Result<Vec<u32>, JsValue> {
    let params = AnalysisParams::from_json(params_json)?;
    let layouts = Layouts::new(len, sample_rate, &params)?;
    let pitch = layouts.f0.samples_for(first..end);
    let energy = layouts.energy.samples_for(first..end);
    let start = pitch.start.min(energy.start);
    let stop = pitch.end.max(energy.end);
    Ok(vec![start as u32, stop as u32])
}

/// Measures pitch candidates and energy for frames `first..end` of an analysis over `len`
/// samples.
///
/// `window` holds the source from sample `offset` and must cover [`span_samples`] of the same
/// frames.
#[wasm_bindgen(js_name = observeSpan)]
pub fn observe_span(
    window: &[f32],
    offset: usize,
    len: usize,
    sample_rate: f64,
    params_json: &str,
    first: usize,
    end: usize,
) -> Result<AnalysisSpan, JsValue> {
    let params = AnalysisParams::from_json(params_json)?;
    let layouts = Layouts::new(len, sample_rate, &params)?;
    let candidates =
        observe_f0(&layouts.f0, &params.f0, window, offset, first..end).map_err(to_js)?;
    let energy = observe_energy(&layouts.energy, window, offset, first..end).map_err(to_js)?;
    Ok(AnalysisSpan { candidates, energy })
}

/// Finishes an analysis of `len` source samples from spans measured by [`observe_span`] and
/// joined in frame order.
///
/// Produces exactly what [`analyse`] produces for the same audio and settings.
#[wasm_bindgen(js_name = analyseSpans)]
#[allow(clippy::too_many_arguments)]
pub fn analyse_spans(
    len: usize,
    sample_rate: f64,
    params_json: &str,
    freq: Vec<f64>,
    dprime: Vec<f64>,
    cost: Vec<f64>,
    counts: &[u32],
    rms: Vec<f32>,
    energy_rms: Vec<f32>,
    flux: Vec<f32>,
    zcr: Vec<f32>,
) -> Result<Analysis, JsValue> {
    let params = AnalysisParams::from_json(params_json)?;
    let layouts = Layouts::new(len, sample_rate, &params)?;
    let candidates = F0Candidates::from_parts(freq, dprime, cost, counts, rms).map_err(to_js)?;
    let track = decode_f0(&layouts.f0, &params.f0, &candidates).map_err(to_js)?;
    let frames = EnergyFrames::from_parts(energy_rms, flux, zcr).map_err(to_js)?;
    let energy = layouts.energy.finish(frames).map_err(to_js)?;
    finish_analysis(track, energy, &params)
}

/// What an export of one output range would produce, measured before encoding.
///
/// Times are output seconds and `peak` is the largest magnitude the render reaches, so a
/// caller can warn about clipping, silence or unresolved timing before a file is written.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportPreview {
    /// Start of the range in output seconds.
    start: f64,
    /// End of the range in output seconds.
    end: f64,
    /// Frames the range would write per channel, at the project sample rate.
    frames: usize,
    /// Length of the range in seconds.
    duration: f64,
    /// Largest sample magnitude in the range.
    peak: f32,
    /// Whether the peak exceeds full scale and a fixed-point export would clamp.
    clips: bool,
    /// Timing conflicts whose span overlaps the source audio the range reads.
    conflicts: usize,
    /// Seconds of the range that map outside the source and render as silence.
    silent: f64,
}

/// A proposed set of blob-to-note mappings and what it left unmatched.
///
/// Returned without being applied, so a caller can narrow the proposal to a selection and commit
/// what it kept as one edit.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MappingProposal {
    /// The proposed mappings, covering every blob the guide could be matched against.
    mappings: Vec<NoteMapping>,
    /// Blobs and notes the proposal left unmatched or matched more than once.
    report: MappingReport,
}

/// Two guide notes that sound at once in a monophonic guide.
///
/// Note indices address the selected guide's note list, the same list a
/// [`axys_core::midi::NoteMapping`] indexes. Axys reports an overlap and never resolves it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GuideOverlap {
    /// Index of the earlier note.
    first: usize,
    /// Index of the later note.
    second: usize,
    /// MIDI key of the earlier note.
    first_key: u8,
    /// MIDI key of the later note.
    second_key: u8,
    /// Start of the shared span in source seconds.
    start_seconds: f64,
    /// End of the shared span in source seconds.
    end_seconds: f64,
}

/// One clip's audio and analysis, kept whether or not the clip is on the lane now.
///
/// A clip taken off the lane can be put back by undo, and a clip brought in by an import can be
/// taken back by undo and returned by redo, so the session keeps every clip it has seen.
struct ClipRuntime {
    id: ClipId,
    /// Mono PCM at the project rate, or `None` until a reopened project is relinked.
    samples: Option<Vec<f32>>,
    source: SourceInfo,
    analysis: AnalysisInfo,
    track: PitchTrack,
    /// Whether the track was missing from the document and must be detected on attach.
    needs_track: bool,
    /// The segmentation analysis produced, numbered for the clip.
    analysed: BlobSet,
    plan: RenderPlan,
    /// Built on first use and kept, because its epoch map costs a pass over the whole source.
    renderer: Option<Renderer>,
}

impl ClipRuntime {
    fn media(&self) -> ClipMedia {
        ClipMedia {
            clip: self.id,
            source: self.source.clone(),
            analysis: self.analysis.clone(),
            track: Some(self.track.clone()),
            blobs: self.analysed.clone(),
        }
    }
}

/// Each clip's own evidence, read by the edit applier.
struct Sources<'a>(&'a [ClipRuntime]);

impl ClipSources for Sources<'_> {
    fn track(&self, clip: ClipId) -> Option<&PitchTrack> {
        self.0
            .iter()
            .find(|runtime| runtime.id == clip)
            .map(|r| &r.track)
    }

    fn baseline(&self, clip: ClipId) -> Option<&BlobSet> {
        self.0
            .iter()
            .find(|runtime| runtime.id == clip)
            .map(|r| &r.analysed)
    }
}

/// A clip's compiled plan and where the clip sits, as the worklet and the export read it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipPlan<'a> {
    clip: ClipId,
    /// Project seconds at which the clip's output second 0 sits.
    position: f64,
    plan: &'a RenderPlan,
}

/// Audio a project needs from the device to open fully.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaList<'a> {
    /// Every clip the project or its history can put on the lane, and whether it is attached.
    clips: Vec<ClipMediaEntry<'a>>,
    /// Every reference the project or its history can bring in.
    references: &'a [Reference],
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipMediaEntry<'a> {
    clip: ClipId,
    source: &'a SourceInfo,
    attached: bool,
}

/// An editing session over the clips of one project.
///
/// Owns every clip's immutable analysis, the mutable edit state and the undo history, and
/// compiles a [`RenderPlan`] per clip on demand. Times crossing this boundary are project
/// seconds; each clip's analysis and plan stay in that clip's own source seconds.
///
/// The project's name is not a field here: it lives in [`EditState`], so renaming is undone and
/// redone with every other edit.
#[wasm_bindgen]
pub struct Session {
    sample_rate: f64,
    clips: Vec<ClipRuntime>,
    references: Vec<Reference>,
    state: EditState,
    /// The state the history replays from: the first clip's analysis, plus what no edit
    /// recorded.
    base: EditState,
    history: History,
    midi: Option<MidiFile>,
    midi_bytes: Option<Vec<u8>>,
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
        let params = AnalysisParams::from_json(params_json)?;
        Session::assemble(
            samples,
            sample_rate,
            name,
            analysis.track.clone(),
            analysis.blobs.clone(),
            params,
        )
    }

    /// Builds a session from an analysis a worker has already produced.
    ///
    /// `track_json` is a `PitchTrack` and `blobs_json` an array of `Blob`, as
    /// [`Analysis::track_json`] and [`Analysis::blobs_json`] write them. Errors when the
    /// analysis does not fit the audio.
    #[wasm_bindgen(js_name = createFromAnalysis)]
    pub fn create_from_analysis(
        samples: Vec<f32>,
        sample_rate: f64,
        name: String,
        track_json: &str,
        blobs_json: &str,
        params_json: &str,
    ) -> Result<Session, JsValue> {
        let params = AnalysisParams::from_json(params_json)?;
        let track: PitchTrack = parse(track_json)?;
        let blobs: Vec<Blob> = parse(blobs_json)?;
        let blobs = BlobSet::from_blobs(blobs).map_err(to_js)?;
        check_fits_audio(&track, &blobs, sample_rate, samples.len())
            .map_err(|message| JsValue::from_str(&message))?;
        Session::assemble(samples, sample_rate, name, track, blobs, params)
    }

    fn assemble(
        samples: Vec<f32>,
        sample_rate: f64,
        name: String,
        track: PitchTrack,
        blobs: BlobSet,
        params: AnalysisParams,
    ) -> Result<Session, JsValue> {
        let id = ClipId(0);
        let source = source_info(&name, sample_rate, &samples);
        let analysed = renumber(&blobs, id).map_err(to_js)?;
        let state = EditState {
            name: project_name(&name),
            clips: vec![Clip::new(id, source.clone(), 0.0, analysed.clone())],
            references: Vec::new(),
            scale: Default::default(),
            modulation: Default::default(),
            formant: FormantMode::default(),
            timeline: TimelineMap {
                sample_rate,
                ..TimelineMap::default()
            },
            guide: None,
            mappings: Vec::new(),
            tuning: Default::default(),
            accidentals: Default::default(),
            mixer: Default::default(),
        };
        let duration = source.duration;
        let mut session = Session {
            sample_rate,
            clips: vec![ClipRuntime {
                id,
                samples: Some(samples),
                source,
                analysis: analysis_info(&params),
                track,
                needs_track: false,
                analysed,
                plan: RenderPlan::passthrough(sample_rate, duration),
                renderer: None,
            }],
            references: Vec::new(),
            base: state.clone(),
            state,
            history: History::new(),
            midi: None,
            midi_bytes: None,
            plan_hop: 0.005,
            last_report: None,
        };
        session.recompile()?;
        Ok(session)
    }

    /// Reopens a saved project.
    ///
    /// The session can be edited and saved at once, but a clip plays and exports only once its
    /// audio is attached with [`Session::attach_clip`]; [`Session::media_json`] lists what is
    /// still missing.
    #[wasm_bindgen(js_name = openProject)]
    pub fn open_project(project_json: &str) -> Result<Session, JsValue> {
        let project = Project::from_json(project_json).map_err(to_js)?;
        let Some(first) = project.clips.first() else {
            return Err(JsValue::from_str("the project has no clips"));
        };
        let sample_rate = f64::from(first.source.sample_rate);
        let midi_bytes = match &project.midi {
            Some(text) => Some(axys_core::project::from_base64(text).map_err(to_js)?),
            None => None,
        };
        let midi = match &midi_bytes {
            Some(bytes) => Some(parse_smf(bytes).map_err(to_js)?),
            None => None,
        };
        let clips = project
            .clips
            .iter()
            .map(|media| {
                let duration = media.source.duration;
                ClipRuntime {
                    id: media.clip,
                    samples: None,
                    source: media.source.clone(),
                    analysis: media.analysis.clone(),
                    needs_track: media.track.is_none(),
                    track: media.track.clone().unwrap_or_else(|| PitchTrack {
                        sample_rate,
                        ..PitchTrack::default()
                    }),
                    analysed: media.blobs.clone(),
                    plan: RenderPlan::passthrough(sample_rate, duration),
                    renderer: None,
                }
            })
            .collect();
        let mut session = Session {
            sample_rate,
            clips,
            references: project.references.clone(),
            base: project.base.clone(),
            state: project.edits.clone(),
            history: project.history.clone(),
            midi,
            midi_bytes,
            plan_hop: 0.005,
            last_report: None,
        };
        session.recompile()?;
        Ok(session)
    }

    /// Gives a reopened project one clip's audio.
    ///
    /// Errors when the audio is not the file the clip was made from.
    #[wasm_bindgen(js_name = attachClip)]
    pub fn attach_clip(&mut self, clip: u32, samples: Vec<f32>) -> Result<(), JsValue> {
        let sample_rate = self.sample_rate;
        let Some(runtime) = self.clips.iter_mut().find(|r| r.id == ClipId(clip)) else {
            return Err(JsValue::from_str(&format!(
                "the project has no clip {clip}"
            )));
        };
        if axys_core::project::fingerprint(&samples) != runtime.source.fingerprint {
            return Err(JsValue::from_str(&format!(
                "this audio is not {}, which the project was made from",
                runtime.source.name
            )));
        }
        if runtime.needs_track {
            runtime.track =
                detect_f0(&samples, sample_rate, &runtime.analysis.f0).map_err(to_js)?;
            runtime.needs_track = false;
        }
        runtime.samples = Some(samples);
        runtime.renderer = None;
        self.recompile()
    }

    /// Imports another vocal onto the lane as one undoable edit, returning the new clip's id.
    ///
    /// `samples` must be mono at the project rate. `position` is project seconds; a position
    /// that would overlap a clip lands on the nearest free one.
    #[wasm_bindgen(js_name = addClip)]
    #[allow(clippy::too_many_arguments)]
    pub fn add_clip(
        &mut self,
        samples: Vec<f32>,
        name: String,
        track_json: &str,
        blobs_json: &str,
        params_json: &str,
        position: f64,
    ) -> Result<u32, JsValue> {
        let params = AnalysisParams::from_json(params_json)?;
        let track: PitchTrack = parse(track_json)?;
        let blobs: Vec<Blob> = parse(blobs_json)?;
        let blobs = BlobSet::from_blobs(blobs).map_err(to_js)?;
        check_fits_audio(&track, &blobs, self.sample_rate, samples.len())
            .map_err(|message| JsValue::from_str(&message))?;
        let id = ClipId(self.clips.iter().map(|r| r.id.0 + 1).max().unwrap_or(0));
        let analysed = renumber(&blobs, id).map_err(to_js)?;
        let source = source_info(&name, self.sample_rate, &samples);
        let duration = source.duration;
        self.clips.push(ClipRuntime {
            id,
            samples: Some(samples),
            source: source.clone(),
            analysis: analysis_info(&params),
            track,
            needs_track: false,
            analysed: analysed.clone(),
            plan: RenderPlan::passthrough(self.sample_rate, duration),
            renderer: None,
        });
        let op = EditOp::AddClip {
            clip: Clip::new(id, source, position, analysed),
        };
        if let Err(error) = self.apply_op(op) {
            self.clips.retain(|r| r.id != id);
            return Err(error);
        }
        Ok(id.0)
    }

    /// Brings in a reference as one undoable edit, returning its id.
    ///
    /// `source_json` is the reference's `SourceInfo`. Its audio never enters the core: it is
    /// heard in the worklet and never exported.
    #[wasm_bindgen(js_name = addReference)]
    pub fn add_reference(&mut self, source_json: &str, position: f64) -> Result<u32, JsValue> {
        let source: SourceInfo = parse(source_json)?;
        let id = ReferenceId(
            self.references
                .iter()
                .map(|r| r.id.0 + 1)
                .max()
                .unwrap_or(0),
        );
        let reference = Reference {
            id,
            source,
            position,
        };
        self.apply_op(EditOp::AddReference {
            reference: reference.clone(),
        })?;
        self.references.push(reference);
        Ok(id.0)
    }

    /// Every clip and reference the project can need, and which clips have audio attached.
    #[wasm_bindgen(js_name = mediaJson)]
    pub fn media_json(&self) -> Result<String, JsValue> {
        dump(&MediaList {
            clips: self
                .clips
                .iter()
                .map(|runtime| ClipMediaEntry {
                    clip: runtime.id,
                    source: &runtime.source,
                    attached: runtime.samples.is_some(),
                })
                .collect(),
            references: &self.references,
        })
    }

    fn guide_notes(&self) -> Option<Vec<axys_core::midi::MidiNote>> {
        let selection = self.state.guide.as_ref()?;
        let file = self.midi.as_ref()?;
        Some(file.notes_of(selection.track, selection.channel))
    }

    fn recompile(&mut self) -> Result<(), JsValue> {
        let notes = self.guide_notes();
        for runtime in &mut self.clips {
            let Some(clip) = self.state.clip(runtime.id) else {
                continue;
            };
            // The guide is placed in project seconds; a clip reads it in its own.
            let timeline = TimelineMap {
                origin_seconds: self.state.timeline.origin_seconds - clip.position,
                ..self.state.timeline.clone()
            };
            let guide = match (&notes, &self.state.guide) {
                (Some(notes), Some(selection)) => Some(GuideInputs {
                    notes,
                    mappings: &self.state.mappings,
                    timeline: &timeline,
                    selection,
                }),
                _ => None,
            };
            let inputs = PlanInputs {
                track: &runtime.track,
                blobs: &clip.blobs,
                silenced: &clip.silenced,
                sample_rate: self.sample_rate,
                duration: runtime.source.duration,
                scale: &self.state.scale,
                modulation: &self.state.modulation,
                formant: self.state.formant,
                guide,
                hop: self.plan_hop,
            };
            runtime.plan = compile_plan(&inputs).map_err(to_js)?;
            if let Some(renderer) = runtime.renderer.as_mut() {
                renderer.set_plan(runtime.plan.clone());
            }
        }
        Ok(())
    }

    /// Records and applies one operation, putting the state back as it was if it fails.
    fn apply_op(&mut self, op: EditOp) -> Result<(), JsValue> {
        // An op that fails partway, a group whose third member is refused say, has already
        // changed the state; replaying puts it back exactly as it was.
        if let Err(error) = apply_in(&mut self.state, &Sources(&self.clips), &op) {
            self.replay()?;
            return Err(to_js(error));
        }
        self.history.push(op);
        self.recompile()
    }

    /// Applies one edit operation and recompiles the plans.
    #[wasm_bindgen(js_name = applyEdit)]
    pub fn apply_edit(&mut self, op_json: &str) -> Result<(), JsValue> {
        let op: EditOp = parse(op_json)?;
        self.apply_op(op)
    }

    /// Undoes the newest operation by replaying the history from the base state.
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
        apply_in(&mut self.state, &Sources(&self.clips), &op).map_err(to_js)?;
        self.recompile()?;
        Ok(true)
    }

    /// Rebuilds edit state by replaying the applied history over the base state.
    ///
    /// The base is the analysis plus everything the history never recorded, such as the timeline
    /// a MIDI import adopted. Rebuilding from a fresh default instead threw that away on every
    /// undo, which moved the guide notes and the bar lines out from under the project.
    fn replay(&mut self) -> Result<(), JsValue> {
        let ops: Vec<EditOp> = self.history.applied().to_vec();
        self.state = self.base.clone();
        for op in &ops {
            apply_in(&mut self.state, &Sources(&self.clips), op).map_err(to_js)?;
        }
        self.recompile()
    }

    /// The current edit state as JSON.
    #[wasm_bindgen(js_name = stateJson)]
    pub fn state_json(&self) -> Result<String, JsValue> {
        dump(&self.state)
    }

    /// Every blob on the lane, in project seconds, as JSON.
    #[wasm_bindgen(js_name = blobsJson)]
    pub fn blobs_json(&self) -> Result<String, JsValue> {
        dump(self.project_blobs()?.blobs())
    }

    fn project_blobs(&self) -> Result<BlobSet, JsValue> {
        self.state.project_blobs().map_err(to_js)
    }

    /// Overlaps and gaps produced by timing edits, in project seconds, as JSON.
    #[wasm_bindgen(js_name = conflictsJson)]
    pub fn conflicts_json(&self) -> Result<String, JsValue> {
        dump(&self.project_blobs()?.timing_conflicts())
    }

    /// One plan for the whole lane in project seconds, as JSON, for the editor to draw from.
    ///
    /// The time map joins each clip's own in project seconds and the target pitch is sampled
    /// on one grid across the lane. Playback and export read the per-clip plans instead, from
    /// [`Session::clip_plans_json`].
    #[wasm_bindgen(js_name = planJson)]
    pub fn plan_json(&self) -> Result<String, JsValue> {
        dump(&self.editor_plan())
    }

    /// Each clip on the lane's own plan and position, as JSON.
    #[wasm_bindgen(js_name = clipPlansJson)]
    pub fn clip_plans_json(&self) -> Result<String, JsValue> {
        let plans: Vec<ClipPlan<'_>> = self
            .lane()
            .map(|(clip, runtime)| ClipPlan {
                clip: clip.id,
                position: clip.position,
                plan: &runtime.plan,
            })
            .collect();
        dump(&plans)
    }

    /// Clips on the lane with their runtime, in lane order.
    fn lane(&self) -> impl Iterator<Item = (&Clip, &ClipRuntime)> {
        let mut clips: Vec<&Clip> = self.state.clips.iter().collect();
        clips.sort_by(|a, b| a.position.total_cmp(&b.position));
        clips.into_iter().filter_map(|clip| {
            self.clips
                .iter()
                .find(|runtime| runtime.id == clip.id)
                .map(|runtime| (clip, runtime))
        })
    }

    fn editor_plan(&self) -> RenderPlan {
        let lane: Vec<(&Clip, &ClipRuntime)> = self.lane().collect();
        // One clip at the start of the lane is the lane: its own plan is exact, where a copy
        // resampled onto the lane grid would only be close.
        if let [(clip, runtime)] = lane.as_slice() {
            if clip.position == 0.0 {
                return runtime.plan.clone();
            }
        }
        let hop = self.plan_hop;
        let duration = self.output_seconds().max(hop);
        let count = ((duration / hop).ceil() as usize + 1).min(MAX_EDITOR_PLAN_POINTS);
        let mut ratios = vec![1.0f32; count];
        let mut targets = vec![0.0f32; count];
        let mut gains = vec![1.0f32; count];
        let mut points: Vec<(f64, f64)> = vec![(0.0, 0.0)];
        for (clip, runtime) in lane {
            let place = |values: &mut [f32], curve: &SampledCurve, neutral: f32| {
                place_on_lane(
                    values,
                    hop,
                    curve,
                    clip.position,
                    runtime.source.duration,
                    neutral,
                );
            };
            place(&mut ratios, &runtime.plan.pitch_ratio, 1.0);
            place(&mut targets, &runtime.plan.target_midi, 0.0);
            place(&mut gains, &runtime.plan.gain, 1.0);
            for (out, src) in &runtime.plan.time_map.points {
                let point = (out + clip.position, src + clip.position);
                let Some(last) = points.last() else {
                    points.push(point);
                    continue;
                };
                // Kept strictly ascending in both columns, so a clip whose tail was moved past
                // the next clip's start still reads as one monotone map.
                if point.0 > last.0 && point.1 > last.1 {
                    points.push(point);
                }
            }
        }
        if points.len() < 2 {
            points.push((duration, duration));
        }
        let curve = |values: Vec<f32>| SampledCurve {
            start: 0.0,
            hop,
            values,
        };
        RenderPlan {
            sample_rate: self.sample_rate,
            time_map: TimeMap { points },
            pitch_ratio: curve(ratios),
            target_midi: curve(targets),
            gain: curve(gains),
            formant: self.state.formant,
        }
    }
    /// Project seconds at which the last clip's output ends.
    fn output_seconds(&self) -> f64 {
        self.lane()
            .map(|(clip, runtime)| clip.position + runtime.plan.time_map.output_duration())
            .fold(0.0, f64::max)
    }

    /// Undo and redo labels, as `{ "undo": string | null, "redo": string | null }`.
    #[wasm_bindgen(js_name = historyJson)]
    pub fn history_json(&self) -> Result<String, JsValue> {
        dump(&serde_json::json!({
            "undo": self.history.undo_label(),
            "redo": self.history.redo_label(),
        }))
    }

    /// Detected pitch across the lane in project seconds, as JSON.
    ///
    /// Each clip's frames are moved to where the clip sits, with an unvoiced frame between clips
    /// so the drawn line breaks where one take ends and the next begins. Material deleted with its
    /// blobs reads as unvoiced, because it is silent. For drawing only; a renderer reads
    /// [`Session::clip_track_json`].
    #[wasm_bindgen(js_name = trackJson)]
    pub fn track_json(&self) -> Result<String, JsValue> {
        let mut frames: Vec<PitchFrame> = Vec::new();
        for (clip, runtime) in self.lane() {
            if let Some(last) = frames.last().copied() {
                frames.push(PitchFrame {
                    time: last.time + runtime.track.hop_seconds.max(1e-3),
                    f0: 0.0,
                    midi: f64::NAN,
                    confidence: 0.0,
                    rms: 0.0,
                    voiced: false,
                });
            }
            // Deleted material is silent, so nothing is drawn as sung there either.
            let silent = |time: f64| {
                clip.silenced
                    .iter()
                    .any(|span| time >= span.start && time <= span.end)
            };
            frames.extend(runtime.track.frames.iter().map(|frame| {
                let time = frame.time + clip.position;
                if silent(frame.time) {
                    PitchFrame {
                        time,
                        f0: 0.0,
                        midi: f64::NAN,
                        voiced: false,
                        ..*frame
                    }
                } else {
                    PitchFrame { time, ..*frame }
                }
            }));
        }
        dump(&PitchTrack {
            sample_rate: self.sample_rate,
            hop_seconds: self.plan_hop,
            frames,
        })
    }

    /// One clip's detected pitch in its own source seconds, as JSON, for its renderer.
    #[wasm_bindgen(js_name = clipTrackJson)]
    pub fn clip_track_json(&self, clip: u32) -> Result<String, JsValue> {
        dump(&self.runtime(ClipId(clip))?.track)
    }

    /// One clip's mono source samples, for handing to the worklet or the export worker.
    #[wasm_bindgen(js_name = clipSamples)]
    pub fn clip_samples(&self, clip: u32) -> Result<Vec<f32>, JsValue> {
        self.runtime(ClipId(clip))?
            .samples
            .clone()
            .ok_or_else(|| JsValue::from_str(&format!("clip {clip} has no audio attached")))
    }

    fn runtime(&self, clip: ClipId) -> Result<&ClipRuntime, JsValue> {
        self.clips
            .iter()
            .find(|runtime| runtime.id == clip)
            .ok_or_else(|| JsValue::from_str(&format!("the project has no clip {}", clip.0)))
    }

    /// The project sample rate every clip is held at.
    #[wasm_bindgen(js_name = sampleRate)]
    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
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
        // An import is not an edit, so the base carries it too: otherwise the first undo would
        // replay over a default timeline and lose the tempo and meter maps the file brought.
        self.base.timeline = timeline.clone();
        self.state.timeline = timeline;
        let json = dump(&file)?;
        self.midi = Some(file);
        self.midi_bytes = Some(bytes);
        self.recompile()?;
        Ok(json)
    }

    /// Proposes blob-to-note mappings without applying them.
    ///
    /// The caller decides which of the proposed mappings to keep and commits them as an
    /// [`EditOp::SetMappings`] of its own, so aligning against a selection and previewing an
    /// alignment are one edit that one undo takes back.
    #[wasm_bindgen(js_name = proposeMappingsPreview)]
    pub fn propose_mappings_preview_js(&self) -> Result<String, JsValue> {
        let Some(notes) = self.guide_notes() else {
            return Err(JsValue::from_str("no MIDI guide is selected"));
        };
        let (mappings, report) = propose_mappings(
            &self.project_blobs()?,
            &notes,
            &self.state.timeline,
            &self.state.mappings,
        );
        dump(&MappingProposal { mappings, report })
    }

    /// Proposes blob-to-note mappings, keeping manual ones, and returns the report.
    #[wasm_bindgen(js_name = proposeMappings)]
    pub fn propose_mappings_js(&mut self) -> Result<String, JsValue> {
        let Some(notes) = self.guide_notes() else {
            return Err(JsValue::from_str("no MIDI guide is selected"));
        };
        let (mappings, report) = propose_mappings(
            &self.project_blobs()?,
            &notes,
            &self.state.timeline,
            &self.state.mappings,
        );
        self.apply_op(EditOp::SetMappings { mappings })?;
        dump(&report)
    }

    /// Overlapping note pairs in the selected guide, or `[]` when no guide is selected.
    #[wasm_bindgen(js_name = guideOverlapsJson)]
    pub fn guide_overlaps_json(&self) -> Result<String, JsValue> {
        let (Some(selection), Some(file)) = (self.state.guide.as_ref(), self.midi.as_ref()) else {
            return dump::<[GuideOverlap]>(&[]);
        };
        let notes = file.notes_of(selection.track, selection.channel);
        let overlaps: Vec<GuideOverlap> = file
            .overlap_indices(selection.track, selection.channel)
            .into_iter()
            .filter_map(|(first, second)| {
                let one = notes.get(first)?;
                let two = notes.get(second)?;
                let start = one.start_tick.max(two.start_tick) as f64;
                let end = one.end_tick.min(two.end_tick) as f64;
                Some(GuideOverlap {
                    first,
                    second,
                    first_key: one.key,
                    second_key: two.key,
                    start_seconds: self.state.timeline.tick_to_seconds(start),
                    end_seconds: self.state.timeline.tick_to_seconds(end),
                })
            })
            .collect();
        dump(&overlaps)
    }

    /// Measures alignment error between mapped blobs and their guide notes.
    #[wasm_bindgen(js_name = driftJson)]
    pub fn drift_json(&self) -> Result<String, JsValue> {
        let Some(notes) = self.guide_notes() else {
            return Ok("null".to_string());
        };
        match measure_drift(
            &self.project_blobs()?,
            &notes,
            &self.state.mappings,
            &self.state.timeline,
        ) {
            Some(report) => dump(&report),
            None => Ok("null".to_string()),
        }
    }

    /// Project seconds that move the given guide note onto `target_seconds`.
    #[wasm_bindgen(js_name = anchorOffset)]
    pub fn anchor_offset(&self, note_tick: f64, target_seconds: f64) -> f64 {
        axys_core::midi::anchor_offset(
            &self.state.timeline,
            note_tick.max(0.0) as u64,
            target_seconds,
        )
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

    /// Bar and beat reading at a project time, as JSON.
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
            name: self.state.name.clone(),
            clips: self.clips.iter().map(ClipRuntime::media).collect(),
            references: self.references.clone(),
            edits: self.state.clone(),
            base: self.base.clone(),
            midi: self
                .midi_bytes
                .as_ref()
                .map(|b| axys_core::project::to_base64(b)),
            view,
            history: self.history.clone(),
        };
        project.to_json().map_err(to_js)
    }

    /// Output length of the lane, in samples.
    #[wasm_bindgen(js_name = outputFrames)]
    pub fn output_frames(&self) -> u32 {
        (self.output_seconds() * self.sample_rate).round() as u32
    }

    /// Renders every clip on the lane at export quality and mixes them into one buffer.
    ///
    /// `range` is project output seconds, or the whole lane. A clip without audio attached
    /// renders as silence.
    fn render_mix(&mut self, range: Option<(f64, f64)>) -> Vec<f32> {
        let rate = self.sample_rate;
        let (from, to) = match range {
            Some((start, end)) => (start.max(0.0), end.max(start.max(0.0))),
            None => (0.0, self.output_seconds()),
        };
        let first = (from * rate).round() as i64;
        let last = (to * rate).round() as i64;
        let mut out = vec![0.0f32; (last - first).max(0) as usize];
        let placements: Vec<(ClipId, f64)> = self
            .lane()
            .map(|(clip, _)| (clip.id, clip.position))
            .collect();
        for (id, position) in placements {
            let Some(runtime) = self.clips.iter_mut().find(|runtime| runtime.id == id) else {
                continue;
            };
            let Some(samples) = runtime.samples.as_ref() else {
                continue;
            };
            let length = runtime.plan.time_map.output_duration();
            let local_from = (from - position).max(0.0);
            let local_to = (to - position).min(length);
            if local_to <= local_from {
                continue;
            }
            let renderer = runtime.renderer.get_or_insert_with(|| {
                Renderer::new(
                    samples.clone(),
                    &runtime.track,
                    runtime.plan.clone(),
                    Quality::Offline,
                )
            });
            let rendered = renderer.render_all(Some((local_from, local_to)));
            let offset = ((position + local_from) * rate).round() as i64 - first;
            for (index, sample) in rendered.iter().enumerate() {
                let at = offset + index as i64;
                if at >= 0 {
                    if let Some(slot) = out.get_mut(at as usize) {
                        *slot += *sample;
                    }
                }
            }
        }
        out
    }

    /// Renders and encodes a WAV file at export quality.
    ///
    /// `start` and `end` are project output seconds; pass a negative `end` for the whole
    /// lane. Returns the encoded bytes; call [`Session::last_export_report`] for the peak and
    /// clipping figures.
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
        self.require_audio()?;
        let range = if end > start && end > 0.0 {
            Some((start.max(0.0), end))
        } else {
            None
        };
        let rendered = self.render_mix(range);
        let resampled = if f64::from(sample_rate) == self.sample_rate {
            rendered
        } else {
            axys_core::dsp::resample::resample(
                &rendered,
                self.sample_rate,
                f64::from(sample_rate),
                16,
            )
        };
        let (bytes, report) = encode_wav(&[resampled], sample_rate, depth).map_err(to_js)?;
        self.last_report = Some(report);
        Ok(bytes)
    }

    /// Refuses an export while a clip on the lane has no audio, which would write it as silence.
    fn require_audio(&self) -> Result<(), JsValue> {
        for (clip, runtime) in self.lane() {
            if runtime.samples.is_none() {
                return Err(JsValue::from_str(&format!(
                    "relink {} before exporting",
                    clip.source.name
                )));
            }
        }
        Ok(())
    }

    /// Describes what exporting an output range would produce, without encoding a file.
    ///
    /// `start` and `end` are project output seconds; pass a negative `end` for the whole lane.
    /// Returns an [`ExportPreview`] as JSON so the range can be reviewed before the user
    /// commits to a file.
    #[wasm_bindgen(js_name = exportPreview)]
    pub fn export_preview(&mut self, start: f64, end: f64) -> Result<String, JsValue> {
        let ranged = end > start && end > 0.0;
        let range = if ranged {
            Some((start.max(0.0), end))
        } else {
            None
        };
        let rendered = self.render_mix(range);
        let rate = self.sample_rate;
        let first = if ranged {
            (start.max(0.0) * rate).round().max(0.0)
        } else {
            0.0
        };
        let from = first / rate;
        let duration = rendered.len() as f64 / rate;
        let to = from + duration;

        let mut peak = 0.0f32;
        for sample in &rendered {
            peak = peak.max(sample.abs());
        }

        let placements: Vec<(f64, &RenderPlan, f64)> = self
            .lane()
            .filter(|(_, runtime)| runtime.samples.is_some())
            .map(|(clip, runtime)| (clip.position, &runtime.plan, runtime.source.duration))
            .collect();
        let silent = (0..rendered.len())
            .filter(|i| {
                let seconds = from + *i as f64 / rate;
                !placements.iter().any(|(position, plan, length)| {
                    let local = seconds - position;
                    if local < 0.0 || local > plan.time_map.output_duration() {
                        return false;
                    }
                    let source = plan.time_map.source_at(local);
                    source.is_finite() && source >= 0.0 && source < *length
                })
            })
            .count();

        let conflicts = self
            .project_blobs()?
            .timing_conflicts()
            .iter()
            .filter(|c| c.end >= from && c.start <= to)
            .count();

        dump(&ExportPreview {
            start: from,
            end: to,
            frames: rendered.len(),
            duration,
            peak,
            clips: peak > 1.0,
            conflicts,
            silent: silent as f64 / rate,
        })
    }

    /// Report from the most recent export, as JSON, or `null` before any export.
    #[wasm_bindgen(js_name = lastExportReport)]
    pub fn last_export_report(&self) -> Result<String, JsValue> {
        match &self.last_report {
            Some(report) => dump(report),
            None => Ok("null".to_string()),
        }
    }
}

/// Most samples the editor's lane-wide target pitch carries: an hour at the plan hop.
const MAX_EDITOR_PLAN_POINTS: usize = 720_001;

/// Copies a clip's curve onto the lane grid where the clip sits, leaving `neutral` samples alone.
///
/// Nearest sample, never an interpolation: mixing an edited sample with the neutral one beside
/// it draws a line plunging towards MIDI zero at every span edge.
fn place_on_lane(
    values: &mut [f32],
    hop: f64,
    curve: &SampledCurve,
    position: f64,
    length: f64,
    neutral: f32,
) {
    if curve.hop.is_nan() || curve.hop <= 0.0 {
        return;
    }
    for (index, slot) in values.iter_mut().enumerate() {
        let local = index as f64 * hop - position - curve.start;
        if local < 0.0 || local > length {
            continue;
        }
        let nearest = (local / curve.hop).round() as usize;
        if let Some(value) = curve.values.get(nearest) {
            if *value != neutral {
                *slot = *value;
            }
        }
    }
}

/// Facts recorded about mono PCM at import.
fn source_info(name: &str, sample_rate: f64, samples: &[f32]) -> SourceInfo {
    SourceInfo {
        name: name.to_string(),
        sample_rate: sample_rate as u32,
        channels: 1,
        frames: samples.len(),
        duration: samples.len() as f64 / sample_rate,
        fingerprint: axys_core::project::fingerprint(samples),
        mime: None,
    }
}

fn analysis_info(params: &AnalysisParams) -> AnalysisInfo {
    AnalysisInfo {
        analyser_version: 1,
        f0: params.f0,
        segment: params.segment,
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

#[cfg(test)]
mod analysis_handoff_tests {
    use super::*;

    const SAMPLE_RATE: f64 = 16_000.0;

    /// A one second tone with a gap in the middle, so segmentation yields two blobs.
    fn tone() -> Vec<f32> {
        let frames = SAMPLE_RATE as usize;
        (0..frames)
            .map(|i| {
                let t = i as f64 / SAMPLE_RATE;
                if (0.45..0.55).contains(&t) {
                    return 0.0;
                }
                (std::f64::consts::TAU * 220.0 * t).sin() as f32 * 0.5
            })
            .collect()
    }

    fn analysed() -> (Vec<f32>, Analysis) {
        let samples = tone();
        let analysis = analyse(&samples, SAMPLE_RATE, "").expect("analysis");
        (samples, analysis)
    }

    /// A session with the tone as clip 0 and the tone again as clip 1 at `position`.
    fn two_clips(position: f64) -> (Session, u32) {
        let (samples, analysis) = analysed();
        let mut session = Session::create(
            samples.clone(),
            SAMPLE_RATE,
            "take".to_string(),
            &analysis,
            "",
        )
        .expect("session");
        let clip = session
            .add_clip(
                samples,
                "second.wav".to_string(),
                &analysis.track_json().expect("track"),
                &analysis.blobs_json().expect("blobs"),
                "",
                position,
            )
            .expect("second clip");
        (session, clip)
    }

    fn json(text: String) -> serde_json::Value {
        serde_json::from_str(&text).expect("json")
    }

    #[test]
    fn a_second_clip_sits_where_it_was_put_with_its_own_blobs() {
        let (session, clip) = two_clips(3.0);
        assert_eq!(clip, 1);
        let blobs = json(session.blobs_json().expect("blobs"));
        let blobs = blobs.as_array().expect("array");
        let ids: Vec<u64> = blobs.iter().map(|b| b["id"].as_u64().unwrap()).collect();
        let first_of_clip = u64::from(ClipId(1).first_blob().0);
        assert!(ids.iter().any(|id| *id >= first_of_clip));
        let later = blobs
            .iter()
            .find(|b| b["id"].as_u64().unwrap() >= first_of_clip)
            .unwrap();
        assert!(later["start"].as_f64().unwrap() >= 3.0);

        let plans = json(session.clip_plans_json().expect("plans"));
        assert_eq!(plans.as_array().expect("array").len(), 2);
        assert_eq!(plans[1]["position"], serde_json::json!(3.0));
        assert_eq!(session.output_frames(), (4.0 * SAMPLE_RATE) as u32);
    }

    #[test]
    fn a_clip_dropped_over_another_moves_beside_it() {
        let (session, _) = two_clips(0.4);
        let state = json(session.state_json().expect("state"));
        assert_eq!(state["clips"][1]["position"], serde_json::json!(1.0));
    }

    #[test]
    fn undoing_an_import_takes_the_clip_off_the_lane_and_redo_returns_it() {
        let (mut session, _) = two_clips(3.0);
        assert!(session.undo().expect("undo"));
        let state = json(session.state_json().expect("state"));
        assert_eq!(state["clips"].as_array().expect("clips").len(), 1);
        assert!(session.redo().expect("redo"));
        let state = json(session.state_json().expect("state"));
        assert_eq!(state["clips"].as_array().expect("clips").len(), 2);
    }

    #[test]
    fn the_export_mixes_every_clip_at_its_position() {
        let (mut session, _) = two_clips(2.0);
        let bytes = session
            .export_wav(0.0, -1.0, 16_000, "float32")
            .expect("wav");
        let report = json(session.last_export_report().expect("report"));
        assert_eq!(report["frames"], serde_json::json!(3 * 16_000));
        assert!(bytes.len() > 3 * 16_000 * 4);
        let preview = json(session.export_preview(0.0, -1.0).expect("preview"));
        // The second between the clips has nothing under it.
        let silent = preview["silent"].as_f64().expect("silent");
        assert!((silent - 1.0).abs() < 0.01, "{silent}");
    }

    #[test]
    fn a_reopened_project_needs_every_clip_before_it_exports() {
        let (session, _) = two_clips(2.0);
        let project = session.project_json("").expect("project");
        let mut reopened = Session::open_project(&project).expect("reopened");
        let media = json(reopened.media_json().expect("media"));
        assert_eq!(media["clips"].as_array().expect("clips").len(), 2);
        assert_eq!(media["clips"][0]["attached"], serde_json::json!(false));
        let samples = tone();
        reopened.attach_clip(0, samples.clone()).expect("first");
        reopened.attach_clip(1, samples).expect("second");
        let media = json(reopened.media_json().expect("media"));
        assert_eq!(media["clips"][1]["attached"], serde_json::json!(true));
        assert!(reopened.export_wav(0.0, -1.0, 16_000, "pcm16").is_ok());
    }

    #[test]
    fn an_edit_in_project_seconds_reaches_the_second_clip() {
        let (mut session, _) = two_clips(3.0);
        let blobs = json(session.blobs_json().expect("blobs"));
        let later = blobs
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["start"].as_f64().unwrap() >= 3.0)
            .cloned()
            .unwrap();
        let id = later["id"].as_u64().unwrap();
        let middle = (later["start"].as_f64().unwrap() + later["end"].as_f64().unwrap()) / 2.0;
        session
            .apply_edit(&format!(
                r#"{{"type":"splitBlob","blob":{id},"time":{middle}}}"#
            ))
            .expect("split");
        let after = json(session.blobs_json().expect("blobs"));
        assert_eq!(
            after.as_array().unwrap().len(),
            blobs.as_array().unwrap().len() + 1
        );
    }

    #[test]
    fn create_from_analysis_matches_create() {
        let (samples, analysis) = analysed();
        let direct = Session::create(
            samples.clone(),
            SAMPLE_RATE,
            "take".to_string(),
            &analysis,
            "",
        )
        .expect("session");
        let rebuilt = Session::create_from_analysis(
            samples,
            SAMPLE_RATE,
            "take".to_string(),
            &analysis.track_json().expect("track json"),
            &analysis.blobs_json().expect("blobs json"),
            "",
        )
        .expect("session");

        assert_eq!(
            direct.state_json().expect("a"),
            rebuilt.state_json().expect("b")
        );
        assert_eq!(
            direct.blobs_json().expect("a"),
            rebuilt.blobs_json().expect("b")
        );
        assert_eq!(
            direct.plan_json().expect("a"),
            rebuilt.plan_json().expect("b")
        );
        assert_eq!(
            direct.media_json().expect("a"),
            rebuilt.media_json().expect("b")
        );
    }

    #[test]
    fn inconsistent_analysis_is_rejected() {
        let (samples, analysis) = analysed();
        let half = samples.len() / 2;
        let message = check_fits_audio(&analysis.track, &analysis.blobs, SAMPLE_RATE, half)
            .expect_err("half the audio cannot hold the whole analysis");
        assert!(message.contains("covers"), "{message}");

        assert!(check_fits_audio(
            &analysis.track,
            &analysis.blobs,
            SAMPLE_RATE * 2.0,
            samples.len()
        )
        .is_err());
        assert!(
            check_fits_audio(&analysis.track, &analysis.blobs, SAMPLE_RATE, samples.len()).is_ok()
        );
    }

    #[test]
    fn undo_restores_the_pre_edit_state() {
        let (samples, analysis) = analysed();
        let mut session = Session::create_from_analysis(
            samples,
            SAMPLE_RATE,
            "take".to_string(),
            &analysis.track_json().expect("track json"),
            &analysis.blobs_json().expect("blobs json"),
            "",
        )
        .expect("session");
        let before = session.state_json().expect("state");
        let plan_before = session.plan_json().expect("plan");

        let first = analysis.blobs.blobs().first().expect("a blob").id.0;
        session
            .apply_edit(&format!(
                r#"{{"type":"setPitchOffset","blob":{first},"semitones":2.5}}"#
            ))
            .expect("edit");
        assert_ne!(session.state_json().expect("state"), before);

        assert!(session.undo().expect("undo"));
        assert_eq!(session.state_json().expect("state"), before);
        assert_eq!(session.plan_json().expect("plan"), plan_before);
    }

    /// A Standard MIDI File carrying a tempo and a division the defaults do not use.
    fn smf_with_tempo() -> Vec<u8> {
        let mut bytes = b"MThd".to_vec();
        bytes.extend_from_slice(&6u32.to_be_bytes());
        bytes.extend_from_slice(&0u16.to_be_bytes());
        bytes.extend_from_slice(&1u16.to_be_bytes());
        bytes.extend_from_slice(&960u16.to_be_bytes());
        let mut track: Vec<u8> = Vec::new();
        // 150 bpm, so the imported timeline cannot be mistaken for the default.
        track.extend_from_slice(&[0x00, 0xFF, 0x51, 0x03, 0x06, 0x1A, 0x80]);
        track.extend_from_slice(&[0x00, 0xFF, 0x2F, 0x00]);
        bytes.extend_from_slice(b"MTrk");
        bytes.extend_from_slice(&(track.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&track);
        bytes
    }

    /// An undo used to replay over a default timeline, which threw away what a MIDI import had
    /// adopted and moved every guide note and bar line.
    #[test]
    fn undo_keeps_the_timeline_a_midi_import_adopted() {
        let (samples, analysis) = analysed();
        let mut session = Session::create(samples, SAMPLE_RATE, "take".to_string(), &analysis, "")
            .expect("session");
        let fresh = session.state_json().expect("state");
        session.load_midi(smf_with_tempo()).expect("midi");
        let before = session.state_json().expect("state");
        assert_ne!(before, fresh, "the import has to change the timeline");

        let first = analysis.blobs.blobs().first().expect("a blob").id.0;
        session
            .apply_edit(&format!(
                r#"{{"type":"setPitchOffset","blob":{first},"semitones":1.0}}"#
            ))
            .expect("edit");
        assert!(session.undo().expect("undo"));

        assert_eq!(session.state_json().expect("state"), before);
    }

    /// Reopening and undoing used to reset everything the history never recorded.
    #[test]
    fn undo_in_a_reopened_project_keeps_what_the_history_never_recorded() {
        let (samples, analysis) = analysed();
        let mut session = Session::create(
            samples.clone(),
            SAMPLE_RATE,
            "take".to_string(),
            &analysis,
            "",
        )
        .expect("session");
        session.load_midi(smf_with_tempo()).expect("midi");
        let project = session.project_json("").expect("project");

        let mut reopened = Session::open_project(&project).expect("reopened session");
        reopened.attach_clip(0, samples).expect("attached");
        let before = reopened.state_json().expect("state");
        let first = analysis.blobs.blobs().first().expect("a blob").id.0;
        reopened
            .apply_edit(&format!(
                r#"{{"type":"setPitchOffset","blob":{first},"semitones":-1.0}}"#
            ))
            .expect("edit");

        assert!(reopened.undo().expect("undo"));
        assert_eq!(reopened.state_json().expect("state"), before);
    }

    /// A group is one entry in the history however many operations it carries.
    #[test]
    fn a_group_undoes_in_one_step() {
        let (samples, analysis) = analysed();
        let mut session = Session::create(samples, SAMPLE_RATE, "take".to_string(), &analysis, "")
            .expect("session");
        let before = session.state_json().expect("state");
        let first = analysis.blobs.blobs().first().expect("a blob").id.0;

        session
            .apply_edit(&format!(
                r#"{{"type":"group","ops":[{{"type":"setExcluded","blob":{first},"excluded":true}},{{"type":"setTuning","tuning":{{"a4Hz":442.0}}}}]}}"#
            ))
            .expect("group");
        assert_ne!(session.state_json().expect("state"), before);

        assert!(session.undo().expect("undo"));
        assert_eq!(session.state_json().expect("state"), before);
        assert!(!session.undo().expect("undo"), "the group was one step");
    }

    #[test]
    fn undo_in_a_reopened_project_resegments_to_the_same_state() {
        let (samples, analysis) = analysed();
        let session = Session::create(
            samples.clone(),
            SAMPLE_RATE,
            "take".to_string(),
            &analysis,
            "",
        )
        .expect("session");
        let project = session.project_json("").expect("project");

        let mut reopened = Session::open_project(&project).expect("reopened session");
        reopened.attach_clip(0, samples).expect("attached");
        let before = reopened.state_json().expect("state");
        let first = analysis.blobs.blobs().first().expect("a blob").id.0;
        reopened
            .apply_edit(&format!(
                r#"{{"type":"setPitchOffset","blob":{first},"semitones":-1.0}}"#
            ))
            .expect("edit");

        assert!(reopened.undo().expect("undo"));
        assert_eq!(reopened.state_json().expect("state"), before);
    }
}

#[cfg(test)]
mod export_preview_tests {
    use super::*;

    const RATE: f64 = 48_000.0;

    /// A one-second 220 Hz tone, loud enough to segment and analyse.
    fn tone() -> Vec<f32> {
        (0..RATE as usize)
            .map(|i| {
                let t = i as f64 / RATE;
                (0.5 * (std::f64::consts::TAU * 220.0 * t).sin()) as f32
            })
            .collect()
    }

    fn session() -> Session {
        let samples = tone();
        let analysis = analyse(&samples, RATE, "").expect("analysis");
        Session::create(samples, RATE, "tone".into(), &analysis, "").expect("session")
    }

    fn preview(session: &mut Session, start: f64, end: f64) -> serde_json::Value {
        let json = session.export_preview(start, end).expect("preview");
        serde_json::from_str(&json).expect("preview json")
    }

    #[test]
    fn export_preview_reports_the_range_it_would_write() {
        let mut session = session();
        let whole = preview(&mut session, 0.0, -1.0);
        for key in [
            "start",
            "end",
            "frames",
            "duration",
            "peak",
            "clips",
            "conflicts",
            "silent",
        ] {
            assert!(whole.get(key).is_some(), "{key} is missing from {whole}");
        }
        assert_eq!(
            whole["frames"].as_u64(),
            Some(session.output_frames() as u64)
        );
        assert_eq!(whole["clips"].as_bool(), Some(false));
        assert_eq!(whole["conflicts"].as_u64(), Some(0));
        assert!(whole["peak"].as_f64().unwrap_or(0.0) > 0.0);
        assert!((whole["duration"].as_f64().unwrap_or(0.0) - 1.0).abs() < 0.01);

        let half = preview(&mut session, 0.25, 0.75);
        assert_eq!(half["frames"].as_u64(), Some(RATE as u64 / 2));
        assert!((half["start"].as_f64().unwrap_or(-1.0) - 0.25).abs() < 1e-9);
        assert!((half["end"].as_f64().unwrap_or(-1.0) - 0.75).abs() < 1e-9);
        assert_eq!(half["silent"].as_f64(), Some(0.0));
    }

    #[test]
    fn a_range_past_the_end_previews_as_silence() {
        let mut session = session();
        let past = preview(&mut session, 5.0, 6.0);
        assert_eq!(past["frames"].as_u64(), Some(RATE as u64));
        assert_eq!(past["peak"].as_f64(), Some(0.0));
        assert_eq!(past["clips"].as_bool(), Some(false));
        assert!((past["silent"].as_f64().unwrap_or(0.0) - 1.0).abs() < 1e-9);
    }
}

#[cfg(test)]
mod guide_mapping_tests {
    use super::*;

    const RATE: f64 = 16_000.0;

    /// Four seconds of tone broken by short gaps, so segmentation yields several blobs.
    fn tone() -> Vec<f32> {
        let frames = (RATE * 4.0) as usize;
        (0..frames)
            .map(|i| {
                let t = i as f64 / RATE;
                if (t % 1.0) > 0.9 {
                    return 0.0;
                }
                (0.5 * (std::f64::consts::TAU * 220.0 * t).sin()) as f32
            })
            .collect()
    }

    /// A session over that tone with melody.mid loaded and track 0 selected as the guide.
    fn guided() -> Session {
        let samples = tone();
        let analysis = analyse(&samples, RATE, "").expect("analysis");
        let mut session =
            Session::create(samples, RATE, "take".to_string(), &analysis, "").expect("session");
        let bytes = std::fs::read("../../fixtures/midi/melody.mid").expect("melody fixture");
        session.load_midi(bytes).expect("midi");
        session
            .apply_edit(
                r#"{"type":"setGuide","selection":{"track":0,"channel":null,"mode":"combined","strength":1.0,"muted":false}}"#,
            )
            .expect("guide");
        session
    }

    fn mappings(session: &Session) -> serde_json::Value {
        let state: serde_json::Value =
            serde_json::from_str(&session.state_json().expect("state")).expect("state json");
        state["mappings"].clone()
    }

    #[test]
    fn proposing_mappings_is_one_undo_step() {
        let mut session = guided();
        assert_eq!(mappings(&session).as_array().map(Vec::len), Some(0));
        session.propose_mappings_js().expect("propose");
        let proposed = mappings(&session);
        assert!(proposed.as_array().is_some_and(|m| !m.is_empty()));

        let history: serde_json::Value =
            serde_json::from_str(&session.history_json().expect("history")).expect("history json");
        assert_eq!(history["undo"].as_str(), Some("Set Mappings"));

        assert!(session.undo().expect("undo"));
        assert_eq!(mappings(&session).as_array().map(Vec::len), Some(0));

        assert!(session.redo().expect("redo"));
        assert_eq!(mappings(&session), proposed);
    }

    #[test]
    fn undoing_an_override_restores_the_proposed_mappings() {
        let mut session = guided();
        session.propose_mappings_js().expect("propose");
        let proposed = mappings(&session);
        let blob = proposed[0]["blob"].as_u64().expect("a mapped blob");

        session
            .apply_edit(&format!(
                r#"{{"type":"setMapping","mapping":{{"blob":{blob},"note":0,"manual":true,"optedOut":false}}}}"#
            ))
            .expect("override");
        assert_ne!(mappings(&session), proposed);

        assert!(session.undo().expect("undo"));
        assert_eq!(mappings(&session), proposed);
    }
}
