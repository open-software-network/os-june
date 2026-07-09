//! PROTOTYPE: local persona-recognition quality spike.
//!
//! This binary is intentionally isolated from June's production crate. It
//! answers whether diarized speaker clusters produce cross-meeting embeddings
//! with enough genuine/impostor separation to justify Phase 1.

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
    SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig,
};
use std::{
    collections::{BTreeMap, HashMap},
    env,
    fs::{self, File},
    io::{self, BufReader, BufWriter, Write},
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
    scores: ScoreReport,
    verdict: VerdictReport,
    privacy: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReport {
    sherpa_onnx_version: &'static str,
    segmentation_model_bytes: u64,
    embedding_model_bytes: u64,
    provider: &'static str,
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
                &filename,
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

    let (genuine, impostor) = pairwise_scores(&labeled_embeddings);
    let verdict = verdict(&genuine, &impostor);
    let report = Report {
        prototype: "persona-recognition-phase-1",
        runtime: RuntimeReport {
            sherpa_onnx_version: SHERPA_VERSION,
            segmentation_model_bytes: file_len(&args.segmentation_model)?,
            embedding_model_bytes: file_len(&args.embedding_model)?,
            provider: "cpu",
        },
        recordings: reports,
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
            "--help" | "-h" => {
                println!(
                    "persona-recognition-spike --segmentation-model PATH --embedding-model PATH --output DIR [--labels JSON] [--non-interactive] WAV..."
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
    let samples = resample_linear(&mono, spec.sample_rate, TARGET_SAMPLE_RATE);
    Ok(PreparedWave {
        duration_seconds: samples.len() as f64 / f64::from(TARGET_SAMPLE_RATE),
        samples,
    })
}

fn resample_linear(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if source_rate == target_rate || input.is_empty() {
        return input.to_vec();
    }
    let output_len =
        ((input.len() as u128 * u128::from(target_rate)) / u128::from(source_rate)) as usize;
    (0..output_len)
        .map(|index| {
            let source_position = index as f64 * f64::from(source_rate) / f64::from(target_rate);
            let left = source_position.floor() as usize;
            let right = (left + 1).min(input.len() - 1);
            let fraction = (source_position - left as f64) as f32;
            input[left] + (input[right] - input[left]) * fraction
        })
        .collect()
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
    filename: &str,
    speaker_index: i32,
    listening_wav: &Path,
    segments: &[(f32, f32)],
) -> Result<String> {
    if let Some(label) = args
        .label_map
        .get(filename)
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

fn verdict(genuine: &[f32], impostor: &[f32]) -> VerdictReport {
    let caveat = "Spike evidence only. Real June system.wav recordings across devices, codecs, and meetings are required before production thresholds or a ship decision.";
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
