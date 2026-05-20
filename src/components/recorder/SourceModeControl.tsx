import type {
  RecordingSourceMode,
  RecordingSourceReadinessDto,
} from "../../lib/tauri";

type SourceModeControlProps = {
  value: RecordingSourceMode;
  disabled: boolean;
  readiness?: RecordingSourceReadinessDto;
  onChange: (mode: RecordingSourceMode) => void;
};

const options: Array<{ value: RecordingSourceMode; label: string }> = [
  { value: "microphoneOnly", label: "Microphone only" },
  { value: "microphonePlusSystem", label: "Microphone + system audio" },
];

export function SourceModeControl({
  value,
  disabled,
  readiness,
  onChange,
}: SourceModeControlProps) {
  const failedSources =
    readiness?.sources.filter((source) => source.required && !source.ready) ??
    [];

  return (
    <div className="source-mode-control">
      <div
        className="source-mode-options"
        role="radiogroup"
        aria-label="Recording source"
      >
        {options.map((option) => (
          <label
            key={option.value}
            className="source-mode-option"
            data-selected={value === option.value}
          >
            <input
              type="radio"
              name="recording-source-mode"
              value={option.value}
              checked={value === option.value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {failedSources.length > 0 ? (
        <div className="source-readiness-warning" role="status">
          {failedSources.map((source) => (
            <p key={source.source}>
              {source.message ??
                `${labelForSource(source.source)} is not ready.`}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function labelForSource(source: string) {
  return source === "system" ? "System audio" : "Microphone";
}
