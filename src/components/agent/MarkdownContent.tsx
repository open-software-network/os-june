import type { ReactNode } from "react";

import { repairContractionSpacing } from "../../lib/agent-chat-runtime";

/** The agent-side markdown renderer, extracted from AgentWorkspace so other
 * chat surfaces (the note chat panel) render assistant prose identically.
 * Deliberately hand-rolled and conservative — see renderMarkdownBlocks. */
export function MarkdownContent({
  markdown,
  highlight,
  activeHighlightIndex,
  // Repairs the gateway's dropped-space-after-contraction artifact ("it'snot"
  // -> "it's not"). Only set for assistant prose: it must never touch code or
  // a user's own text. See repairContractionSpacing.
  repairProse = false,
  // Wraps prose words in .agent-stream-word spans so each fades in as the
  // stream reveals it. Only set while a turn is actively streaming: the spans
  // are presentation-only and the completed turn re-renders as plain text.
  animateWords = false,
}: {
  markdown: string;
  highlight?: string;
  activeHighlightIndex?: number;
  repairProse?: boolean;
  animateWords?: boolean;
}) {
  const highlightCursor: HighlightCursor = {
    activeIndex: activeHighlightIndex,
    nextIndex: 0,
  };
  return (
    <div className="agent-markdown">
      {renderMarkdownBlocks(markdown, highlight, repairProse, highlightCursor, animateWords)}
    </div>
  );
}

export type HighlightCursor = {
  activeIndex?: number;
  nextIndex: number;
};

/** Wraps case-insensitive matches of `highlight` in <mark>, leaving the text
 * untouched when there's nothing to find. Every text emission point in the
 * markdown renderer funnels through here so find-in-file can light up
 * rendered documents, not just raw source. */
