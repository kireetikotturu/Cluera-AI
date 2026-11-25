'use client';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { inlineParts, parseAnswerBlocks, type AnswerBlock } from '../../../lib/live/answerBlocks';
import type { LiveTurn } from '../../../lib/live/types';
import { Icon } from './icons';

function Inline({ text }: { text: string }) {
  return <>{inlineParts(text).map((part, index) => part.kind === 'bold' ? <strong key={index}>{part.text}</strong>
    : part.kind === 'code' ? <code key={index}>{part.text}</code> : part.text)}</>;
}

function Block({ block }: { block: AnswerBlock }): ReactNode {
  if (block.type === 'code') return <div className="lv-code">{block.language ? <span>{block.language}</span> : null}<pre><code>{block.text}</code></pre></div>;
  if (block.type === 'heading') return <h3><Inline text={block.text} /></h3>;
  if (block.type === 'list') {
    const List = block.ordered ? 'ol' : 'ul';
    return <List>{block.items.map((item, index) => <li key={index}><Inline text={item} /></li>)}</List>;
  }
  return <p><Inline text={block.text} /></p>;
}

export function AnswerText({ text, writing = false }: { text: string; writing?: boolean }) {
  const blocks = useMemo(() => parseAnswerBlocks(text), [text]);
  return <div className="lv-a">{blocks.map((block, index) => <Block key={index} block={block} />)}{writing ? <span className="lv-caret" aria-hidden="true" /> : null}</div>;
}

const clock = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* older browsers: fall back below */ }
  try {
    const area = document.createElement('textarea');
    area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch { return false; }
}

export const TurnCard = memo(function TurnCard({ turn, onRetry, id }: { turn: LiveTurn; onRetry?: (id: string) => void; id?: string }) {
  const [copied, setCopied] = useState(false);
  const writing = turn.state === 'writing';
  return <article className="lv-turn" id={id} data-turn={turn.id}>
    <div className="lv-q">
      {turn.photo ? <img src={turn.photo} alt="Photo you sent" /> : null}
      <p>{turn.question}</p>
      <time dateTime={turn.at}>{clock(turn.at)}</time>
    </div>
    {turn.answer ? <AnswerText text={turn.answer} writing={writing} />
      : writing ? <div className="lv-a"><div className="lv-wait" role="status"><i /><i /><i />Writing the answer…</div></div> : null}
    {turn.state === 'failed' ? <p className="lv-fail" role="alert">{turn.note ?? 'The answer could not be written. Tap Retry.'}</p> : null}
    {turn.state === 'cancelled' ? <p className="lv-hint" style={{ padding: '0 14px 10px' }}>Stopped</p> : null}
    {!writing && (turn.answer || onRetry) ? <div className="lv-tools">
      {turn.answer ? <button type="button" className="lv-btn ghost small" onClick={async () => { if (await copyText(turn.answer)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}>
        <Icon name="copy" />{copied ? 'Copied' : 'Copy'}</button> : null}
      {onRetry && turn.state !== 'done' ? <button type="button" className="lv-btn ghost small" onClick={() => onRetry(turn.id)}><Icon name="retry" />Retry</button> : null}
    </div> : null}
  </article>;
});
