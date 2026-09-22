// SPDX-License-Identifier: AGPL-3.0-or-later
use axys_core::analysis::f0::{detect_f0, F0Params};
use axys_core::audio::wav::decode_wav;
use axys_core::render::{Quality, Renderer};
use axys_core::target::{RenderPlan, TimeMap};

fn envelope(samples: &[f32], window: usize) -> Vec<f32> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + window <= samples.len() {
        let s: f64 = samples[i..i + window].iter().map(|v| (*v as f64).powi(2)).sum();
        out.push((s / window as f64).sqrt() as f32);
        i += window;
    }
    out
}

#[test]
fn burst_diag() {
    let bytes = std::fs::read("../../fixtures/audio/consonants.wav").unwrap();
    let decoded = decode_wav(&bytes).unwrap();
    let mono = decoded.to_mono();
    let sr = decoded.sample_rate as f64;
    let track = detect_f0(&mono, sr, &F0Params::default()).unwrap();
    let duration = mono.len() as f64 / sr;
    let stretch = 1.4;
    let mut plan = RenderPlan::passthrough(sr, duration);
    plan.time_map = TimeMap::from_points(vec![(0.0, 0.0), (duration * stretch, duration)]).unwrap();
    let r = Renderer::new(mono.clone(), &track, plan, Quality::Offline);
    let out = r.render_all(None);
    let window = (0.005 * sr).round() as usize;
    let se = envelope(&mono, window);
    let re = envelope(&out, window);
    let over = |e: &[f32]| e.iter().filter(|&&v| v > 0.12).count();
    println!("source windows over 0.12: {} of {}", over(&se), se.len());
    println!("rendered windows over 0.12: {} of {}", over(&re), re.len());
    let mut sorted: Vec<f32> = re.clone();
    sorted.sort_by(|a, b| b.partial_cmp(a).unwrap());
    println!("top rendered {:?}", &sorted[..20.min(sorted.len())]);
    let mut ss: Vec<f32> = se.clone();
    ss.sort_by(|a, b| b.partial_cmp(a).unwrap());
    println!("top source   {:?}", &ss[..20.min(ss.len())]);
}

#[test]
fn stretch_levels() {
    let bytes = std::fs::read("../../fixtures/audio/consonants.wav").unwrap();
    let decoded = decode_wav(&bytes).unwrap();
    let mono = decoded.to_mono();
    let sr = decoded.sample_rate as f64;
    let track = detect_f0(&mono, sr, &F0Params::default()).unwrap();
    let duration = mono.len() as f64 / sr;
    for stretch in [1.0f64, 1.05, 1.2, 1.4, 2.0] {
        let mut plan = RenderPlan::passthrough(sr, duration);
        plan.time_map =
            TimeMap::from_points(vec![(0.0, 0.0), (duration * stretch, duration)]).unwrap();
        let r = Renderer::new(mono.clone(), &track, plan, Quality::Offline);
        let out = r.render_all(None);
        // A vowel region: 0.9-1.2 s of source maps to stretch*that in output.
        let sa = (0.9 * sr) as usize;
        let sb = (1.2 * sr) as usize;
        let oa = (0.9 * stretch * sr) as usize;
        let ob = (1.2 * stretch * sr) as usize;
        let sr_ = axys_core::dsp::window::rms(&mono[sa..sb]);
        let or_ = axys_core::dsp::window::rms(&out[oa..ob.min(out.len())]);
        println!("stretch {stretch}: vowel rms src {sr_:.4} out {or_:.4} ratio {:.3}", or_ / sr_);
    }
}
