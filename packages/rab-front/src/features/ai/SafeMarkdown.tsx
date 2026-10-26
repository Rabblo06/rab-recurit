import { Fragment, type ReactNode } from 'react';

/**
 * A deliberately small, SAFE Markdown subset for assistant answers (owner brief §12 "Rendering security"). No Markdown
 * library is in this app and a heavy one is not worth its weight for this; this renderer builds React elements only —
 * it never uses `dangerouslySetInnerHTML`, so any HTML in an answer (`<script>`, `<img onerror>`, `<iframe>`) is shown
 * as literal text and can never execute.
 *
 * Supported: paragraphs and line breaks, `#`–`######` headings (sized bold lines, not page headings), fence labels, `-`/`*`/`+`
 * and `1.` lists, `>` quotes, fenced and inline code, `**bold**`, `*italic*`/`_italic_`, `---` rules, `[text](url)`
 * links, `<https://…>` and bare `https://…` autolinks.
 *
 *  - Links: only absolute `http:`/`https:` URLs without embedded credentials pass `safeExternalUrl`; they open in a new
 *    tab with `rel="noopener noreferrer"`. Anything else (`javascript:`, `data:`, `vbscript:`, relative, protocol-relative)
 *    renders as plain text.
 *  - Images (`![alt](url)`) are NEVER loaded: they become a plain link labelled "Image: alt" (or just text when the URL
 *    is not safe).
 */

/** The one URL check for assistant links: absolute http(s), no credentials, no whitespace or control characters. */
export function safeExternalUrl(raw: string): string | null {
  const value = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!value || value.length > 2048 || /[\s\u0000-\u001f\u007f\\]/.test(value)) return null;
  if (!/^https?:\/\//i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || !url.hostname) return null;
  return url.href;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="ai-md-link">
      {children}
    </a>
  );
}

// Order matters: code first (its content is literal), then images, links, autolinks, emphasis.
const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|!\[([^\]\n]{0,200})\]\(([^)\s]{0,2048})(?:\s+"[^"\n]*")?\)|\[([^\]\n]{1,300})\]\(([^)\s]{0,2048})(?:\s+"[^"\n]*")?\)|<(https?:\/\/[^>\s]{1,2048})>|(https?:\/\/[^\s<>()[\]]{1,2048}[^\s<>()[\].,;:!?'"])|\*\*([^*\n](?:[^\n]*?[^*\n])?)\*\*|__([^_\n](?:[^\n]*?[^_\n])?)__|\*([^*\s](?:[^*\n]*?[^*\s])?)\*|(?<![\w])_([^_\s](?:[^_\n]*?[^_\s])?)_(?![\w])/g;

export function renderInline(text: string, keyPrefix = 'i', depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const re = new RegExp(INLINE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${n++}`;
    const nested = (s: string) => (depth < 3 ? renderInline(s, key, depth + 1) : [s]);
    if (m[2] !== undefined) {
      out.push(<code key={key} className="ai-md-code">{m[2]}</code>);
    } else if (m[4] !== undefined) {
      const href = safeExternalUrl(m[4]);
      const label = `Image: ${m[3] || 'untitled'}`;
      out.push(href ? <ExternalLink key={key} href={href}>{label}</ExternalLink> : <Fragment key={key}>{label}</Fragment>);
    } else if (m[5] !== undefined) {
      const href = safeExternalUrl(m[6] ?? '');
      out.push(href ? <ExternalLink key={key} href={href}>{nested(m[5])}</ExternalLink> : <Fragment key={key}>{nested(m[5])}</Fragment>);
    } else if (m[7] !== undefined || m[8] !== undefined) {
      const raw = (m[7] ?? m[8])!;
      const href = safeExternalUrl(raw);
      out.push(href ? <ExternalLink key={key} href={href}>{raw}</ExternalLink> : <Fragment key={key}>{raw}</Fragment>);
    } else if (m[9] !== undefined || m[10] !== undefined) {
      out.push(<strong key={key}>{nested((m[9] ?? m[10])!)}</strong>);
    } else if (m[11] !== undefined || m[12] !== undefined) {
      out.push(<em key={key}>{nested((m[11] ?? m[12])!)}</em>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; text: string; level: number }
  | { kind: 'ul' | 'ol'; items: string[]; start?: number }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; text: string; lang: string | null }
  | { kind: 'hr' };

const MAX_SOURCE = 20_000;

export function parseBlocks(source: string): Block[] {
  const lines = source.slice(0, MAX_SOURCE).replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s{0,3}(```|~~~)\s*([A-Za-z0-9+#._-]{1,20})?/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) body.push(lines[i++]!);
      i += 1; // closing fence (or end of text while streaming)
      blocks.push({ kind: 'code', text: body.join('\n'), lang: fence[2] ?? null });
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'h', text: heading[2]!, level: heading[1]!.length });
      i += 1;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ''));
      blocks.push({ kind: 'quote', lines: quote });
      continue;
    }
    const bullet = /^\s{0,3}[-*+]\s+(.*)$/;
    const ordered = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
    if (bullet.test(line) || ordered.test(line)) {
      const isOrdered = !bullet.test(line);
      const items: string[] = [];
      const start = isOrdered ? Number(ordered.exec(line)![1]) : undefined;
      while (i < lines.length) {
        const current = lines[i]!;
        const item = isOrdered ? ordered.exec(current) : bullet.exec(current);
        if (item) {
          items.push(isOrdered ? item[2]! : item[1]!);
          i += 1;
        } else if (current.trim() && /^\s{2,}\S/.test(current) && items.length) {
          items[items.length - 1] += ` ${current.trim()}`; // a wrapped continuation line
          i += 1;
        } else break;
      }
      blocks.push(isOrdered ? { kind: 'ol', items, start } : { kind: 'ul', items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s{0,3}(```|~~~|#{1,6}\s|>|[-*+]\s|\d{1,9}[.)]\s)/.test(lines[i]!)) para.push(lines[i++]!);
    if (!para.length) para.push(lines[i++]!);
    blocks.push({ kind: 'p', lines: para });
  }
  return blocks;
}

function withBreaks(lines: string[], key: string): ReactNode[] {
  return lines.flatMap((line, index) => (index === 0 ? renderInline(line, `${key}-${index}`) : [<br key={`${key}-br-${index}`} />, ...renderInline(line, `${key}-${index}`)]));
}

export default function SafeMarkdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="ai-md">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'p':
            return <p key={key}>{withBreaks(block.lines, key)}</p>;
          case 'h':
            // Sized like a heading, but deliberately NOT a page heading element (model text never creates landmarks).
            return <p key={key} className={`ai-md-heading ai-md-h${Math.min(block.level, 4)}`}><strong>{renderInline(block.text, key)}</strong></p>;
          case 'ul':
            return <ul key={key}>{block.items.map((item, j) => <li key={`${key}-${j}`}>{renderInline(item, `${key}-${j}`)}</li>)}</ul>;
          case 'ol':
            return <ol key={key} start={block.start}>{block.items.map((item, j) => <li key={`${key}-${j}`}>{renderInline(item, `${key}-${j}`)}</li>)}</ol>;
          case 'quote':
            return <blockquote key={key}>{withBreaks(block.lines, key)}</blockquote>;
          case 'code':
            // The fence's language word is shown as a plain-text label (H23); it never selects any behaviour.
            return (
              <div key={key} className="ai-md-codeblock">
                {block.lang && <span className="ai-md-code-label">{block.lang.toUpperCase()}</span>}
                <pre className="ai-md-pre"><code>{block.text}</code></pre>
              </div>
            );
          case 'hr':
            return <hr key={key} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
