use os_june_lib::audio::{
    noise_suppression::suppress_microphone_wav_for_transcription,
    turns::normalize_wav_for_transcription,
};
use sha2::{Digest, Sha256};
use std::{
    env,
    path::{Path, PathBuf},
};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let input = arguments.next().map(PathBuf::from).ok_or_else(usage)?;
    let output = arguments.next().map(PathBuf::from).ok_or_else(usage)?;
    let bypass_suppression = match arguments.next() {
        None => false,
        Some(flag) if flag == "--without-suppression" => true,
        Some(_) => return Err(usage()),
    };
    if arguments.next().is_some() {
        return Err(usage());
    }

    let archive_before = sha256_file(&input)?;
    let result = if bypass_suppression {
        None
    } else {
        Some(suppress_microphone_wav_for_transcription(&input).map_err(|error| error.message)?)
    };
    let transcription_input = result
        .as_ref()
        .map_or(input.as_path(), |result| result.path.as_path());
    let normalized = normalize_wav_for_transcription(transcription_input, &output)
        .map_err(|error| error.message)?;
    if normalized != output {
        std::fs::copy(normalized, &output).map_err(|error| error.to_string())?;
    }
    let archive_after = sha256_file(&input)?;
    if archive_before != archive_after {
        return Err("The finalized input WAV changed during evaluation.".to_string());
    }

    println!("input={}", input.display());
    println!("output={}", output.display());
    println!(
        "algorithmApplied={}",
        result.as_ref().is_some_and(|result| result.applied)
    );
    println!(
        "cacheHit={}",
        result.as_ref().is_some_and(|result| result.cache_hit)
    );
    println!(
        "noiseFloorDbfs={}",
        result
            .as_ref()
            .and_then(|result| result.noise_floor_dbfs)
            .map_or_else(|| "not-measured".to_string(), |floor| format!("{floor:.2}"))
    );
    println!(
        "fingerprint={}",
        result
            .as_ref()
            .map_or("none", |result| result.fingerprint.as_str())
    );
    println!("archiveSha256={archive_after}");
    Ok(())
}

fn usage() -> String {
    "Usage: noise_suppression_eval <input.wav> <output.wav> [--without-suppression]".to_string()
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
