use sha2::{Digest, Sha256};
use std::{
    env,
    fs::File,
    io::{self, Read},
    path::PathBuf,
};

fn main() {
    for name in [
        "SHERPA_ONNX_ARCHIVE_DIR",
        "SHERPA_ONNX_ARCHIVE_NAME",
        "SHERPA_ONNX_ARCHIVE_SHA256",
        "SHERPA_ONNX_LIB_DIR",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }

    if env::var_os("SHERPA_ONNX_LIB_DIR").is_some() {
        panic!("SHERPA_ONNX_LIB_DIR bypasses the verified native archive");
    }

    let archive_dir = required_env("SHERPA_ONNX_ARCHIVE_DIR");
    let archive_name = required_env("SHERPA_ONNX_ARCHIVE_NAME");
    let expected_sha256 = required_env("SHERPA_ONNX_ARCHIVE_SHA256");
    let archive_path = PathBuf::from(archive_dir).join(&archive_name);
    let actual_sha256 = sha256(&archive_path)
        .unwrap_or_else(|error| panic!("hash native archive {}: {error}", archive_path.display()));
    if actual_sha256 != expected_sha256 {
        panic!(
            "native archive checksum mismatch for {}: expected {expected_sha256}, got {actual_sha256}",
            archive_path.display()
        );
    }

    println!("cargo:rerun-if-changed={}", archive_path.display());
    println!("cargo:rustc-env=PERSONA_SPIKE_NATIVE_ARCHIVE={archive_name}");
    println!("cargo:rustc-env=PERSONA_SPIKE_NATIVE_ARCHIVE_SHA256={actual_sha256}");
}

fn required_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| {
        panic!("{name} is required; run through scripts/persona-recognition-spike.sh")
    })
}

fn sha256(path: &PathBuf) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
