# JUN-416 Microphone noise suppression evidence

Status: spectral fallback baseline evaluated on 2026-07-24; RNNoise adapter
unit-verified on 2026-07-24

This document records the evaluation baseline for the spectral fallback and
the deterministic regressions for the approved RNNoise adapter. It must not be
read as product acceptance: JUN-416 remains held for the user's product and
quality decision.

## Method

The spectral evidence set uses a fixed, non-private macOS synthetic speech
reference mixed separately with deterministic fan-like stationary noise,
rain-like broadband noise, and keyboard-like transients. The 16-second
reference has three seconds of leading silence and about three seconds of
trailing silence,
so the noise estimator sees quiet regions as it would in natural speech. Each
noisy WAV passes through
`suppress_microphone_wav_for_transcription`, the same transient derivation
called by saved-audio processing. The original SHA-256 is checked before and
after. The results below were produced from commit
`b50f1dbb9249c729ca0590ef774a9ae1dbd0d745`, where the spectral implementation
was the default. On the current branch, the same invocation evaluates RNNoise:

```sh
cargo run --manifest-path src-tauri/Cargo.toml \
  --example noise_suppression_eval -- input.wav output.wav
```

The example also runs the ordinary streaming normalization stage. Add
`--without-suppression` to produce the setting-off control through that same
normalization path.

For each fixture:

1. Compare the noisy and derived files against the clean reference over the
   same sample count.
2. Report reference SNR and scale-invariant SNR (SI-SNR) before and after.
   SI-SNR is relevant because downstream normalization deliberately changes
   gain. These synthetic metrics isolate signal fidelity; neither is a
   perceptual speech-quality score.
3. Generate before and after spectrograms and retain both clips for listening.
4. Record whether suppression applied or conservatively bypassed.

## Results

| Fixture | Decision | Reference SNR change | SI-SNR change | Quiet-region RMS |
| --- | --- | ---: | ---: | ---: |
| Fan plus hum | Applied, estimated floor -37.5 dBFS | 7.55 to 8.31 dB (+0.76) | 7.23 to 11.29 dB (+4.06) | -32.56 to -42.54 dBFS |
| Rain-like broadband | Applied, estimated floor -29.0 dBFS | 0.90 to 2.95 dB (+2.06) | -0.25 to 5.12 dB (+5.37) | -25.83 to -41.26 dBFS |
| Keyboard-like impacts | Clean-floor bypass at -95.5 dBFS | 4.90 to 4.90 dB (+0.00) | 3.40 to 3.40 dB (+0.00) | -30.61 to -30.61 dBFS |

The input SHA-256 remained identical before and after every run. The evidence
archive contains the clean reference, original noisy mixes, setting-off
normalized controls, setting-on outputs, and side-by-side spectrograms:
[download the JUN-416 evidence archive](https://app.opensoftware.co/api/v1/files/fil_l2JqMGvo55RO/download).

The fallback measurably reduces steady noise, especially quiet-region energy,
but neither steady fixture reaches the issue's 6 dB SI-SNR target. It does not
reduce isolated keyboard transients when the stationary floor is clean, by
design: bypass is safer than deriving an aggressive profile from speech and
impacts.

No ASR comparison or blinded listening panel was run in this environment.
Therefore this evidence makes no transcription-accuracy, clean-speech WER,
consonant-preservation, or perceptual-quality claim. Those remain blocking
product-quality checks for the held feature.

## Cost and resampling regressions

Automated coverage also checks the non-quality boundaries found during review:

- RNNoise declares 48 kHz, 480-sample, non-overlapping frames and rejects an
  incorrectly sized frame;
- deterministic noise-only input loses energy while a speech-band harmonic
  fixture retains energy and produces finite samples;
- an injected RNNoise construction failure selects the spectral fallback;
- a clean bypass and a raw fallback produce the same durable transcription
  configuration fingerprint as suppression off, while an applied derivative
  changes it;
- the derived WAV and its empty `.june-transcription-input` directory are
  removed after the retained transcription consumer drains, while the
  finalized input remains byte-identical; and
- a 1.003-second 44.1 kHz noisy input runs through the production streaming
  resampler and RNNoise with a partial final frame, producing the exact
  expected mono 48 kHz length while preserving the input bytes.

## Expected limitation

The spectral fallback still estimates a stationary profile and is now used
only if RNNoise construction fails. The existing results confirm that fallback
helps steady noise more than isolated keyboard impacts. The RNNoise adapter
tests prove framing and deterministic signal boundaries, not perceptual quality
or transcription accuracy.
