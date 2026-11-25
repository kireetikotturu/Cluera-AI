export type AnswerBlock =
  | { type: 'code'; language: string; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; text: string };

const BULLET = /^\s*(-|\*|\d+[.)])\s+(.+)$/;

/** The answer's light Markdown (paragraphs, bullets, short headings, code fences) as blocks the screen can draw. */
export function parseAnswerBlocks(source: string): AnswerBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: AnswerBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) { code.push(lines[index]); index += 1; }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language: fence[1], text: code.join('\n') });
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); index += 1; continue; }
    const bullet = line.match(BULLET);
    if (bullet) {
      const ordered = /^\d/.test(bullet[1]);
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(BULLET);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        items.push(item[2]);
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^```/.test(lines[index]) && !/^#{1,3}\s+/.test(lines[index]) && !BULLET.test(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
  }
  return blocks;
}

export type InlinePart = { kind: 'text' | 'bold' | 'code'; text: string };

/** Splits one line into plain text, **bold** and `code`. */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) parts.push({ kind: 'text', text: text.slice(cursor, match.index) });
    parts.push(match[2] ? { kind: 'bold', text: match[2] } : { kind: 'code', text: match[3] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) });
  return parts;
}
