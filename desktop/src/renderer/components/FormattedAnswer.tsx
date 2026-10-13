import { Fragment, memo, type ReactNode, useRef } from 'react';

type Block =
  | { type: 'code'; language: string; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; text: string };

export function parseAnswerBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language: fence[1], text: code.join('\n') });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    const bullet = line.match(/^\s*(-|\*|\d+[.)])\s+(.+)$/);
    if (bullet) {
      const ordered = /^\d/.test(bullet[1]);
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(-|\*|\d+[.)])\s+(.+)$/);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        items.push(item[2]);
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim()
      && !/^```/.test(lines[index])
      && !/^#{1,3}\s+/.test(lines[index])
      && !/^\s*(-|\*|\d+[.)])\s+/.test(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks;
}

interface WordCursor { value: number; highlights: number }
const shortEmphasis = (text: string): boolean => text.length <= 80 && text.split(/\s+/).length <= 10;
const blockStats = new WeakMap<Block, { words: number; highlights: number }>();
function stats(block: Block): { words: number; highlights: number } {
  const cached = blockStats.get(block); if (cached) return cached;
  const plain = block.type === 'list' ? block.items.join(' ') : block.type === 'code' ? `${block.language} ${block.text}` : block.text;
  const value = { words: (plain.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length,
    highlights: block.type === 'code' ? 0 : [...plain.matchAll(/\*\*([^*]+)\*\*/g)].filter(match => shortEmphasis(match[1])).length };
  blockStats.set(block, value); return value;
}

/** Completed paragraphs/fences are parsed once during an append-only stream. */
export class StreamingAnswerParser {
  private previous = '';
  private offset = 0;
  private complete: Block[] = [];
  parse(text: string): Block[] {
    if (!text.startsWith(this.previous)) { this.offset = 0; this.complete = []; }
    this.previous = text;
    const tail = text.slice(this.offset);
    let fenced = false, cut = 0, position = 0;
    for (const line of tail.split('\n')) {
      position += line.length + 1;
      if (fenced ? /^```\s*$/.test(line) : /^```\s*[\w+#.-]*\s*$/.test(line)) fenced = !fenced;
      if (!fenced && !line.trim() && position <= tail.length) cut = position;
    }
    if (cut) { this.complete.push(...parseAnswerBlocks(tail.slice(0, cut))); this.offset += cut; }
    return [...this.complete, ...parseAnswerBlocks(text.slice(this.offset))];
  }
}

function answerWords(text: string, cursor: WordCursor, keyPrefix: string): ReactNode[] {
  return text.split(/([\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*)/gu).filter(Boolean).map((part, index) => {
    if (!/[\p{L}\p{N}]/u.test(part)) return part;
    const wordIndex = cursor.value;
    cursor.value += 1;
    return <span data-answer-word-index={wordIndex} key={`${keyPrefix}-${index}-${wordIndex}`}>{part}</span>;
  });
}

function inlineMarkup(text: string, wordCursor: WordCursor, keyPrefix: string): ReactNode[] {
  const result: ReactNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let textCursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > textCursor) result.push(...answerWords(text.slice(textCursor, match.index), wordCursor, `${keyPrefix}-${match.index}-plain`));
    // Long model emphasis remains readable but is not painted as a gold wall.
    if (match[2]) {
      const highlight = shortEmphasis(match[2]) && wordCursor.highlights > 0;
      if (highlight) wordCursor.highlights -= 1;
      result.push(<strong className={highlight ? 'answer-key-phrase' : undefined} key={`${keyPrefix}-${match.index}-strong`}>{answerWords(match[2], wordCursor, `${keyPrefix}-${match.index}-strong-word`)}</strong>);
    }
    else result.push(<code key={`${keyPrefix}-${match.index}-code`}>{answerWords(match[3], wordCursor, `${keyPrefix}-${match.index}-code-word`)}</code>);
    textCursor = match.index + match[0].length;
  }
  if (textCursor < text.length) result.push(...answerWords(text.slice(textCursor), wordCursor, `${keyPrefix}-tail`));
  return result;
}

export const FormattedAnswer = memo(function FormattedAnswer({ text, streaming = false }: { text: string; streaming?: boolean }): JSX.Element {
  const parser = useRef(new StreamingAnswerParser());
  const blocks = parser.current.parse(text);
  let wordStart = 0;
  let remainingHighlights = 3;
  return <div className="answer-rich">
    {blocks.map((block, index) => {
      const start = wordStart;
      const highlights = remainingHighlights;
      const size = stats(block);
      wordStart += size.words;
      remainingHighlights = Math.max(0, remainingHighlights - size.highlights);
      return <AnswerBlock key={index} block={block} index={index} start={start} highlights={highlights}/>;
    })}
    {streaming && <Fragment><span className="cursor" aria-hidden="true" /></Fragment>}
  </div>;
});

const AnswerBlock = memo(function AnswerBlock({ block, index, start, highlights }: { block: Block; index: number; start: number; highlights: number }): JSX.Element {
      const wordCursor: WordCursor = { value: start, highlights };
      if (block.type === 'code') return <div className="answer-code" key={index}>
        {block.language && <span>{answerWords(block.language, wordCursor, `${index}-language`)}</span>}
        <pre><code>{answerWords(block.text, wordCursor, `${index}-code`)}</code></pre>
      </div>;
      if (block.type === 'heading') return <h3 className={`answer-heading level-${block.level}`} key={index}>{inlineMarkup(block.text, wordCursor, `${index}-heading`)}</h3>;
      if (block.type === 'list') {
        const List = block.ordered ? 'ol' : 'ul';
        return <List key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkup(item, wordCursor, `${index}-${itemIndex}-item`)}</li>)}</List>;
      }
      return <p key={index}>{inlineMarkup(block.text, wordCursor, `${index}-paragraph`)}</p>;
});
