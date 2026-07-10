use crate::{
    audio::turns::AudioTurn,
    db::repositories::{PersonaClusterRecord, PersonaVoiceprintRecord},
};
use anyhow::{anyhow, bail, Context, Result};
use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
    SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig,
};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub const PERSONA_MODEL_ID: &str = "sherpa-onnx-1.13.4-wespeaker-voxceleb-resnet34-lm";
const TARGET_SAMPLE_RATE: u32 = 16_000;
const DEFAULT_SUGGEST_THRESHOLD: f32 = 0.85;
const DEFAULT_AUTO_THRESHOLD: f32 = 0.90;
const DEFAULT_CLUSTER_MERGE_THRESHOLD: f32 = 0.85;
const MIN_CLUSTER_SPAN_MS: i64 = 300;

#[derive(Debug, Clone)]
pub struct RecognitionSource {
    pub source: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct RecognizedCluster {
    pub record: PersonaClusterRecord,
    pub spans: Vec<(i64, i64)>,
}

#[derive(Debug, Clone, Default)]
pub struct PersonaRecognitionResult {
    pub clusters: Vec<RecognizedCluster>,
}

#[derive(Debug, Clone)]
pub struct PersonaModelPaths {
    pub segmentation: PathBuf,
    pub embedding: PathBuf,
}

pub fn recognized_clusters_from_records(
    records: Vec<PersonaClusterRecord>,
) -> Vec<RecognizedCluster> {
    records
        .into_iter()
        .filter_map(|record| {
            let spans = serde_json::from_str::<Vec<(i64, i64)>>(&record.spans_json).ok()?;
            Some(RecognizedCluster { record, spans })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
struct MatchDecision {
    state: &'static str,
    persona_id: Option<String>,
    confidence: Option<f32>,
}

#[derive(Debug, Clone)]
struct DiarizedCluster {
    speaker_index: i32,
    spans: Vec<(i64, i64)>,
    embedding: Vec<f32>,
}

pub fn discover_model_paths() -> Option<PersonaModelPaths> {
    let mut roots = Vec::new();
    if let Some(path) = std::env::var_os("OS_JUNE_PERSONA_MODELS_DIR") {
        roots.push(PathBuf::from(path));
    }
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .to_path_buf();
    roots.push(repository.join(".tauri-personas").join("personas"));
    roots.push(repository.join(".persona-spike").join("models"));
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            roots.push(directory.join("native").join("personas"));
            roots.push(
                directory
                    .join("..")
                    .join("Resources")
                    .join("native")
                    .join("personas"),
            );
        }
    }
    roots.into_iter().find_map(model_paths_in)
}

fn model_paths_in(root: PathBuf) -> Option<PersonaModelPaths> {
    let segmentation_candidates = [
        root.join("segmentation.onnx"),
        root.join("sherpa-onnx-pyannote-segmentation-3-0")
            .join("model.onnx"),
    ];
    let embedding_candidates = [
        root.join("embedding.onnx"),
        root.join("wespeaker_en_voxceleb_resnet34_LM.onnx"),
    ];
    let segmentation = segmentation_candidates
        .into_iter()
        .find(|path| path.is_file())?;
    let embedding = embedding_candidates
        .into_iter()
        .find(|path| path.is_file())?;
    Some(PersonaModelPaths {
        segmentation,
        embedding,
    })
}

pub fn recognize_sources(
    note_id: &str,
    session_id: &str,
    sources: &[RecognitionSource],
    voiceprints: &[PersonaVoiceprintRecord],
    models: &PersonaModelPaths,
) -> Result<PersonaRecognitionResult> {
    let embedding_config = SpeakerEmbeddingExtractorConfig {
        model: Some(models.embedding.to_string_lossy().into_owned()),
        num_threads: 2,
        debug: false,
        provider: Some("cpu".into()),
    };
    let diarization_config = OfflineSpeakerDiarizationConfig {
        segmentation: OfflineSpeakerSegmentationModelConfig {
            pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                model: Some(models.segmentation.to_string_lossy().into_owned()),
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
        .ok_or_else(|| anyhow!("initialize local speaker diarizer"))?;
    if diarizer.sample_rate() != TARGET_SAMPLE_RATE as i32 {
        bail!(
            "unexpected diarizer sample rate: {}",
            diarizer.sample_rate()
        );
    }
    let extractor = SpeakerEmbeddingExtractor::create(&embedding_config)
        .ok_or_else(|| anyhow!("initialize local Voiceprint extractor"))?;
    let suggest_threshold = threshold_from_env(
        "OS_JUNE_PERSONA_SUGGEST_THRESHOLD",
        DEFAULT_SUGGEST_THRESHOLD,
    );
    let auto_threshold =
        threshold_from_env("OS_JUNE_PERSONA_AUTO_THRESHOLD", DEFAULT_AUTO_THRESHOLD);
    let cluster_merge_threshold = threshold_from_env(
        "OS_JUNE_PERSONA_CLUSTER_MERGE_THRESHOLD",
        DEFAULT_CLUSTER_MERGE_THRESHOLD,
    );
    let mut clusters = Vec::new();

    // Both saved lanes are analyzed locally. Microphone candidates are
    // restricted to the protected self Persona by the repository query; an
    // unmatched microphone cluster stays visibly labeled Microphone in the UI.
    for source in sources
        .iter()
        .filter(|source| matches!(source.source.as_str(), "system" | "microphone"))
    {
        let wave = read_and_prepare_wav(&source.path)?;
        let result = diarizer
            .process(&wave)
            .ok_or_else(|| anyhow!("diarize {}", source.path.display()))?;
        let mut by_speaker = BTreeMap::<i32, Vec<(i64, i64)>>::new();
        for segment in result.sort_by_start_time() {
            let start_ms = (segment.start.max(0.0) * 1_000.0).round() as i64;
            let end_ms = (segment.end.max(segment.start) * 1_000.0).round() as i64;
            if end_ms - start_ms >= MIN_CLUSTER_SPAN_MS {
                by_speaker
                    .entry(segment.speaker)
                    .or_default()
                    .push((start_ms, end_ms));
            }
        }
        let raw_clusters = by_speaker
            .into_iter()
            .map(|(speaker_index, spans)| {
                let samples = collect_cluster_samples(&wave, &spans);
                DiarizedCluster {
                    speaker_index,
                    spans,
                    embedding: compute_embedding(&extractor, &samples).unwrap_or_default(),
                }
            })
            .collect::<Vec<_>>();
        let merged_clusters =
            merge_fragmented_clusters(raw_clusters, &wave, &extractor, cluster_merge_threshold);
        for DiarizedCluster {
            speaker_index,
            spans,
            embedding,
        } in merged_clusters
        {
            let decision = decide_match(
                &source.source,
                &embedding,
                voiceprints,
                suggest_threshold,
                auto_threshold,
            );
            let cluster_id = Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!("{note_id}:{session_id}:{}:{speaker_index}", source.source).as_bytes(),
            )
            .to_string();
            let spans_json = serde_json::to_string(&spans)?;
            clusters.push(RecognizedCluster {
                record: PersonaClusterRecord {
                    id: cluster_id,
                    recording_session_id: session_id.to_string(),
                    note_id: note_id.to_string(),
                    source: source.source.clone(),
                    speaker_index: i64::from(speaker_index),
                    anonymous_label: format!("Speaker {speaker_index:02}"),
                    model_id: PERSONA_MODEL_ID.to_string(),
                    embedding: encode_embedding(&embedding),
                    spans_json,
                    state: decision.state.to_string(),
                    persona_id: decision.persona_id,
                    confidence: decision.confidence,
                },
                spans,
            });
        }
    }
    Ok(PersonaRecognitionResult { clusters })
}

pub fn split_turns_by_clusters(
    turns: Vec<AudioTurn>,
    clusters: &[RecognizedCluster],
) -> Vec<AudioTurn> {
    let mut output = Vec::new();
    for turn in turns {
        let mut pieces = clusters
            .iter()
            .filter(|cluster| cluster.record.source == turn.source)
            .flat_map(|cluster| {
                cluster.spans.iter().filter_map(|(start, end)| {
                    let start_ms = (*start).max(turn.start_ms);
                    let end_ms = (*end).min(turn.end_ms);
                    (end_ms - start_ms >= MIN_CLUSTER_SPAN_MS).then_some((start_ms, end_ms))
                })
            })
            .collect::<Vec<_>>();
        pieces.sort_unstable();
        pieces.dedup();
        if pieces.is_empty() {
            output.push(turn);
            continue;
        }
        // Preserve every uncovered part of the detector turn. Diarization is
        // an attribution layer, never an audio filter: a missed boundary must
        // fall back to the Source label instead of disappearing from the
        // transcript and generated note.
        let mut covered = Vec::<(i64, i64)>::new();
        for (start, end) in &pieces {
            if let Some((_last_start, last_end)) = covered.last_mut() {
                if *start <= *last_end {
                    *last_end = (*last_end).max(*end);
                    continue;
                }
            }
            covered.push((*start, *end));
        }
        let mut all_pieces = pieces;
        let mut cursor = turn.start_ms;
        for (start, end) in covered {
            if start > cursor {
                all_pieces.push((cursor, start));
            }
            cursor = cursor.max(end);
        }
        if cursor < turn.end_ms {
            all_pieces.push((cursor, turn.end_ms));
        }
        all_pieces.sort_unstable();
        all_pieces.dedup();
        for (start_ms, end_ms) in all_pieces {
            output.push(AudioTurn {
                artifact_id: turn.artifact_id.clone(),
                source: turn.source.clone(),
                source_path: turn.source_path.clone(),
                extraction_start_ms: start_ms,
                start_ms,
                end_ms,
                turn_index: 0,
            });
        }
    }
    output.sort_by(|left, right| {
        left.start_ms
            .cmp(&right.start_ms)
            .then_with(|| left.source.cmp(&right.source))
            .then_with(|| left.end_ms.cmp(&right.end_ms))
    });
    for (index, turn) in output.iter_mut().enumerate() {
        turn.turn_index = index as i64;
    }
    output
}

fn merge_fragmented_clusters(
    mut clusters: Vec<DiarizedCluster>,
    samples: &[f32],
    extractor: &SpeakerEmbeddingExtractor,
    threshold: f32,
) -> Vec<DiarizedCluster> {
    loop {
        let mut merge_pair = None;
        'pairs: for left in 0..clusters.len() {
            for right in (left + 1)..clusters.len() {
                if !should_merge_clusters(&clusters[left], &clusters[right], threshold) {
                    continue;
                }
                merge_pair = Some((left, right));
                break 'pairs;
            }
        }
        let Some((left, right)) = merge_pair else {
            break;
        };
        let removed = clusters.remove(right);
        clusters[left].speaker_index = clusters[left].speaker_index.min(removed.speaker_index);
        clusters[left].spans.extend(removed.spans);
        clusters[left].spans.sort_unstable();
        let combined_samples = collect_cluster_samples(samples, &clusters[left].spans);
        clusters[left].embedding =
            compute_embedding(extractor, &combined_samples).unwrap_or_default();
    }
    clusters.sort_by_key(|cluster| cluster.speaker_index);
    clusters
}

fn should_merge_clusters(left: &DiarizedCluster, right: &DiarizedCluster, threshold: f32) -> bool {
    !left.embedding.is_empty()
        && !right.embedding.is_empty()
        && !spans_overlap(&left.spans, &right.spans)
        && cosine_similarity(&left.embedding, &right.embedding) >= threshold
}

fn spans_overlap(left: &[(i64, i64)], right: &[(i64, i64)]) -> bool {
    left.iter().any(|(left_start, left_end)| {
        right.iter().any(|(right_start, right_end)| {
            left_end.min(right_end) - left_start.max(right_start) >= MIN_CLUSTER_SPAN_MS
        })
    })
}

fn decide_match(
    source: &str,
    embedding: &[f32],
    voiceprints: &[PersonaVoiceprintRecord],
    suggest_threshold: f32,
    auto_threshold: f32,
) -> MatchDecision {
    if embedding.is_empty() {
        return anonymous_decision();
    }
    let mut scores = HashMap::<String, (f32, f32, bool)>::new();
    for voiceprint in voiceprints {
        if voiceprint.source != source || voiceprint.model_id != PERSONA_MODEL_ID {
            continue;
        }
        let Some(reference) = decode_embedding(&voiceprint.embedding) else {
            continue;
        };
        if reference.len() != embedding.len() {
            continue;
        }
        let score = cosine_similarity(embedding, &reference);
        let entry = scores.entry(voiceprint.persona_id.clone()).or_insert((
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
            voiceprint.recognition_confirmed,
        ));
        entry.2 |= voiceprint.recognition_confirmed;
        if voiceprint.kind == "negative" {
            entry.1 = entry.1.max(score);
        } else {
            entry.0 = entry.0.max(score);
        }
    }
    let Some((persona_id, (positive, _negative, confirmed))) = scores
        .into_iter()
        .filter(|(_persona_id, (positive, negative, _confirmed))| {
            positive.is_finite() && (!negative.is_finite() || negative + 0.02 < *positive)
        })
        .max_by(|left, right| {
            left.1
                 .0
                .partial_cmp(&right.1 .0)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    else {
        return anonymous_decision();
    };
    if positive < suggest_threshold {
        return anonymous_decision();
    }
    MatchDecision {
        state: if confirmed && positive >= auto_threshold {
            "automatic"
        } else {
            "suggested"
        },
        persona_id: Some(persona_id),
        confidence: Some(positive),
    }
}

fn anonymous_decision() -> MatchDecision {
    MatchDecision {
        state: "anonymous",
        persona_id: None,
        confidence: None,
    }
}

fn threshold_from_env(name: &str, fallback: f32) -> f32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .filter(|value| (0.0..=1.0).contains(value))
        .unwrap_or(fallback)
}

fn read_and_prepare_wav(path: &Path) -> Result<Vec<f32>> {
    let mut reader = hound::WavReader::open(path)
        .with_context(|| format!("open Persona recognition WAV {}", path.display()))?;
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
    Ok(resample_band_limited(
        &mono,
        spec.sample_rate,
        TARGET_SAMPLE_RATE,
    ))
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

fn collect_cluster_samples(samples: &[f32], spans: &[(i64, i64)]) -> Vec<f32> {
    let mut output = Vec::new();
    let separator = vec![0.0; (TARGET_SAMPLE_RATE / 10) as usize];
    for (index, (start_ms, end_ms)) in spans.iter().enumerate() {
        let start =
            ((*start_ms).max(0) as usize * TARGET_SAMPLE_RATE as usize / 1_000).min(samples.len());
        let end = ((*end_ms).max(*start_ms) as usize * TARGET_SAMPLE_RATE as usize / 1_000)
            .min(samples.len());
        if start < end {
            if index > 0 {
                output.extend_from_slice(&separator);
            }
            output.extend_from_slice(&samples[start..end]);
        }
    }
    output
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

fn encode_embedding(embedding: &[f32]) -> Vec<u8> {
    embedding
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn decode_embedding(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|chunk| {
                let bytes: [u8; 4] = chunk.try_into().expect("four-byte embedding chunk");
                f32::from_le_bytes(bytes)
            })
            .collect(),
    )
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voiceprint(
        persona_id: &str,
        score_axis: [f32; 2],
        kind: &str,
        confirmed: bool,
    ) -> PersonaVoiceprintRecord {
        PersonaVoiceprintRecord {
            persona_id: persona_id.to_string(),
            source: "system".to_string(),
            model_id: PERSONA_MODEL_ID.to_string(),
            embedding: encode_embedding(&score_axis),
            kind: kind.to_string(),
            recording_session_id: "other-session".to_string(),
            recognition_confirmed: confirmed,
        }
    }

    #[test]
    fn first_cross_meeting_match_is_a_suggestion() {
        let decision = decide_match(
            "system",
            &[1.0, 0.0],
            &[voiceprint("jun", [0.95, 0.0], "positive", false)],
            0.85,
            0.90,
        );
        assert_eq!(decision.state, "suggested");
        assert_eq!(decision.persona_id.as_deref(), Some("jun"));
    }

    #[test]
    fn confirmed_high_confidence_match_is_automatic() {
        let decision = decide_match(
            "system",
            &[1.0, 0.0],
            &[voiceprint("jun", [0.95, 0.0], "positive", true)],
            0.85,
            0.90,
        );
        assert_eq!(decision.state, "automatic");
    }

    #[test]
    fn negative_voiceprint_blocks_the_candidate() {
        let decision = decide_match(
            "system",
            &[1.0, 0.0],
            &[
                voiceprint("jun", [0.95, 0.0], "positive", true),
                voiceprint("jun", [0.96, 0.0], "negative", true),
            ],
            0.85,
            0.90,
        );
        assert_eq!(decision.state, "anonymous");
    }

    #[test]
    fn microphone_matching_uses_only_microphone_voiceprints() {
        let system = voiceprint("jun", [0.95, 0.0], "positive", true);
        assert_eq!(
            decide_match("microphone", &[1.0, 0.0], &[system], 0.85, 0.90).state,
            "anonymous"
        );

        let mut microphone = voiceprint("self", [0.95, 0.0], "positive", true);
        microphone.source = "microphone".into();
        let decision = decide_match("microphone", &[1.0, 0.0], &[microphone], 0.85, 0.90);
        assert_eq!(decision.state, "automatic");
        assert_eq!(decision.persona_id.as_deref(), Some("self"));
    }

    #[test]
    fn same_voice_fragments_merge_only_when_they_do_not_overlap() {
        let left = DiarizedCluster {
            speaker_index: 0,
            spans: vec![(0, 1_000)],
            embedding: vec![1.0, 0.0],
        };
        let non_overlapping = DiarizedCluster {
            speaker_index: 2,
            spans: vec![(1_500, 2_500)],
            embedding: vec![0.90, 0.0],
        };
        let overlapping = DiarizedCluster {
            speaker_index: 3,
            spans: vec![(500, 1_500)],
            embedding: vec![0.95, 0.0],
        };
        assert!(should_merge_clusters(&left, &non_overlapping, 0.85));
        assert!(!should_merge_clusters(&left, &overlapping, 0.85));
    }

    #[test]
    fn diarized_spans_split_a_source_turn_before_transcription() {
        let turn = AudioTurn {
            artifact_id: "audio".to_string(),
            source: "system".to_string(),
            source_path: PathBuf::from("system.wav"),
            extraction_start_ms: 0,
            start_ms: 0,
            end_ms: 4_000,
            turn_index: 0,
        };
        let cluster = |id: &str, speaker_index: i64, spans: Vec<(i64, i64)>| RecognizedCluster {
            record: PersonaClusterRecord {
                id: id.to_string(),
                recording_session_id: "session".to_string(),
                note_id: "note".to_string(),
                source: "system".to_string(),
                speaker_index,
                anonymous_label: format!("Speaker {speaker_index:02}"),
                model_id: PERSONA_MODEL_ID.to_string(),
                embedding: Vec::new(),
                spans_json: serde_json::to_string(&spans).expect("spans"),
                state: "anonymous".to_string(),
                persona_id: None,
                confidence: None,
            },
            spans,
        };
        let turns = split_turns_by_clusters(
            vec![turn],
            &[
                cluster("a", 0, vec![(0, 1_500)]),
                cluster("b", 1, vec![(1_500, 4_000)]),
            ],
        );
        assert_eq!(turns.len(), 2);
        assert_eq!((turns[0].start_ms, turns[0].end_ms), (0, 1_500));
        assert_eq!((turns[1].start_ms, turns[1].end_ms), (1_500, 4_000));
    }

    #[test]
    fn diarization_gaps_remain_source_labeled_turns() {
        let turn = AudioTurn {
            artifact_id: "audio".to_string(),
            source: "system".to_string(),
            source_path: PathBuf::from("system.wav"),
            extraction_start_ms: 0,
            start_ms: 0,
            end_ms: 4_000,
            turn_index: 0,
        };
        let spans = vec![(1_000, 3_000)];
        let cluster = RecognizedCluster {
            record: PersonaClusterRecord {
                id: "cluster".into(),
                recording_session_id: "session".into(),
                note_id: "note".into(),
                source: "system".into(),
                speaker_index: 0,
                anonymous_label: "Speaker 00".into(),
                model_id: PERSONA_MODEL_ID.into(),
                embedding: Vec::new(),
                spans_json: serde_json::to_string(&spans).expect("spans"),
                state: "anonymous".into(),
                persona_id: None,
                confidence: None,
            },
            spans,
        };

        let turns = split_turns_by_clusters(vec![turn], &[cluster]);
        assert_eq!(
            turns
                .iter()
                .map(|turn| (turn.start_ms, turn.end_ms))
                .collect::<Vec<_>>(),
            vec![(0, 1_000), (1_000, 3_000), (3_000, 4_000)]
        );
    }

    #[test]
    #[ignore = "requires a local saved System WAV and the pinned model bundle"]
    fn saved_system_audio_smoke() {
        let wav = std::env::var("OS_JUNE_PERSONA_SMOKE_WAV")
            .expect("OS_JUNE_PERSONA_SMOKE_WAV must point at a saved system.wav");
        let models = discover_model_paths().expect("Persona models should be available");
        let result = recognize_sources(
            "smoke-note",
            "smoke-session",
            &[RecognitionSource {
                source: "system".to_string(),
                path: PathBuf::from(wav),
            }],
            &[],
            &models,
        )
        .expect("local Persona recognition");
        println!("recognized {} speaker cluster(s)", result.clusters.len());
        assert!(!result.clusters.is_empty());
        assert!(result
            .clusters
            .iter()
            .all(|cluster| !cluster.spans.is_empty()));
    }
}
