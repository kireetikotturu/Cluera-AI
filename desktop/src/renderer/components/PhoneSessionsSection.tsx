import { ChevronDown, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PhoneSessionDetail, PhoneSessionSummary } from '../../shared/phoneSessions';

const formatDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
};

/**
 * Sessions the customer ran on their phone, saved to their account by the website. Shown only when there are some, read
 * only, so nothing about the sessions kept on this computer changes.
 */
export function PhoneSessionsSection(): JSX.Element | null {
  const [items, setItems] = useState<PhoneSessionSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, PhoneSessionDetail | 'error' | 'loading'>>({});
  const [copied, setCopied] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void window.accountAPI?.phoneSessions.list().then(list => { if (mounted.current) setItems(list); }, () => undefined);
    return () => { mounted.current = false; };
  }, []);
  if (!items.length) return null;

  const toggle = (id: string): void => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    if (details[id] && details[id] !== 'error') return;
    setDetails(current => ({ ...current, [id]: 'loading' }));
    void window.accountAPI!.phoneSessions.read(id).then(
      detail => { if (mounted.current) setDetails(current => ({ ...current, [id]: detail })); },
      () => { if (mounted.current) setDetails(current => ({ ...current, [id]: 'error' })); },
    );
  };
  const copy = (key: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key); setTimeout(() => { if (mounted.current) setCopied(''); }, 1_500);
    }, () => undefined);
  };

  return <section className="dashboard-group phone-sessions" aria-label="Sessions from your phone">
    <h2><Smartphone size={11} aria-hidden="true"/> From your phone</h2>
    <div className="dashboard-session-list">{items.map(item => {
      const detail = details[item.id];
      const open = openId === item.id;
      return <article className="phone-session" key={item.id}>
        <button className="phone-session-head" aria-expanded={open} onClick={() => toggle(item.id)}>
          <span className="phone-session-title"><strong>{item.title}</strong><small>{formatDate(item.startedAt)} · {item.questionCount} {item.questionCount === 1 ? 'question' : 'questions'}{item.model ? ` · ${item.model}` : ''}</small></span>
          <span className="session-badge interview">{item.kind === 'assignment' ? 'Assignment' : 'Interview'}</span>
          <ChevronDown size={15} aria-hidden="true" className={open ? 'open' : ''}/>
        </button>
        {open && <div className="phone-session-body">
          {detail === 'loading' || !detail ? <p role="status">Loading…</p>
            : detail === 'error' ? <p role="alert">This session could not be opened. Check your connection and try again.</p>
            : detail.turns.length ? detail.turns.map(turn => <div className="phone-turn" key={turn.id}>
              <p className="phone-question">{turn.question}</p>
              <p className="phone-answer">{turn.answer}</p>
              <button className="ghost" onClick={() => copy(turn.id, turn.answer)}>{copied === turn.id ? 'Copied' : 'Copy answer'}</button>
            </div>) : <p>No answers were saved for this session.</p>}
        </div>}
      </article>;
    })}</div>
  </section>;
}
