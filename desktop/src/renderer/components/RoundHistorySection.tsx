import { useEffect, useState } from 'react';
import type { InterviewRound, RoundHistory } from '../../shared/types';
import { FormattedAnswer } from './FormattedAnswer';

export function RoundHistorySection({ sessionId, rounds }: { sessionId: string; rounds: InterviewRound[] }): JSX.Element {
  const [selected, setSelected] = useState(rounds[0]?.id ?? '');
  const [page, setPage] = useState(0);
  const [history, setHistory] = useState<RoundHistory | null>(null);
  const [error, setError] = useState('');
  const round = rounds.find(item => item.id === selected) ?? rounds[0];
  useEffect(() => {
    if (!round) return;
    let current = true; setHistory(null); setError('');
    void window.electronAPI.getRoundHistory(sessionId, round.id, page)
      .then(value => { if (current) setHistory(value); })
      .catch(() => { if (current) setError('Could not load this round. Reopen History to retry.'); });
    return () => { current = false; };
  }, [sessionId, round?.id, page]);
  if (!round) return <p>No rounds recorded yet.</p>;
  return <section className="round-history">
    <label>Interview rounds <select value={round.id} onChange={event => { setSelected(event.target.value); setPage(0); }}>
      {rounds.map(item => <option key={item.id} value={item.id}>Round {item.number} · {new Date(item.startedAt).toLocaleString()}</option>)}
    </select></label>
    <h2>Round {round.number}</h2>
    <p><time>{new Date(round.startedAt).toLocaleString()}</time> · {round.state}{round.endedAt && <> · Ended {new Date(round.endedAt).toLocaleString()}</>}</p>
    {round.note && <p className="round-note">{round.note}</p>}
    {round.summary && <details><summary>Recorded round summary</summary><p className="round-note">{round.summary}</p></details>}
    {error ? <p role="alert">{error}</p> : !history ? <p>Loading round…</p> : <>
      <h3>Transcript</h3>
      {history.conversation.some(turn => turn.speaker !== 'copilot') ? history.conversation.filter(turn => turn.speaker !== 'copilot').map(turn => <article className="round-history-turn" key={turn.id}>
        <strong>{turn.speaker === 'candidate' ? 'You' : 'Interviewer'}</strong> <time>{new Date(turn.createdAt).toLocaleTimeString()}</time><p>{turn.text}</p>
      </article>) : <p>No saved speech on this page. Transcript saving may have been off.</p>}
      <h3>Questions and AI suggestions</h3>
      {history.questions.length ? history.questions.map(question => <article className="round-history-turn" key={question.id}>
        <strong>{question.text}</strong><time>{new Date(question.createdAt).toLocaleTimeString()}</time>
        {question.answer ? <FormattedAnswer text={question.answer.text}/> : <p>No completed answer saved.</p>}
      </article>) : <p>No submitted questions on this page.</p>}
    </>}
    <nav aria-label="Round history pages"><button disabled={!page || !history} onClick={() => setPage(value => value - 1)}>Previous page</button>
      <span>Page {page + 1}</span><button disabled={!history?.hasMore} onClick={() => setPage(value => value + 1)}>Next page</button></nav>
  </section>;
}
