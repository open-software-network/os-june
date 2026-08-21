type RecordingWarning = {
  message: string;
};

export function recordingWarningsMessage(
  warnings: readonly RecordingWarning[] | undefined,
): string | undefined {
  if (!warnings?.length) return undefined;
  const messages = [...new Set(warnings.map((warning) => warning.message.trim()).filter(Boolean))];
  return messages.length > 0 ? messages.join(" ") : undefined;
}
