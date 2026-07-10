//! PROTOTYPE: local persona-recognition quality spike.
//!
//! This binary is intentionally isolated from June's production crate. It
//! answers whether diarized speaker clusters produce cross-meeting embeddings
//! with enough genuine/impostor separation to justify Phase 1.

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
    SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig,
};
use std::{
    collections::{BTreeMap, HashMap},
    env,
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    time::Instant,
};

const TARGET_SAMPLE_RATE: u32 = 16_000;
const SHERPA_VERSION: &str = "1.13.4";

type LabelMap = HashMap<String, HashMap<String, String>>;

#[derive(Debug)]
struct Args {
    segmentation_model: PathBuf,
    embedding_model: PathBuf,
    output_dir: PathBuf,
    label_map: LabelMap,
    non_interactive: bool,
    resampler_smoke: bool,
    wavs: Vec<PathBuf>,
}

#[derive(Debug)]
struct PreparedWave {
    samples: Vec<f32>,
    duration_seconds: f64,
}

#[derive(Debug)]
struct LabeledEmbedding {
    recording_index: usize,
    label: String,
    embedding: Vec<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    prototype: &'static str,
    runtime: RuntimeReport,
    recordings: Vec<RecordingReport>,
    cluster_quality: ClusterQualityReport,
    scores: ScoreReport,
    verdict: VerdictReport,
    privacy: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReport {
    sherpa_onnx_version: &'static str,
    native_archive: String,
    native_archive_sha256: String,
    segmentation_model_bytes: u64,
    segmentation_model_sha256: String,
    embedding_model_bytes: u64,
    embedding_model_sha256: String,
    provider: &'static str,
    resampler_smoke: Option<ResamplerSmokeReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingReport {
    recording_index: usize,
    filename: String,
    duration_seconds: f64,
    diarization_seconds: f64,
    embedding_seconds: f64,
    inference_seconds: f64,
    real_time_factor: f64,
    clusters: Vec<ClusterReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClusterReport {
    speaker_index: i32,
    segment_count: usize,
    speech_seconds: f64,
    label: Option<String>,
    mixed: bool,
    embedding_available: bool,
    listening_wav: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClusterQualityReport {
    total_recordings: usize,
    contributing_recordings: usize,
    total_clusters: usize,
    labeled_clusters: usize,
    unknown_clusters: usize,
    mixed_clusters: usize,
    missing_embeddings: usize,
    fragmented_identities: usize,
    scored_cluster_coverage: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResamplerSmokeReport {
    input_sample_rate: u32,
    output_sample_rate: u32,
    passband_tone_hz: u32,
    passband_rms: f32,
    rejected_tone_hz: u32,
    rejected_tone_rms: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScoreReport {
    genuine: Distribution,
    impostor: Distribution,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Distribution {
    count: usize,
    min: Option<f32>,
    max: Option<f32>,
    mean: Option<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerdictReport {
    status: &'static str,
    reason: String,
    suggest_threshold_ballpark: Option<f32>,
    auto_threshold_ballpark: Option<f32>,
    caveat: &'static str,
}

fn main() -> Result<()> {
    let args = parse_args()?;
    reject_duplicate_inputs(&args.wavs)?;
    let native_archive = env!("PERSONA_SPIKE_NATIVE_ARCHIVE").to_string();
    let native_archive_sha256 = env!("PERSONA_SPIKE_NATIVE_ARCHIVE_SHA256").to_string();
    let resampler_smoke = args.resampler_smoke.then(run_resampler_smoke).transpose()?;
    fs::create_dir_all(&args.output_dir)
        .with_context(|| format!("create output dir {}", args.output_dir.display()))?;

    let segmentation_model = args.segmentation_model.to_string_lossy().into_owned();
    let embedding_model = args.embedding_model.to_string_lossy().into_owned();
    let embedding_config = SpeakerEmbeddingExtractorConfig {
        model: Some(embedding_model),
        num_threads: 2,
        debug: false,
        provider: Some("cpu".into()),
    };
    let diarization_config = OfflineSpeakerDiarizationConfig {
        segmentation: OfflineSpeakerSegmentationModelConfig {
            pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                model: Some(segmentation_model),
            },
            num_threads: 2,
            debug: false,
            provider: Some("cpu".into()),
        },
        embedding: embedding_config.clone(),
        clustering: FastClusteringConfig {
            num_clusters: -1,
            threshold: 0.5,
        },
        ..Default::default()
    };
    let diarizer = OfflineSpeakerDiarization::create(&diarization_config)
        .ok_or_else(|| anyhow!("initialize sherpa-onnx diarizer"))?;
    if diarizer.sample_rate() != TARGET_SAMPLE_RATE as i32 {
        bail!(
            "unexpected diarizer sample rate: {}",
            diarizer.sample_rate()
        );
    }
    let extractor = SpeakerEmbeddingExtractor::create(&embedding_config)
        .ok_or_else(|| anyhow!("initialize sherpa-onnx embedding extractor"))?;

    let mut reports = Vec::new();
    let mut labeled_embeddings = Vec::new();
    for (recording_index, wav_path) in args.wavs.iter().enumerate() {
        let filename = wav_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("recording.wav")
            .to_string();
        println!("\nProcessing {}", wav_path.display());
        let wave = read_and_prepare_wav(wav_path)?;

        let diarization_started = Instant::now();
        let result = diarizer
            .process(&wave.samples)
            .ok_or_else(|| anyhow!("diarize {}", wav_path.display()))?;
        let diarization_seconds = diarization_started.elapsed().as_secs_f64();
        let segments = result.sort_by_start_time();
        let mut by_speaker = BTreeMap::<i32, Vec<(f32, f32)>>::new();
        for segment in segments {
            by_speaker
                .entry(segment.speaker)
                .or_default()
                .push((segment.start, segment.end));
        }

        let recording_dir = args
            .output_dir
            .join(format!("recording-{recording_index:02}"));
        fs::create_dir_all(&recording_dir)?;
        let embedding_started = Instant::now();
        let mut clusters = Vec::new();
        for (speaker_index, speaker_segments) in by_speaker {
            let cluster_samples = collect_cluster_samples(&wave.samples, &speaker_segments);
            let listening_wav = recording_dir.join(format!("speaker-{speaker_index:02}.wav"));
            write_wav(&listening_wav, &cluster_samples)?;
            let label_value = label_for_cluster(
                &args,
                recording_index,
                speaker_index,
                &listening_wav,
                &speaker_segments,
            )?;
            let mixed = label_value.eq_ignore_ascii_case("mixed");
            let label = (!label_value.is_empty() && !mixed).then_some(label_value);
            let embedding = compute_embedding(&extractor, &cluster_samples);
            if let (Some(label), Some(embedding)) = (&label, embedding.as_ref()) {
                labeled_embeddings.push(LabeledEmbedding {
                    recording_index,
                    label: label.clone(),
                    embedding: embedding.clone(),
                });
            }
            let speech_seconds = speaker_segments
                .iter()
                .map(|(start, end)| f64::from((end - start).max(0.0)))
                .sum();
            clusters.push(ClusterReport {
                speaker_index,
                segment_count: speaker_segments.len(),
                speech_seconds,
                label,
                mixed,
                embedding_available: embedding.is_some(),
                listening_wav: listening_wav
                    .strip_prefix(&args.output_dir)
                    .unwrap_or(&listening_wav)
                    .to_string_lossy()
                    .into_owned(),
            });
        }
        let embedding_seconds = embedding_started.elapsed().as_secs_f64();
        let inference_seconds = diarization_seconds + embedding_seconds;
        reports.push(RecordingReport {
            recording_index,
            filename,
            duration_seconds: wave.duration_seconds,
            diarization_seconds,
            embedding_seconds,
            inference_seconds,
            real_time_factor: if wave.duration_seconds > 0.0 {
                inference_seconds / wave.duration_seconds
            } else {
                0.0
            },
            clusters,
        });
    }

    let cluster_quality = cluster_quality(&reports);
    let (genuine, impostor) = pairwise_scores(&labeled_embeddings);
    let verdict = verdict(&genuine, &impostor, &cluster_quality);
    let report = Report {
        prototype: "persona-recognition-phase-1",
        runtime: RuntimeReport {
            sherpa_onnx_version: SHERPA_VERSION,
            native_archive,
            native_archive_sha256,
            segmentation_model_bytes: file_len(&args.segmentation_model)?,
            segmentation_model_sha256: sha256_file(&args.segmentation_model)?,
            embedding_model_bytes: file_len(&args.embedding_model)?,
            embedding_model_sha256: sha256_file(&args.embedding_model)?,
            provider: "cpu",
            resampler_smoke,
        },
        recordings: reports,
        cluster_quality,
        scores: ScoreReport {
            genuine: summarize(&genuine),
            impostor: summarize(&impostor),
        },
        verdict,
        privacy: "All inference is local. Audio and embedding vectors are never uploaded; raw embeddings remain in memory only.",
    };
    let report_path = args.output_dir.join("report.json");
    serde_json::to_writer_pretty(BufWriter::new(File::create(&report_path)?), &report)?;
    println!("\n{}", serde_json::to_string_pretty(&report)?);
    println!("\nReport: {}", report_path.display());
    Ok(())
}

fn parse_args() -> Result<Args> {
    let mut values = env::args().skip(1);
    let mut segmentation_model = None;
    let mut embedding_model = None;
    let mut output_dir = None;
    let mut label_map = HashMap::new();
    let mut non_interactive = false;
    let mut resampler_smoke = false;
    let mut wavs = Vec::new();
    while let Some(value) = values.next() {
        match value.as_str() {
            "--segmentation-model" => segmentation_model = values.next().map(PathBuf::from),
            "--embedding-model" => embedding_model = values.next().map(PathBuf::from),
            "--output" => output_dir = values.next().map(PathBuf::from),
            "--labels" => {
                let path = PathBuf::from(values.next().context("--labels needs a path")?);
                let reader = BufReader::new(File::open(&path)?);
                let raw: HashMap<String, HashMap<String, String>> =
                    serde_json::from_reader(reader)?;
                label_map = raw;
            }
            "--non-interactive" => non_interactive = true,
            "--resampler-smoke" => resampler_smoke = true,
            "--help" | "-h" => {
                println!(
                    "persona-recognition-spike --segmentation-model PATH --embedding-model PATH --output DIR [--labels JSON] [--non-interactive] [--resampler-smoke] WAV..."
                );
                std::process::exit(0);
            }
            _ if value.starts_with('-') => bail!("unknown option: {value}"),
            _ => wavs.push(PathBuf::from(value)),
        }
    }
    if wavs.len() < 2 {
        bail!("provide at least two WAV files from different recordings");
    }
    Ok(Args {
        segmentation_model: segmentation_model.context("missing --segmentation-model")?,
        embedding_model: embedding_model.context("missing --embedding-model")?,
        output_dir: output_dir.context("missing --output")?,
        label_map,
        non_interactive,
        resampler_smoke,
        wavs,
    })
}

fn read_and_prepare_wav(path: &Path) -> Result<PreparedWave> {
    let mut reader =
        hound::WavReader::open(path).with_context(|| format!("open WAV {}", path.display()))?;
    let spec = reader.spec();
    if spec.channels == 0 || spec.sample_rate == 0 {
        bail!("invalid WAV format: {}", path.display());
    }
    let interleaved = match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Int, bits) if bits <= 16 => reader
            .samples::<i16>()
            .map(|sample| sample.map(|value| f32::from(value) / f32::from(i16::MAX)))
            .collect::<std::result::Result<Vec<_>, _>>()?,
        (hound::SampleFormat::Int, bits) if bits <= 32 => {
            let scale = ((1_i64 << (bits - 1)) - 1) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<std::result::Result<Vec<_>, _>>()?
        }
        (hound::SampleFormat::Float, 32) => reader
            .samples::<f32>()
            .collect::<std::result::Result<Vec<_>, _>>()?,
        _ => bail!(
            "unsupported WAV sample format ({:?}, {} bits): {}",
            spec.sample_format,
            spec.bits_per_sample,
            path.display()
        ),
    };
    let channels = usize::from(spec.channels);
    let mono = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect::<Vec<_>>();
    let samples = resample_band_limited(&mono, spec.sample_rate, TARGET_SAMPLE_RATE);
    Ok(PreparedWave {
        duration_seconds: samples.len() as f64 / f64::from(TARGET_SAMPLE_RATE),
        samples,
    })
}

fn resample_band_limited(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if source_rate == target_rate || input.is_empty() {
        return input.to_vec();
    }
    let filtered = if source_rate > target_rate {
        low_pass_for_downsampling(input, source_rate, target_rate)
    } else {
        input.to_vec()
    };
    let output_len =
        ((filtered.len() as u128 * u128::from(target_rate)) / u128::from(source_rate)) as usize;
    (0..output_len)
        .map(|index| {
            let source_position = index as f64 * f64::from(source_rate) / f64::from(target_rate);
            let left = source_position.floor() as usize;
            let right = (left + 1).min(filtered.len() - 1);
            let fraction = (source_position - left as f64) as f32;
            filtered[left] + (filtered[right] - filtered[left]) * fraction
        })
        .collect()
}

fn low_pass_for_downsampling(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    // An eighth-order Butterworth cascade removes energy above the target
    // Nyquist limit before interpolation. June's saved WAVs are commonly
    // 44.1/48 kHz, so unfiltered sample picking would alias into Voiceprints.
    const BUTTERWORTH_Q: [f64; 4] = [0.509_795_579, 0.601_344_887, 0.899_976_223, 2.562_915_448];
    let cutoff_hz = f64::from(target_rate) * 0.4;
    let mut filters = BUTTERWORTH_Q.map(|q| Biquad::low_pass(source_rate, cutoff_hz, q));
    input
        .iter()
        .map(|sample| {
            filters
                .iter_mut()
                .fold(f64::from(*sample), |value, filter| filter.process(value)) as f32
        })
        .collect()
}

#[derive(Debug)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn low_pass(sample_rate: u32, cutoff_hz: f64, q: f64) -> Self {
        let omega = 2.0 * std::f64::consts::PI * cutoff_hz / f64::from(sample_rate);
        let cosine = omega.cos();
        let alpha = omega.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Self {
            b0: ((1.0 - cosine) / 2.0) / a0,
            b1: (1.0 - cosine) / a0,
            b2: ((1.0 - cosine) / 2.0) / a0,
            a1: (-2.0 * cosine) / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn process(&mut self, input: f64) -> f64 {
        let output = self.b0 * input + self.z1;
        self.z1 = self.b1 * input - self.a1 * output + self.z2;
        self.z2 = self.b2 * input - self.a2 * output;
        output
    }
}

fn run_resampler_smoke() -> Result<ResamplerSmokeReport> {
    const INPUT_RATE: u32 = 48_000;
    const PASSBAND_HZ: u32 = 1_000;
    const REJECTED_HZ: u32 = 12_000;
    let passband = sine_wave(INPUT_RATE, PASSBAND_HZ);
    let rejected = sine_wave(INPUT_RATE, REJECTED_HZ);
    let passband_rms = rms(&resample_band_limited(
        &passband,
        INPUT_RATE,
        TARGET_SAMPLE_RATE,
    ));
    let rejected_rms = rms(&resample_band_limited(
        &rejected,
        INPUT_RATE,
        TARGET_SAMPLE_RATE,
    ));
    if !(0.65..=0.75).contains(&passband_rms) || rejected_rms >= 0.02 {
        bail!(
            "resampler smoke failed: passband RMS {passband_rms:.4}, rejected-tone RMS {rejected_rms:.4}"
        );
    }
    Ok(ResamplerSmokeReport {
        input_sample_rate: INPUT_RATE,
        output_sample_rate: TARGET_SAMPLE_RATE,
        passband_tone_hz: PASSBAND_HZ,
        passband_rms,
        rejected_tone_hz: REJECTED_HZ,
        rejected_tone_rms: rejected_rms,
    })
}

fn sine_wave(sample_rate: u32, frequency_hz: u32) -> Vec<f32> {
    (0..sample_rate)
        .map(|index| {
            (std::f32::consts::TAU * frequency_hz as f32 * index as f32 / sample_rate as f32).sin()
        })
        .collect()
}

fn rms(samples: &[f32]) -> f32 {
    let edge = 256.min(samples.len() / 4);
    let body = &samples[edge..samples.len().saturating_sub(edge)];
    (body.iter().map(|sample| sample * sample).sum::<f32>() / body.len() as f32).sqrt()
}

fn collect_cluster_samples(samples: &[f32], segments: &[(f32, f32)]) -> Vec<f32> {
    let mut output = Vec::new();
    let separator = vec![0.0; (TARGET_SAMPLE_RATE / 10) as usize];
    for (index, (start, end)) in segments.iter().enumerate() {
        let start_sample =
            ((start.max(0.0) * TARGET_SAMPLE_RATE as f32) as usize).min(samples.len());
        let end_sample =
            ((end.max(*start) * TARGET_SAMPLE_RATE as f32) as usize).min(samples.len());
        if start_sample < end_sample {
            if index > 0 {
                output.extend_from_slice(&separator);
            }
            output.extend_from_slice(&samples[start_sample..end_sample]);
        }
    }
    output
}

fn write_wav(path: &Path, samples: &[f32]) -> Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec)?;
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16;
        writer.write_sample(value)?;
    }
    writer.finalize()?;
    Ok(())
}

fn label_for_cluster(
    args: &Args,
    recording_index: usize,
    speaker_index: i32,
    listening_wav: &Path,
    segments: &[(f32, f32)],
) -> Result<String> {
    if let Some(label) = args
        .label_map
        .get(&recording_index.to_string())
        .and_then(|labels| labels.get(&speaker_index.to_string()))
    {
        return Ok(label.trim().to_string());
    }
    if args.non_interactive {
        return Ok(String::new());
    }
    println!(
        "Cluster {speaker_index}: {} segment(s), listening WAV {}",
        segments.len(),
        listening_wav.display()
    );
    print!("Person label (same spelling across recordings; blank=unknown, mixed=impure): ");
    io::stdout().flush()?;
    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    Ok(input.trim().to_string())
}

fn compute_embedding(extractor: &SpeakerEmbeddingExtractor, samples: &[f32]) -> Option<Vec<f32>> {
    let stream = extractor.create_stream()?;
    stream.accept_waveform(TARGET_SAMPLE_RATE as i32, samples);
    stream.input_finished();
    if !extractor.is_ready(&stream) {
        return None;
    }
    let mut embedding = extractor.compute(&stream)?;
    let norm = embedding
        .iter()
        .map(|value| value * value)
        .sum::<f32>()
        .sqrt();
    if !norm.is_finite() || norm <= f32::EPSILON {
        return None;
    }
    for value in &mut embedding {
        *value /= norm;
    }
    Some(embedding)
}

fn pairwise_scores(embeddings: &[LabeledEmbedding]) -> (Vec<f32>, Vec<f32>) {
    let mut genuine = Vec::new();
    let mut impostor = Vec::new();
    for left_index in 0..embeddings.len() {
        for right_index in (left_index + 1)..embeddings.len() {
            let left = &embeddings[left_index];
            let right = &embeddings[right_index];
            if left.recording_index == right.recording_index {
                continue;
            }
            let score = left
                .embedding
                .iter()
                .zip(&right.embedding)
                .map(|(left, right)| left * right)
                .sum();
            if left.label == right.label {
                genuine.push(score);
            } else {
                impostor.push(score);
            }
        }
    }
    (genuine, impostor)
}

fn summarize(values: &[f32]) -> Distribution {
    if values.is_empty() {
        return Distribution {
            count: 0,
            min: None,
            max: None,
            mean: None,
        };
    }
    Distribution {
        count: values.len(),
        min: values.iter().copied().reduce(f32::min),
        max: values.iter().copied().reduce(f32::max),
        mean: Some(values.iter().sum::<f32>() / values.len() as f32),
    }
}

fn cluster_quality(recordings: &[RecordingReport]) -> ClusterQualityReport {
    let total_recordings = recordings.len();
    let mut contributing_recordings = 0;
    let mut total_clusters = 0;
    let mut labeled_clusters = 0;
    let mut unknown_clusters = 0;
    let mut mixed_clusters = 0;
    let mut missing_embeddings = 0;
    let mut fragmented_identities = 0;
    for recording in recordings {
        if recording
            .clusters
            .iter()
            .any(|cluster| !cluster.mixed && cluster.label.is_some() && cluster.embedding_available)
        {
            contributing_recordings += 1;
        }
        let mut labels = HashMap::<&str, usize>::new();
        for cluster in &recording.clusters {
            total_clusters += 1;
            if cluster.mixed {
                mixed_clusters += 1;
            } else if let Some(label) = cluster.label.as_deref() {
                labeled_clusters += 1;
                *labels.entry(label).or_default() += 1;
                if !cluster.embedding_available {
                    missing_embeddings += 1;
                }
            } else {
                unknown_clusters += 1;
            }
        }
        fragmented_identities += labels.values().filter(|count| **count > 1).count();
    }
    ClusterQualityReport {
        total_recordings,
        contributing_recordings,
        total_clusters,
        labeled_clusters,
        unknown_clusters,
        mixed_clusters,
        missing_embeddings,
        fragmented_identities,
        scored_cluster_coverage: if total_clusters == 0 {
            0.0
        } else {
            labeled_clusters as f32 / total_clusters as f32
        },
    }
}

fn verdict(genuine: &[f32], impostor: &[f32], quality: &ClusterQualityReport) -> VerdictReport {
    let caveat = "Spike evidence only. Real June system.wav recordings across devices, codecs, and meetings are required before production thresholds or a ship decision.";
    if quality.mixed_clusters > 0 {
        return VerdictReport {
            status: "FAIL",
            reason: format!(
                "{} cluster(s) were marked mixed; score separation cannot redeem impure diarization.",
                quality.mixed_clusters
            ),
            suggest_threshold_ballpark: None,
            auto_threshold_ballpark: None,
            caveat,
        };
    }
    if quality.fragmented_identities > 0 {
        return VerdictReport {
            status: "FAIL",
            reason: format!(
                "{} identity/recording pair(s) were split across multiple clusters.",
                quality.fragmented_identities
            ),
            suggest_threshold_ballpark: None,
            auto_threshold_ballpark: None,
            caveat,
        };
    }
    if quality.contributing_recordings < quality.total_recordings {
        return VerdictReport {
            status: "INCONCLUSIVE",
            reason: format!(
                "Only {} of {} recordings produced a labeled, embeddable cluster.",
                quality.contributing_recordings, quality.total_recordings
            ),
            suggest_threshold_ballpark: None,
            auto_threshold_ballpark: None,
            caveat,
        };
    }
    if quality.unknown_clusters > 0 {
        return VerdictReport {
            status: "INCONCLUSIVE",
            reason: format!(
                "{} of {} clusters remain unknown; label every evaluation cluster or mark it mixed before judging quality.",
                quality.unknown_clusters, quality.total_clusters
            ),
            suggest_threshold_ballpark: None,
            auto_threshold_ballpark: None,
            caveat,
        };
    }
    if quality.missing_embeddings > 0 {
        return VerdictReport {
            status: "INCONCLUSIVE",
            reason: format!(
                "{} labeled cluster(s) did not yield an embedding.",
                quality.missing_embeddings
            ),
            suggest_threshold_ballpark: None,
            auto_threshold_ballpark: None,
            caveat,
        };
    }
    let Some(min_genuine) = genuine.iter().copied().reduce(f32::min) else {
        return VerdictReport {
            status: "INCONCLUSIVE",
            reason: "No cross-recording genuine pairs were labeled.".into(),
            suggest_threshold_ballpark: None,
            auto_threshold_ballpark: None,
            caveat,
        };
    };
    let Some(max_impostor) = impostor.iter().copied().reduce(f32::max) else {
        return VerdictReport {
            status: "INCONCLUSIVE",
            reason: "No cross-recording impostor pairs were labeled.".into(),
            suggest_threshold_ballpark: None,
            auto_threshold_ballpark: None,
            caveat,
        };
    };
    if max_impostor < min_genuine {
        VerdictReport {
            status: "PASS",
            reason: format!(
                "Observed score separation: max impostor {max_impostor:.4} < min genuine {min_genuine:.4}."
            ),
            suggest_threshold_ballpark: Some(max_impostor),
            auto_threshold_ballpark: Some(min_genuine),
            caveat,
        }
    } else {
        VerdictReport {
            status: "FAIL",
            reason: format!(
                "Observed score overlap: max impostor {max_impostor:.4} >= min genuine {min_genuine:.4}."
            ),
            suggest_threshold_ballpark: None,
            auto_threshold_ballpark: None,
            caveat,
        }
    }
}

fn file_len(path: &Path) -> Result<u64> {
    Ok(fs::metadata(path)
        .with_context(|| format!("read metadata for {}", path.display()))?
        .len())
}

fn reject_duplicate_inputs(paths: &[PathBuf]) -> Result<()> {
    let mut seen = HashMap::<String, &Path>::new();
    for path in paths {
        let digest = sha256_file(path)?;
        if let Some(first) = seen.insert(digest.clone(), path) {
            bail!(
                "duplicate recording content: {} and {} have SHA-256 {digest}",
                first.display(),
                path.display()
            );
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("read {}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
