import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState, useSyncExternalStore } from "react";
import { messageFromError } from "../../lib/errors";
import { resetAgentVoicePlaybackStream } from "../../lib/use-agent-voice-playback";
import {
  applyVoicePlaybackSettings,
  clearVoicePlaybackError,
  initVoicePlayback,
  speakVoiceTurn,
  stopVoicePlayback,
  subscribeVoicePlayback,
  voicePlaybackAvailable,
  voicePlaybackState,
} from "../../lib/voice-playback";
import {
  clearVoicePlaybackReference,
  saveVoicePlaybackSettings,
  setVoicePlaybackReference,
  type VoicePlaybackStatusDto,
  voicePlaybackInstall,
  voicePlaybackWarm,
} from "../../lib/tauri";
import { Switch } from "../ui/Switch";

const PREVIEW_TURN_ID = "settings:voice-preview";
const PREVIEW_TEXT =
  "Hi, I'm June. This is how replies will sound when I read them aloud on this Mac.";

export function VoicePlaybackSection() {
  const voice = useSyncExternalStore(subscribeVoicePlayback, voicePlaybackState);
  const [acknowledged, setAcknowledged] = useState(false);
  const [referencePath, setReferencePath] = useState<string>();
  const [referenceTranscript, setReferenceTranscript] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    void initVoicePlayback();
  }, []);

  useEffect(() => {
    setAcknowledged(voice.settings?.modelUseAcknowledged ?? false);
  }, [voice.settings?.modelUseAcknowledged]);

  const settings = voice.settings ?? {
    playbackMode: "click" as const,
    modelUseAcknowledged: false,
  };
  const status = voice.status ?? { state: "notInstalled" as const };
  const isInstalled =
    status.state === "idle" || status.state === "starting" || status.state === "ready";
  const setupBusy = status.state === "installing";
  const isPreviewing = voice.turnId === PREVIEW_TURN_ID;

  useEffect(() => {
    if (status.state === "idle" || status.state === "ready") setError(undefined);
  }, [status.state]);

  async function saveMode(playbackMode: "click" | "streaming") {
    setError(undefined);
    try {
      if (playbackMode === "click") {
        resetAgentVoicePlaybackStream();
        await stopVoicePlayback();
      }
      const saved = await saveVoicePlaybackSettings({
        playbackMode,
        modelUseAcknowledged: settings.modelUseAcknowledged,
      });
      applyVoicePlaybackSettings(saved);
      if (playbackMode === "streaming" && isInstalled) {
        await voicePlaybackWarm();
      }
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function install() {
    if (!acknowledged) return;
    setError(undefined);
    clearVoicePlaybackError();
    try {
      const saved = await saveVoicePlaybackSettings({
        playbackMode: settings.playbackMode,
        modelUseAcknowledged: true,
      });
      applyVoicePlaybackSettings(saved);
      await voicePlaybackInstall();
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function chooseReferenceClip() {
    setError(undefined);
    try {
      const picked = await openFileDialog({
        multiple: false,
        title: "Choose a WAV reference clip",
        filters: [{ name: "WAV audio", extensions: ["wav"] }],
      });
      if (typeof picked !== "string") return;
      setReferencePath(picked);
      setReferenceTranscript("");
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function saveReference() {
    if (!referencePath || !referenceTranscript.trim()) return;
    setError(undefined);
    try {
      await stopVoicePlayback();
      const saved = await setVoicePlaybackReference(referencePath, referenceTranscript.trim());
      applyVoicePlaybackSettings(saved);
      setReferencePath(undefined);
      setReferenceTranscript("");
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function clearReference() {
    setError(undefined);
    try {
      await stopVoicePlayback();
      applyVoicePlaybackSettings(await clearVoicePlaybackReference());
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function preview() {
    setError(undefined);
    try {
      await speakVoiceTurn(PREVIEW_TURN_ID, PREVIEW_TEXT);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  const modelDescription = describeStatus(status);
  const visibleError = error ?? voice.error;

  return (
    <section className="settings-group" aria-labelledby="voice-playback-heading">
      <h2 id="voice-playback-heading" className="settings-group-heading">
        Voice playback
      </h2>
      <p className="settings-group-description">
        Read agent replies aloud using a voice generated entirely on this Mac. Reply text, reference
        audio, and generated speech stay local.
      </p>
      <div className="settings-card">
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Local voice model</h3>
              <p className="settings-row-description">{modelDescription}</p>
              {status.state === "installing" && status.progress !== undefined ? (
                <progress value={status.progress} max={100} aria-label="Voice model setup progress">
                  {status.progress}%
                </progress>
              ) : null}
            </div>
            <div className="settings-row-control">
              {status.state === "notInstalled" || status.state === "error" ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!acknowledged}
                  onClick={() => void install()}
                >
                  {status.state === "error" ? "Try setup again" : "Set up"}
                </button>
              ) : status.state === "idle" ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    void voicePlaybackWarm().catch((caught) => setError(messageFromError(caught)))
                  }
                >
                  Load now
                </button>
              ) : status.state === "starting" || status.state === "ready" ? (
                <span className="settings-row-description" role="status">
                  {status.state === "ready" ? "Ready" : "Loading model..."}
                </span>
              ) : null}
            </div>
          </div>

          {status.state === "notInstalled" || status.state === "error" ? (
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Model use acknowledgement</h3>
                <label className="settings-row-description">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.currentTarget.checked)}
                  />{" "}
                  I will use the OmniVoice model only for noncommercial purposes, understand that
                  this does not grant commercial rights, and have permission to clone the voice in
                  my reference clip.
                </label>
              </div>
            </div>
          ) : null}

          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Read replies aloud as they stream</h3>
              <p className="settings-row-description">
                Speak completed sentences while June is still writing. When off, use the speaker
                button under a message.
              </p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={settings.playbackMode === "streaming"}
                disabled={setupBusy}
                aria-label="Read replies aloud as they stream"
                onCheckedChange={(streaming) => void saveMode(streaming ? "streaming" : "click")}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Voice reference</h3>
              <p className="settings-row-description">
                {settings.referenceClip
                  ? `Using ${settings.referenceClip.fileName}, ${formatDuration(settings.referenceClip.durationMs)}.`
                  : "Using June's generated local voice. Choose a clear WAV clip to clone another voice. OmniVoice recommends 3-10 seconds for best results, but June accepts any duration."}
              </p>
            </div>
            <div className="settings-row-control">
              {settings.referenceClip ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={setupBusy}
                  onClick={() => void clearReference()}
                >
                  Use June's voice
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-secondary"
                disabled={setupBusy}
                onClick={() => void chooseReferenceClip()}
              >
                {settings.referenceClip ? "Change clip" : "Choose clip"}
              </button>
            </div>
          </div>

          {referencePath ? (
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Reference transcript</h3>
                <p className="settings-row-description">
                  Enter exactly what is spoken in {fileName(referencePath)}. This transcript is
                  required for accurate voice cloning.
                </p>
                <input
                  type="text"
                  className="dialog-input"
                  value={referenceTranscript}
                  placeholder="What the clip says"
                  aria-label="Reference transcript"
                  onChange={(event) => setReferenceTranscript(event.currentTarget.value)}
                />
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setReferencePath(undefined);
                    setReferenceTranscript("");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={setupBusy || !referenceTranscript.trim()}
                  onClick={() => void saveReference()}
                >
                  Save voice
                </button>
              </div>
            </div>
          ) : null}

          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Preview</h3>
              <p className="settings-row-description">
                Hear the current voice. Loading the model can take a moment the first time.
              </p>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!voicePlaybackAvailable()}
                onClick={() =>
                  void (isPreviewing ? stopVoicePlayback() : preview()).catch((caught) =>
                    setError(messageFromError(caught)),
                  )
                }
              >
                {isPreviewing ? (voice.loading ? "Preparing..." : "Stop") : "Play sample"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <p className="settings-group-description">
        The model weights are available under CC-BY-NC for noncommercial use. Built with Higgs
        Materials licensed from Boson AI USA, Inc. and Meta Llama 3. See the{" "}
        <a href="https://huggingface.co/k2-fsa/OmniVoice" target="_blank" rel="noreferrer">
          OmniVoice model page
        </a>{" "}
        for license details.
      </p>
      {visibleError ? (
        <p className="settings-status" role="alert">
          {visibleError}
        </p>
      ) : null}
    </section>
  );
}

function describeStatus(status: VoicePlaybackStatusDto) {
  switch (status.state) {
    case "unavailable":
      return `Voice playback is unavailable on this Mac: ${status.reason}`;
    case "notInstalled":
      return "Set up OmniVoice and its dependencies locally. The download is several gigabytes.";
    case "installing":
      return status.progress === undefined
        ? status.stage
        : `${status.stage} ${Math.round(status.progress)}%`;
    case "idle":
      return "The model is installed locally and will load when voice playback starts.";
    case "starting":
      return "Loading the local voice model.";
    case "ready":
      return "The local voice model is ready.";
    case "error":
      return status.message;
  }
}

function formatDuration(durationMs: number) {
  const seconds = durationMs / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} seconds`;
}

function fileName(path: string) {
  return path.split("/").at(-1) ?? path;
}
