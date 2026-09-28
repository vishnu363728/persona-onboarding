import { Fragment, type ReactNode } from "react";

// A small, deliberately non-HTML renderer for the formatting useful in chat.
// Model output and user text never become raw HTML.
const inlinePattern =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^\s)]+\)|\*[^*\n]+\*|_[^_\n]+_)/g;

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const index = match.index!,
      token = match[0];
    parts.push(text.slice(cursor, index));
    if (
      token.startsWith("_") &&
      (/[\p{L}\p{N}]/u.test(text[index - 1] || "") ||
        /[\p{L}\p{N}]/u.test(text[index + token.length] || ""))
    ) {
      // Snake-case names and unformatted URLs are text, not emphasis.
      parts.push(token);
    } else if (token.startsWith("**") || token.startsWith("__"))
      parts.push(<strong key={index}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`"))
      parts.push(<code key={index}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      try {
        const url = new URL(link[2]);
        parts.push(
          ["https:", "http:"].includes(url.protocol) ? (
            <a
              key={index}
              href={url.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {link[1]}
            </a>
          ) : (
            token
          ),
        );
      } catch {
        parts.push(token);
      }
    } else parts.push(<em key={index}>{token.slice(1, -1)}</em>);
    cursor = index + token.length;
  }
  parts.push(text.slice(cursor));
  return parts;
}

function listItems(line: string, marker: RegExp): string[] {
  const content = line.replace(marker, "");
  if (!/^\s*•\s+/.test(line)) return [content];

  // Some model replies compress a Unicode list onto one line. Only split
  // list-starting lines, outside the inline formatting we already support.
  const protectedSpans = Array.from(content.matchAll(inlinePattern), (match) => [
    match.index!,
    match.index! + match[0].length,
  ]);
  const items: string[] = [];
  let cursor = 0;
  for (const match of content.matchAll(/\s+•\s+(?=\S)/g)) {
    const bulletAt = match.index! + match[0].indexOf("•");
    if (protectedSpans.some(([start, end]) => bulletAt >= start && bulletAt < end))
      continue;
    items.push(content.slice(cursor, match.index));
    cursor = match.index! + match[0].length;
  }
  items.push(content.slice(cursor));
  return items;
}

export function MessageText({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(lines[i])) {
      const key = i++,
        code: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i]))
        code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(
        <pre key={key}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const bullet = /^\s*[-*•]\s+/.test(lines[i]);
    const numbered = /^\s*\d+[.)]\s+/.exec(lines[i]);
    if (bullet || numbered) {
      const key = i,
        items: ReactNode[] = [];
      const pattern = bullet ? /^\s*[-*•]\s+/ : /^\s*\d+[.)]\s+/;
      while (i < lines.length && pattern.test(lines[i])) {
        listItems(lines[i], pattern).forEach((item, j) =>
          items.push(<li key={`${i}-${j}`}>{inline(item)}</li>),
        );
        i++;
      }
      blocks.push(
        bullet ? (
          <ul key={key}>{items}</ul>
        ) : (
          <ol key={key} start={Number.parseInt(numbered![0], 10)}>
            {items}
          </ol>
        ),
      );
      continue;
    }
    const key = i,
      paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(?:```|[-*•]\s+|\d+[.)]\s+)/.test(lines[i])
    ) {
      paragraph.push(lines[i++].replace(/^#{1,6}\s+/, ""));
    }
    blocks.push(
      <p key={key}>
        {paragraph.map((line, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(line)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="message-text">{blocks}</div>;
}
