import argparse
import hashlib
import json
import os
import sys

import numpy as np
import soundfile as sf
import torch
from omnivoice import OmniVoice


SAMPLE_RATE = 24_000
DIFFUSION_STEPS = 16
DEFAULT_REFERENCE_TEXT = "Hi, I'm June. Your private notes stay with you on this Mac."


def require_mps() -> None:
    if not torch.backends.mps.is_available():
        raise RuntimeError("Apple Metal acceleration is unavailable")


def load_model(model_path: str) -> OmniVoice:
    require_mps()
    return OmniVoice.from_pretrained(
        model_path,
        device_map="mps",
        dtype=torch.float32,
        attn_implementation="eager",
        local_files_only=True,
        load_asr=False,
    )


def smoke(model_path: str, output_path: str, seed: int) -> None:
    torch.manual_seed(seed)
    np.random.seed(seed & 0xFFFF_FFFF)
    model = load_model(model_path)
    audio = model.generate(text=DEFAULT_REFERENCE_TEXT, num_step=DIFFUSION_STEPS)
    write_audio(output_path, audio[0])


def write_audio(output_path: str, audio: np.ndarray) -> None:
    waveform = np.asarray(audio)
    if waveform.ndim != 1 or waveform.size == 0:
        raise RuntimeError("synthesis produced no audio")
    if not np.isfinite(waveform).all():
        raise RuntimeError("synthesis produced invalid audio")
    if float(np.max(np.abs(waveform))) < 0.0001:
        raise RuntimeError("synthesis produced silent audio")
    sf.write(output_path, waveform, SAMPLE_RATE)


def reference_key(path: str, transcript: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as reference:
        for chunk in iter(lambda: reference.read(1024 * 1024), b""):
            digest.update(chunk)
    digest.update(b"\0")
    digest.update(transcript.encode("utf-8"))
    return digest.hexdigest()


def serve(model_path: str) -> None:
    protocol = os.fdopen(os.dup(1), "w")
    os.dup2(2, 1)

    def emit(payload: dict) -> None:
        protocol.write(json.dumps(payload) + "\n")
        protocol.flush()

    emit({"event": "loading"})
    try:
        model = load_model(model_path)
    except Exception as error:
        emit({"event": "fatal", "error": f"{type(error).__name__}: {error}"})
        return
    emit({"event": "ready"})

    prompts = {}
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if request.get("op") != "synthesize":
                raise ValueError(f"unknown operation {request.get('op')!r}")
            reference_path = request["referencePath"]
            transcript = request["referenceTranscript"]
            key = reference_key(reference_path, transcript)
            prompt = prompts.get(key)
            if prompt is None:
                prompt = model.create_voice_clone_prompt(reference_path, transcript)
                prompts = {key: prompt}
            audio = model.generate(
                text=request["text"],
                voice_clone_prompt=prompt,
                num_step=DIFFUSION_STEPS,
            )
            write_audio(request["outputPath"], audio[0])
            emit({"id": request["id"], "ok": True})
        except Exception as error:
            if request.get("outputPath"):
                try:
                    os.remove(request["outputPath"])
                except FileNotFoundError:
                    pass
            emit(
                {
                    "id": request.get("id") if isinstance(request, dict) else None,
                    "ok": False,
                    "error": f"{type(error).__name__}: {error}",
                }
            )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--smoke-output")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    if args.smoke_output:
        smoke(args.model, args.smoke_output, args.seed)
    else:
        serve(args.model)


if __name__ == "__main__":
    main()