export function highlightText(
  text: string,
  highlight: string | undefined,
  keySeed: string,
  highlightCursor?: HighlightCursor,
): ReactNode[] {
  const needle = highlight?.toLowerCase();
  if (!needle) return [text];
  const lower = text.toLowerCase();
  const nodes: ReactNode[] = [];
  let textCursor = 0;
  let count = 0;
  for (;;) {
    const at = lower.indexOf(needle, textCursor);
    if (at < 0) break;
    if (at > textCursor) nodes.push(text.slice(textCursor, at));
    const matchIndex = highlightCursor?.nextIndex ?? count;
    if (highlightCursor) highlightCursor.nextIndex += 1;
    nodes.push(
      <mark
        key={`hl-${keySeed}-${count++}`}
        className={
          matchIndex === highlightCursor?.activeIndex ? "agent-search-match-active" : undefined
        }
        data-search-match-index={matchIndex}
      >
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    textCursor = at + needle.length;
  }
  if (textCursor < text.length) nodes.push(text.slice(textCursor));
  return nodes;
}

/** Splits string nodes into word spans so streaming prose can fade in one
 * word at a time. Keys are positional within the run: streamed text is
 * append-only, so earlier words keep their spans across re-renders and only
 * newly revealed words mount (and animate). Non-string nodes (search <mark>s)
 * pass through untouched. */
function wrapStreamWords(nodes: ReactNode[], keyPrefix: string): ReactNode[] {
  const wrapped: ReactNode[] = [];
  nodes.forEach((node, nodeIndex) => {
    if (typeof node !== "string") {
      wrapped.push(node);
      return;
    }
    for (const [tokenIndex, token] of node.split(/(\s+)/).entries()) {
      if (!token) continue;
      if (/^\s+$/.test(token)) {
        wrapped.push(token);
      } else {
        wrapped.push(
          // biome-ignore lint/suspicious/noArrayIndexKey: the positional key is the mechanism — append-only streaming keeps earlier positions stable so only new words mount and fade.
          <span key={`${keyPrefix}-w${nodeIndex}-${tokenIndex}`} className="agent-stream-word">
            {token}
          </span>,
        );
      }
    }
  });
  return wrapped;
}

function renderMarkdownBlocks(
  markdown: string,
  highlight?: string,
  repairProse = false,
  highlightCursor?: HighlightCursor,
  animateWords = false,
) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    paragraph = [];
    if (!text) return;
    blocks.push(
      <p key={`p-${key++}`}>
        {renderInlineMarkdown(text, key, highlight, repairProse, highlightCursor, animateWords)}
      </p>,
    );
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      // Skip empty fences — including a stray trailing ``` while streaming —
      // so we don't flash an empty code block (a bare padded gray bar).
      const body = code.join("\n");
      if (body.trim()) {
        blocks.push(
          <pre key={`code-${key++}`}>
            <code>{highlightText(body, highlight, `code-${key}`, highlightCursor)}</code>
          </pre>,
        );
      }
      continue;
    }

    // Thematic break (---, ***, ___) → a quiet rule instead of literal dashes.
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      flushParagraph();
      blocks.push(<hr key={`hr-${key++}`} className="agent-md-rule" />);
      continue;
    }

    // Blockquote: strip the > prefix and re-render the inner lines, so quotes
    // can hold paragraphs, lists, or code like any other block.
    if (trimmed.startsWith(">")) {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoted.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      index -= 1;
      blocks.push(
        <blockquote key={`quote-${key++}`}>
          {renderMarkdownBlocks(
            quoted.join("\n"),
            highlight,
            repairProse,
            highlightCursor,
            animateWords,
          )}
        </blockquote>,
      );
      continue;
    }

    // Pipe table: a |…| row followed by a |---|---| separator.
    const isTableRow = (value: string) =>
      value.startsWith("|") && value.endsWith("|") && value.length > 1;
    if (
      isTableRow(trimmed) &&
      index + 1 < lines.length &&
      /^\|(\s*:?-+:?\s*\|)+$/.test(lines[index + 1].trim())
    ) {
      flushParagraph();
      const splitRow = (value: string) =>
        value
          .slice(1, -1)
          .split("|")
          .map((cell) => cell.trim());
      const header = splitRow(trimmed);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index].trim())) {
        rows.push(splitRow(lines[index].trim()));
        index += 1;
      }
      index -= 1;
      blocks.push(
        <div key={`table-${key++}`} className="agent-md-table">
          <table>
            <thead>
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={cellIndex}>
                    {renderInlineMarkdown(
                      cell,
                      key,
                      highlight,
                      repairProse,
                      highlightCursor,
                      animateWords,
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>
                      {renderInlineMarkdown(
                        cell,
                        key,
                        highlight,
                        repairProse,
                        highlightCursor,
                        animateWords,
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1].length, 3);
      const content = renderInlineMarkdown(
        heading[2],
        key,
        highlight,
        repairProse,
        highlightCursor,
        animateWords,
      );
      blocks.push(
        level === 1 ? <h2 key={`h-${key++}`}>{content}</h2> : <h3 key={`h-${key++}`}>{content}</h3>,
      );
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (unordered || ordered) {
      flushParagraph();
      const orderedList = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index].trim();
        const match = orderedList
          ? /^\d+\.\s+(.+)$/.exec(candidate)
          : /^[-*]\s+(.+)$/.exec(candidate);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      index -= 1;
      const listItems = items.map((item, itemIndex) => (
        <li key={`li-${key}-${itemIndex}`}>
          {renderInlineMarkdown(
            item,
            key + itemIndex,
            highlight,
            repairProse,
            highlightCursor,
            animateWords,
          )}
        </li>
      ));
      blocks.push(
        orderedList ? (
          <ol key={`list-${key++}`}>{listItems}</ol>
        ) : (
          <ul key={`list-${key++}`}>{listItems}</ul>
        ),
      );
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}

function renderInlineMarkdown(
  text: string,
  keySeed: number,
  highlight?: string,
  repairProse = false,
  highlightCursor?: HighlightCursor,
  animateWords = false,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const mark = (value: string, slot: string) =>
    highlightText(value, highlight, `${keySeed}-${slot}`, highlightCursor);
  // Prose runs (plain text, emphasis, link text) get the contraction-spacing
  // repair and the streaming word fade; code spans and URLs go through `mark`
  // untouched.
  const markProse = (value: string, slot: string) => {
    const marked = mark(repairProse ? repairContractionSpacing(value) : value, slot);
    return animateWords ? wrapStreamWords(marked, `${keySeed}-${slot}`) : marked;
  };
  const pattern =
    /(\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let lastIndex = 0;
  let index = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      nodes.push(...markProse(text.slice(lastIndex, match.index), `g${index}`));
    }
    if (match[2]) {
      nodes.push(
        <strong key={`strong-${keySeed}-${index}`}>{markProse(match[2], `s${index}`)}</strong>,
      );
    } else if (match[3]) {
      nodes.push(<em key={`em-${keySeed}-${index}`}>{markProse(match[3], `e${index}`)}</em>);
    } else if (match[4]) {
      nodes.push(<del key={`del-${keySeed}-${index}`}>{markProse(match[4], `d${index}`)}</del>);
    } else if (match[5]) {
      nodes.push(<code key={`code-${keySeed}-${index}`}>{mark(match[5], `c${index}`)}</code>);
    } else if (match[6] && match[7]) {
      nodes.push(
        <a key={`link-${keySeed}-${index}`} href={match[7]} rel="noreferrer" target="_blank">
          {markProse(match[6], `a${index}`)}
        </a>,
      );
    }
    lastIndex = pattern.lastIndex;
    index += 1;
    match = pattern.exec(text);
  }
  if (lastIndex < text.length) {
    nodes.push(...markProse(text.slice(lastIndex), "t"));
  }
  return nodes;
}
