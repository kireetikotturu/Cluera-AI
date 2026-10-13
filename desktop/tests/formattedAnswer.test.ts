import { describe, expect, it } from 'vitest';
import { FormattedAnswer, parseAnswerBlocks, StreamingAnswerParser } from '../src/renderer/components/FormattedAnswer';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

describe('parseAnswerBlocks', () => {
  it('keeps completed blocks stable and partial streaming output equivalent to reload', () => {
    const parser = new StreamingAnswerParser();
    const first = parser.parse('Opening **answer**.\n\n');
    const source = 'Opening **answer**.\n\n- React\n- APIs\n\n```ts\nconst a = 1;\n```not-a-closing-fence\n\nconst b = 2;\n```\n\nFinal **result**.';
    for (let length = 21; length <= source.length; length++) expect(parser.parse(source.slice(0, length))).toEqual(parseAnswerBlocks(source.slice(0, length)));
    expect(parser.parse(source)[0]).toBe(first[0]);
    expect(parser.parse('Replacement answer')).toEqual(parseAnswerBlocks('Replacement answer'));
  });
  it('escapes HTML, limits gold emphasis to three short phrases and retains contiguous word anchors', () => {
    const long = '**' + 'word '.repeat(15).trim() + '**';
    const html = renderToStaticMarkup(createElement(FormattedAnswer, { text: `<script>alert(1)</script>\n\n**React** **42%** **Decision** **Fourth** ${long}\n\n\`\`\`ts\nconst x = '<img onerror=bad>';\n\`\`\`` }));
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img ');
    expect(html).toContain('&lt;');
    expect(html.match(/class="answer-key-phrase"/g)).toHaveLength(3);
    const indices = [...html.matchAll(/data-answer-word-index="(\d+)"/g)].map(m => Number(m[1]));
    expect(indices).toEqual(indices.map((_, index) => index));
  });
  it('separates headings, lists, paragraphs, and fenced code', () => {
    const blocks = parseAnswerBlocks(`## Approach

Use a **hash map** for direct lookup.

- One pass
- O(n) time

\`\`\`python
seen = {}
\`\`\``);

    expect(blocks).toEqual([
      { type: 'heading', level: 2, text: 'Approach' },
      { type: 'paragraph', text: 'Use a **hash map** for direct lookup.' },
      { type: 'list', ordered: false, items: ['One pass', 'O(n) time'] },
      { type: 'code', language: 'python', text: 'seen = {}' },
    ]);
  });

  it('keeps an unfinished streaming code fence readable', () => {
    expect(parseAnswerBlocks('```ts\nconst answer = true;')).toEqual([
      { type: 'code', language: 'ts', text: 'const answer = true;' },
    ]);
  });
});
