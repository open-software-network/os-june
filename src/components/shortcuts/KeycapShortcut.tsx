/**
 * Renders a keyboard shortcut as macOS-style keycaps inside a single framed
 * group. Shared by Settings (where it can also show a capturing state) and the
 * Dictation page. Modifier keys render as their Mac glyph (⌃ ⌥ ⌘ ⇧ fn) with the
 * full name available on hover; everything else renders verbatim.
 */
const KEY_GLYPHS: Record<string, { glyph: string; name: string }> = {
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

export function KeycapShortcut({
  label,
  capturing = false,
}: {
  label: string;
  capturing?: boolean;
}) {
  if (capturing) {
    return (
      <span className="keycap-frame keycap-frame-capturing">
        Press shortcut...
      </span>
    );
  }
  const keys = label.split("+").filter(Boolean);
  return (
    <span className="keycap-frame" aria-label={`Shortcut ${label}`}>
      {keys.map((key, idx) => {
        const mapped = KEY_GLYPHS[key.toLowerCase()];
        return (
          <kbd key={`${key}-${idx}`} className="keycap" title={mapped?.name}>
            {mapped ? mapped.glyph : key}
          </kbd>
        );
      })}
    </span>
  );
}
