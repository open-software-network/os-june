import { IconAnthropic } from "central-icons/IconAnthropic";
import { IconClaudeai } from "central-icons/IconClaudeai";
import { IconDeepseek } from "central-icons/IconDeepseek";
import { IconGemini } from "central-icons/IconGemini";
import { IconGrok } from "central-icons/IconGrok";
import { IconMetaAi } from "central-icons/IconMetaAi";
import { IconMistral } from "central-icons/IconMistral";
import { IconNvidia } from "central-icons/IconNvidia";
import { IconOllama } from "central-icons/IconOllama";
import { IconOpenai } from "central-icons/IconOpenai";
import { IconPerplexity } from "central-icons/IconPerplexity";
import { JuneMark } from "../brand/JuneWordmark";

type ProviderLogoProps = {
  provider: string;
  id: string;
  name?: string;
  size?: number;
};

export function ProviderLogo({ provider, id, name = "", size = 18 }: ProviderLogoProps) {
  const kind = classifyProvider(provider, id, name);
  switch (kind) {
    case "june":
      return <JuneMark size={size} />;
    case "openai":
      return <IconOpenai size={size} aria-label="OpenAI" />;
    case "anthropic":
      return <IconClaudeai size={size} aria-label="Claude" />;
    case "google":
      return <IconGemini size={size} aria-label="Gemini" />;
    case "meta":
      return <IconMetaAi size={size} aria-label="Meta" />;
    case "mistral":
      return <IconMistral size={size} aria-label="Mistral" />;
    case "deepseek":
      return <IconDeepseek size={size} aria-label="DeepSeek" />;
    case "perplexity":
      return <IconPerplexity size={size} aria-label="Perplexity" />;
    case "ollama":
      return <IconOllama size={size} aria-label="Ollama" />;
    case "xai":
      return <IconGrok size={size} aria-label="Grok" />;
    case "nvidia":
      return <IconNvidia size={size} aria-label="NVIDIA" />;
    case "elevenlabs":
      return <ElevenLabsMark size={size} />;
    case "venice":
      return <VeniceMark size={size} />;
    case "fal":
      return <FalMark size={size} />;
    default:
      return <Monogram label={initials(name || id || provider)} size={size} />;
  }
}

// Anthropic gets two aliases — IconAnthropic and IconClaudeai. We prefer the
// product mark (Claude) because that's the visible product name.
export { IconAnthropic };

type ProviderKind =
  | "june"
  | "openai"
  | "anthropic"
  | "google"
  | "meta"
  | "mistral"
  | "deepseek"
  | "perplexity"
  | "ollama"
  | "xai"
  | "nvidia"
  | "elevenlabs"
  | "venice"
  | "fal"
  | "unknown";

function classifyProvider(provider: string, id: string, name: string): ProviderKind {
  // Auto is a June-managed route even when its catalog record inherits a
  // provider value from the currently available routing backends.
  if (id.toLowerCase() === "open-software/auto") return "june";

  // Model family takes precedence over hosting platform (e.g. Venice-hosted
  // GPT-4o still reads as OpenAI). Hosting providers (venice, fal) only win
  // when nothing more specific matched.
  const normalizedProvider = provider.toLowerCase();
  const haystack = `${normalizedProvider} ${id} ${name}`.toLowerCase();

  if (
    normalizedProvider === "openai" ||
    haystack.includes("gpt-") ||
    haystack.includes("whisper-1") ||
    haystack.includes("o1-") ||
    haystack.includes("o3-") ||
    haystack.includes("o4-")
  ) {
    return "openai";
  }
  if (
    normalizedProvider === "anthropic" ||
    haystack.includes("claude") ||
    haystack.includes("anthropic")
  ) {
    return "anthropic";
  }
  if (haystack.includes("gemini") || haystack.includes("google")) {
    return "google";
  }
  if (haystack.includes("llama") || haystack.includes("meta-")) return "meta";
  if (haystack.includes("mistral") || haystack.includes("mixtral")) {
    return "mistral";
  }
  if (haystack.includes("deepseek")) return "deepseek";
  if (haystack.includes("perplexity") || haystack.includes("pplx")) {
    return "perplexity";
  }
  if (haystack.includes("ollama")) return "ollama";
  if (normalizedProvider === "xai" || haystack.includes("grok") || haystack.includes("xai/")) {
    return "xai";
  }
  if (haystack.includes("nvidia") || haystack.includes("parakeet")) {
    return "nvidia";
  }
  if (haystack.includes("eleven")) return "elevenlabs";

  // Whisper Large V3 / V3 ships through Fal — checked after OpenAI's
  // whisper-1 so the legacy model still maps correctly.
  if (
    haystack.includes("whisper-large") ||
    haystack.includes("whisper-v3") ||
    haystack.includes("fal-ai") ||
    haystack.includes("fal/") ||
    haystack.startsWith("fal ")
  ) {
    return "fal";
  }
  if (haystack.includes("openai")) return "openai";
  if (haystack.includes("venice")) return "venice";

  return "unknown";
}

