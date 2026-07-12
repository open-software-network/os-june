import { stripAgentCliAccessRequest } from "./agent-cli-access";
import { stripMediaReferences } from "./agent-chat-runtime";

// Short requests keep sentence streaming responsive and stay well below the
// native command's 1,000-character ceiling.
const MAX_CHUNK_CHARS = 240;
const SENTENCE_BOUNDARY = /[.!?…][)\]"'”’»]*\s+|\n{2,}/g;

export function speakableVoiceText(markdown: string): string {
  return stripMediaReferences(stripAgentCliAccessRequest(markdown))
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, " ")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-|:\s]+\s*$/gm, " ")
    .replace(/^\s*\|.*\|\s*$/gm, (row) =>
      row
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(", "),
    )
    .replace(/(\*\*|__|\*|_|~~)(\S(?:[\s\S]*?\S)?)\1/g, "$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function voiceTextChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const part of splitSentences(text).flatMap(splitLongSentence)) {
    if (current && current.length + part.length + 1 > MAX_CHUNK_CHARS) {
      chunks.push(current);
      current = part;
    } else {
      current = current ? `${current} ${part}` : part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  SENTENCE_BOUNDARY.lastIndex = 0;
  for (const match of text.matchAll(SENTENCE_BOUNDARY)) {
    const end = match.index + match[0].length;
    const sentence = text.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

function splitLongSentence(sentence: string): string[] {
  const parts: string[] = [];
  let remaining = sentence;
  while (remaining.length > MAX_CHUNK_CHARS) {
    let end = safeTextEnd(remaining, MAX_CHUNK_CHARS);
    for (let index = end; index > 0; index -= 1) {
      if (/\s/.test(remaining[index - 1])) {
        end = index - 1;
        break;
      }
    }
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function safeTextEnd(text: string, maxLength: number) {
  let end = Math.min(text.length, maxLength);
  const lastCodeUnit = text.charCodeAt(end - 1);
  const nextCodeUnit = text.charCodeAt(end);
  if (
    lastCodeUnit >= 0xd800 &&
    lastCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  ) {
    end -= 1;
  }
  return end;
}

export class StreamingVoiceText {
  private consumed = 0;

  push(fullText: string): string[] {
    const pending = fullText.slice(this.consumed);
    const safeEnd = lastBoundaryOutsideFences(pending);
    if (safeEnd === 0) return [];
    this.consumed += safeEnd;
    const text = speakableVoiceText(pending.slice(0, safeEnd));
    return text ? voiceTextChunks(text) : [];
  }

  flush(fullText: string): string[] {
    const pending = fullText.slice(this.consumed);
    this.consumed = fullText.length;
    const text = speakableVoiceText(pending);
    return text ? voiceTextChunks(text) : [];
  }
}

function lastBoundaryOutsideFences(text: string): number {
  let end = 0;
  let insideFence = false;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      insideFence = !insideFence;
    } else if (!insideFence) {
      if (line.trim() === "") end = offset + line.length;
      SENTENCE_BOUNDARY.lastIndex = 0;
      for (const match of line.matchAll(SENTENCE_BOUNDARY)) {
        end = offset + match.index + match[0].length;
      }
    }
    offset += line.length;
  }
  return end;
}
