'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LiveTurn, TurnSource } from '../../../lib/live/types';
import { Icon, type IconName } from './icons';
import { AnswerText } from './TurnCard';

/** A control with its name written under the icon, so nothing on the live screen has to be guessed. */
export function Action({ icon, label, onClick, pressed, danger, disabled, title }: {
  icon: IconName | null; label: string; onClick(): void; pressed?: boolean; danger?: boolean; disabled?: boolean; title?: string;
}) {
  return <button type="button" className={`lv-act${danger ? ' danger' : ''}`} aria-pressed={pressed} disabled={disabled} onClick={onClick} title={title ?? label}>
    {icon ? <Icon name={icon} /> : null}<span>{label}</span>
  </button>;
}

const SOURCE: Record<TurnSource, string> = { voice: 'Heard', typed: 'Typed', photo: 'Photo' };
const clock = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

/** The question being answered: a short header, never a wall of text. A long question opens on a tap. */
export function QuestionHeader({ turn, number, total }: { turn: LiveTurn; number: number; total: number }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [turn.id]);
  const long = turn.question.length > 120;
  return <div className="lv-qhead">
    <div className="lv-qmeta">
      <span className="lv-qnum">Question {number}<i> of {total}</i></span>
      <span className="lv-qtag">{SOURCE[turn.source]}</span>
      <time dateTime={turn.at}>{clock(turn.at)}</time>
    </div>
    <div className="lv-qbody">
      {turn.photo ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={turn.photo} alt="The photo you sent" /> : null}
      <p className={open ? 'open' : ''}>{turn.question}</p>
    </div>
    {long ? <button type="button" className="lv-more" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Show less' : 'Show the whole question'}</button> : null}
  </div>;
}

/** The answer, from its first line, in a panel of its own that scrolls inside the screen. */
export function AnswerPane({ turn, onRetry, onCopy, copied, follow, scroller, children }: {
  turn: LiveTurn; onRetry(id: string): void; onCopy(text: string): void; copied: boolean; follow: boolean;
  scroller: React.RefObject<HTMLDivElement | null>; children?: ReactNode;
}) {
  const writing = turn.state === 'writing';
  const length = turn.answer.length;
  const startedFor = useRef('');
  // Every answer opens at its first line; while it is being written it may follow the newest line if Auto Scroll is on.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (startedFor.current !== turn.id) { startedFor.current = turn.id; element.scrollTop = 0; return; }
    if (follow && writing) element.scrollTop = element.scrollHeight;
  }, [turn.id, length, follow, writing, scroller]);
  return <article className="lv-pane" key={turn.id}>
    {turn.answer ? <AnswerText text={turn.answer} writing={writing} />
      : writing ? <div className="lv-a"><div className="lv-wait" role="status"><i /><i /><i />Writing the answer…</div></div> : null}
    {turn.state === 'failed' ? <p className="lv-fail" role="alert">{turn.note ?? 'The answer could not be written. Tap Retry.'}</p> : null}
    {turn.state === 'cancelled' ? <p className="lv-hint lv-stopped">Stopped</p> : null}
    {!writing ? <div className="lv-tools">
      {turn.answer ? <button type="button" className="lv-btn ghost small" onClick={() => onCopy(turn.answer)}><Icon name="copy" />{copied ? 'Copied' : 'Copy answer'}</button> : null}
      {turn.state !== 'done' ? <button type="button" className="lv-btn ghost small" onClick={() => onRetry(turn.id)}><Icon name="retry" />Try again</button> : null}
    </div> : null}
    {children}
  </article>;
}