function initials(source: string) {
  const cleaned = source
    .replace(/[/_-]+/g, " ")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function Monogram({ label, size }: { label: string; size: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        fontSize: Math.round(size * 0.55),
        fontWeight: 500,
        lineHeight: 1,
        letterSpacing: "-0.02em",
      }}
    >
      {label || "?"}
    </span>
  );
}

// Visual weight calibration. Custom SVGs fill their viewBox unevenly, so at
// equal pixel size their marks read larger or smaller than central-icons.
// These factors approximate the central-icons baseline (~85% viewBox fill).
const FAL_SCALE = 0.78;
const VENICE_SCALE = 0.86;
const ELEVENLABS_SCALE = 1.05;

function ElevenLabsMark({ size }: { size: number }) {
  const s = Math.round(size * ELEVENLABS_SCALE);
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 876 876"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="ElevenLabs"
    >
      <path d="M468 292H528V584H468V292Z" fill="currentColor" />
      <path d="M348 292H408V584H348V292Z" fill="currentColor" />
    </svg>
  );
}

function FalMark({ size }: { size: number }) {
  const s = Math.round(size * FAL_SCALE);
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 170 171"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Fal"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M109.571 0.690002C112.515 0.690002 114.874 3.08348 115.155 6.01352C117.665 32.149 138.466 52.948 164.603 55.458C167.534 55.7394 169.927 58.0985 169.927 61.042V110.255C169.927 113.198 167.534 115.557 164.603 115.839C138.466 118.349 117.665 139.148 115.155 165.283C114.874 168.213 112.515 170.607 109.571 170.607H60.3553C57.4116 170.607 55.0524 168.213 54.7709 165.283C52.2608 139.148 31.4601 118.349 5.32289 115.839C2.39266 115.557 -0.000976562 113.198 -0.000976562 110.255V61.042C-0.000976562 58.0985 2.39267 55.7394 5.3229 55.458C31.4601 52.948 52.2608 32.149 54.7709 6.01351C55.0524 3.08348 57.4116 0.690002 60.3553 0.690002H109.571ZM34.1182 85.5045C34.1182 113.776 57.0124 136.694 85.2539 136.694C113.495 136.694 136.39 113.776 136.39 85.5045C136.39 57.2332 113.495 34.3147 85.2539 34.3147C57.0124 34.3147 34.1182 57.2332 34.1182 85.5045Z"
        fill="currentColor"
      />
    </svg>
  );
}

