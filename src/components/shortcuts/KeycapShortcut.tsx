import { isWindowsPlatform } from "../../lib/platform";

/**
 * Renders a keyboard shortcut as platform-appropriate keycaps inside a single
 * framed group. Shared by Settings and the Dictation page.
 */
const MAC_KEY_GLYPHS: Record<string, { glyph: string; name: string }> = {
  cmd: { glyph: "⌘", name: "Command" },
  command: { glyph: "⌘", name: "Command" },
  meta: { glyph: "⌘", name: "Command" },
  ctrl: { glyph: "⌃", name: "Control" },
  control: { glyph: "⌃", name: "Control" },
  opt: { glyph: "⌥", name: "Option" },
  option: { glyph: "⌥", name: "Option" },
  alt: { glyph: "⌥", name: "Option" },
  shift: { glyph: "⇧", name: "Shift" },
  fn: { glyph: "fn", name: "Function" },
  function: { glyph: "fn", name: "Function" },
};

const WINDOWS_KEY_GLYPHS: Record<string, { glyph: string; name: string }> = {
  cmd: { glyph: "Win", name: "Windows" },
  command: { glyph: "Win", name: "Windows" },
  meta: { glyph: "Win", name: "Windows" },
  win: { glyph: "Win", name: "Windows" },
  ctrl: { glyph: "Ctrl", name: "Control" },
  control: { glyph: "Ctrl", name: "Control" },
  opt: { glyph: "Alt", name: "Alt" },
  option: { glyph: "Alt", name: "Alt" },
  alt: { glyph: "Alt", name: "Alt" },
  shift: { glyph: "Shift", name: "Shift" },
};

export function KeycapShortcut({
  label,
  capturing = false,
  platform,
}: {
  label: string;
  capturing?: boolean;
  platform?: "macos" | "windows" | "unsupported";
}) {
  if (capturing) {
    return <span className="keycap-frame keycap-frame-capturing">Press shortcut...</span>;
  }
  const windows = platform === "windows" || (platform === undefined && isWindowsPlatform());
  const keyGlyphs = windows ? WINDOWS_KEY_GLYPHS : MAC_KEY_GLYPHS;
  const keys = label.split("+").filter(Boolean);
  return (
    <span className="keycap-frame" aria-label={`Shortcut ${label}`}>
      {keys.map((key, idx) => {
        const mapped = keyGlyphs[key.toLowerCase()];
        return (
          <kbd key={`${key}-${idx}`} className="keycap" title={mapped?.name}>
            {mapped ? mapped.glyph : key}
          </kbd>
        );
      })}
    </span>
  );
}
