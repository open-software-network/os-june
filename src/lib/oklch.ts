// Tiny hex to oklch converter for programmatic palette tweaks such as the
// glass mark's dark-mode modifier. This intentionally stays dependency-free:
// it only nudges already-in-gamut UI colors and clamps the result to sRGB.

type Oklch = { l: number; c: number; h: number };

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** Parse #rgb, #rgba, #rrggbb, or #rrggbbaa. Alpha is ignored. */
function parseHex(input: string): [number, number, number] | null {
  const n = input.trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(n)) return null;

  let pairs: [string, string, string];
  if (n.length === 3 || n.length === 4) {
    pairs = [`${n[0]}${n[0]}`, `${n[1]}${n[1]}`, `${n[2]}${n[2]}`];
  } else if (n.length === 6 || n.length === 8) {
    pairs = [n.slice(0, 2), n.slice(2, 4), n.slice(4, 6)];
  } else {
    return null;
  }

  const rgb = pairs.map((pair) => Number.parseInt(pair, 16)) as [number, number, number];
  return rgb.some(Number.isNaN) ? null : rgb;
}

function rgbToOklch([rByte, gByte, bByte]: [number, number, number]): Oklch {
  const r = srgbToLinear(rByte / 255);
  const g = srgbToLinear(gByte / 255);
  const b = srgbToLinear(bByte / 255);
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const l = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  return { l, c: Math.hypot(a, bb), h: hue < 0 ? hue + 360 : hue };
}

function oklchToHex({ l, c, h }: Oklch): string {
  const hue = (h * Math.PI) / 180;
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];

  return `#${linear
    .map((value) => {
      const byte = Math.round(Math.min(1, Math.max(0, linearToSrgb(value))) * 255);
      return byte.toString(16).padStart(2, "0");
    })
    .join("")}`;
}

/** Scale a hex color's oklch chroma and/or lift its lightness, preserving hue. */
export function adjustOklch(
  hex: string,
  { chromaScale = 1, lightnessLift = 0 }: { chromaScale?: number; lightnessLift?: number },
): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const { l, c, h } = rgbToOklch(rgb);
  return oklchToHex({ l: l + lightnessLift, c: c * chromaScale, h });
}