function VeniceMark({ size }: { size: number }) {
  const s = Math.round(size * VENICE_SCALE);
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 326 366"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Venice"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M105.481 245.984C99.4744 241.518 92.2244 237.777 84.2074 235.504C76.1903 233.231 67.406 232.427 58.8167 233.38C50.2272 234.332 41.8327 237.042 34.5086 241.017C27.1847 244.991 20.931 250.231 16.0487 255.905C11.1531 261.567 6.88803 268.522 4.0314 276.35C1.17477 284.178 -0.273403 292.879 0.0448796 301.515C0.36299 310.152 2.44756 318.723 5.87231 326.319C9.29724 333.916 14.0625 340.538 19.3617 345.825C24.6482 351.124 31.2704 355.889 38.867 359.314C46.4637 362.739 55.0349 364.823 63.671 365.142C72.3073 365.46 81.0085 364.012 88.8366 361.155C96.6647 358.298 103.62 354.033 109.282 349.138C114.956 344.256 120.195 338.002 124.17 330.678C128.144 323.354 130.854 314.959 131.807 306.37C132.76 297.781 131.956 288.996 129.683 280.979C127.41 272.962 123.668 265.712 119.203 259.705L133.953 244.954L144.69 255.691H150.789L158.149 248.331V242.233L147.412 231.496L163 215.908L178.588 231.496L167.851 242.233V248.331L175.211 255.691H181.31L192.047 244.954L206.797 259.705C202.332 265.712 198.59 272.962 196.317 280.979C194.044 288.996 193.24 297.781 194.193 306.37C195.146 314.959 197.856 323.354 201.83 330.678C205.805 338.002 211.044 344.256 216.718 349.138C222.38 354.033 229.335 358.298 237.163 361.155C244.991 364.012 253.693 365.46 262.329 365.142C270.965 364.823 279.536 362.739 287.133 359.314C294.73 355.889 301.352 351.124 306.638 345.825C311.937 340.538 316.703 333.916 320.128 326.319C323.552 318.723 325.637 310.152 325.955 301.515C326.273 292.879 324.825 284.178 321.969 276.35C319.112 268.522 314.847 261.567 309.951 255.905C305.069 250.231 298.815 244.991 291.491 241.017C284.167 237.042 275.773 234.332 267.183 233.38C258.594 232.427 249.81 233.231 241.793 235.504C233.776 237.777 226.526 241.518 220.519 245.984L206.042 231.484L216.773 220.753V214.655L209.151 207.032H203.052L192.315 217.769L176.721 202.186L258.473 120.434L291.567 153.528V119.095H326L292.907 86.0012L326 52.9077V46.8095L318.377 39.1865H312.279L163 188.465L13.7212 39.1865H7.62295L0 46.8095V52.9077L33.0934 86.0012L0 119.095H34.4331V153.528L67.5263 120.434L149.279 202.186L133.685 217.769L122.948 207.032H116.849L109.226 214.655V220.753L119.958 231.484L105.481 245.984ZM238.144 321.715C234.778 328.62 235.477 338.188 239.811 344.531C243.793 351.1 252.216 355.693 259.895 355.484C267.574 355.693 275.997 351.1 279.979 344.531C284.313 338.188 285.012 328.62 281.646 321.715L282.484 320.812C289.389 324.196 298.971 323.511 305.324 319.178C311.904 315.2 316.508 306.768 316.297 299.081C316.508 291.395 311.904 282.963 305.324 278.984C298.971 274.652 289.389 273.966 282.484 277.351L281.646 276.448C285.012 269.543 284.313 259.974 279.979 253.632C275.997 247.063 267.574 242.469 259.895 242.679C252.216 242.469 243.793 247.063 239.811 253.632C235.477 259.974 234.778 269.543 238.144 276.448L237.306 277.351C230.401 273.966 220.818 274.652 214.466 278.984C207.886 282.963 203.282 291.395 203.492 299.081C203.282 306.768 207.886 315.2 214.466 319.178C220.818 323.511 230.401 324.196 237.306 320.812L238.144 321.715ZM86.1857 344.531C90.52 338.188 91.2191 328.62 87.8528 321.715L88.6913 320.812C95.5956 324.196 105.178 323.511 111.531 319.178C118.11 315.2 122.715 306.768 122.504 299.081C122.715 291.395 118.11 282.963 111.531 278.984C105.178 274.652 95.5956 273.966 88.6913 277.351L87.8528 276.448C91.2191 269.543 90.52 259.974 86.1857 253.632C82.2037 247.063 73.7808 242.469 66.1018 242.679C58.423 242.469 50.0001 247.063 46.0181 253.632C41.6839 259.974 40.9847 269.543 44.351 276.448L43.5126 277.351C36.6082 273.966 27.0255 274.652 20.6731 278.984C14.0932 282.963 9.48904 291.395 9.69934 299.081C9.48904 306.768 14.0932 315.2 20.6731 319.178C27.0255 323.511 36.6082 324.196 43.5126 320.812L44.351 321.715C40.9847 328.62 41.6839 338.188 46.0181 344.531C50.0001 351.1 58.423 355.693 66.1018 355.484C73.7808 355.693 82.2037 351.1 86.1857 344.531Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M162.891 39.1864L202.078 0L221.482 19.4047V84.8147L167.742 138.555H158.04L104.3 84.8147V19.4047L123.705 0L162.891 39.1864ZM123.705 13.7213L158.04 48.0567V111.112L123.705 76.7773V13.7213ZM167.744 48.0567L202.079 13.7213V76.7773L167.744 111.112V48.0567Z"
        fill="currentColor"
      />
    </svg>
  );
}
