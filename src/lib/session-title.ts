export const UNTITLED_SESSION_TITLE = "Untitled session";

export function titleFromPrompt(prompt: string) {
  const source = prompt.replace(/\s+/g, " ").trim();
  if (!source) return UNTITLED_SESSION_TITLE;
  const firstLine = source.split(/[.!?]\s/, 1)[0] ?? source;
  return firstLine.length > 52 ? `${firstLine.slice(0, 51).trimEnd()}…` : firstLine;
}
