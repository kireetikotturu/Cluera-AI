import { ArrowLeft, MessageSquareText, Shrink, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ConversationTurn, SessionDetail } from '../../shared/types';
import { useAppStore } from '../stores/appStore';
import { RoundHistorySection } from '../components/RoundHistorySection';

const sessionDuration = (detail: SessionDetail): string => {
  const times = detail.conversation
    .map((turn) => new Date(turn.createdAt).getTime())
    .filter(Number.isFinite);
  if (!times.length && !detail.rounds?.length) return 'No recorded duration';
  const duration = detail.rounds?.length ? detail.rounds.reduce((total, round) => total + Math.max(0,
    new Date(round.endedAt ?? round.startedAt).getTime() - new Date(round.startedAt).getTime()), 0)
    : Math.max(...times) - Math.min(...times);
  const minutes = Math.max(1, Math.ceil(duration / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
};

const initials = (company: string, role: string): string => (company || role)
  .split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'M';

interface TranscriptExchange {
  interviewer: ConversationTurn;
  candidate: ConversationTurn[];
}

export const buildTranscriptExchanges = (turns: ConversationTurn[]): TranscriptExchange[] => {
  const exchanges: TranscriptExchange[] = [];
  for (const turn of turns) {
    if (turn.speaker === 'interviewer') {
      exchanges.push({ interviewer: turn, candidate: [] });
      continue;
    }
    if (turn.speaker !== 'candidate') continue;
    const associated = turn.questionId
      ? [...exchanges].reverse().find((exchange) => exchange.interviewer.questionId === turn.questionId)
      : undefined;
    (associated ?? exchanges.at(-1))?.candidate.push(turn);
  }
  return exchanges;
};

interface HistoryPageProps { onCollapse(): void }

export function HistoryPage({ onCollapse }: HistoryPageProps): JSX.Element {
  const sessions = useAppStore((state) => state.sessions);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const setPage = useAppStore((state) => state.setPage);
  const selectedId = activeSessionId ?? sessions[0]?.id ?? '';
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(selectedId));

  useEffect(() => {
    if (!selectedId) { setDetail(null); setLoading(false); return; }
    let disposed = false;
    setLoading(true);
    void window.electronAPI.getSession(selectedId)
      .then((nextDetail) => { if (!disposed) setDetail(nextDetail); })
      .catch(() => { if (!disposed) setDetail(null); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [selectedId]);

  const exchanges = useMemo(
    () => buildTranscriptExchanges(detail?.conversation ?? []),
    [detail],
  );

  return <main className="transcript-page">
    <header className="transcript-window-header">
      <div className="transcript-header-left">
        <button className="transcript-back" onClick={() => setPage('home')}><ArrowLeft size={15}/>Back</button>
        <div className="transcript-brand"><span>S</span><div><strong>Cluera AI</strong><small>Session transcript</small></div></div>
      </div>
      <div className="transcript-header-actions">
        <button aria-label="Collapse Cluera AI" title="Collapse to floating logo" onClick={onCollapse}><Shrink size={16}/></button>
        <button className="close" aria-label="Close Cluera AI" title="Close Cluera AI" onClick={() => void window.electronAPI.closeWindow()}><X size={17}/></button>
      </div>
    </header>

    <div className="transcript-page-scroll">
      {loading ? <div className="transcript-loading">Loading transcript...</div> : !detail ? <div className="transcript-empty">
        <MessageSquareText size={24}/><h1>No transcript available</h1><p>This session does not have saved transcript data.</p>
      </div> : <>
        <section className="transcript-session-summary">
          <div className="transcript-company-mark" aria-hidden="true">{initials(detail.session.company, detail.session.role)}</div>
          <div className="transcript-session-title">
            <p>SESSION TRANSCRIPT</p>
            <h1>{detail.session.role}</h1>
            <span>{detail.session.company || 'Company not specified'} · {detail.session.title}</span>
          </div>
          <div className="transcript-session-meta">
            <span>{new Date(detail.session.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            <strong>{sessionDuration(detail)}</strong>
          </div>
        </section>

        <details className="session-setup">
          <summary>Session setup <span>Details, documents & preferences</span></summary>
          <dl className="session-setup-meta">
            <div><dt>Session name</dt><dd>{detail.session.title}</dd></div>
            <div><dt>Company</dt><dd>{detail.session.company || 'Not specified'}</dd></div>
            <div><dt>Job role</dt><dd>{detail.session.role}</dd></div>
            <div><dt>Session type</dt><dd>Interview</dd></div>
            <div><dt>AI model</dt><dd>{detail.session.selectedModel}</dd></div>
            <div><dt>Language</dt><dd>{detail.session.language}</dd></div>
            <div><dt>Answer preferences</dt><dd>{detail.session.answerStyle}</dd></div>
            <div><dt>Auto Answer</dt><dd>{detail.session.autoAnswer ? 'On' : 'Off'}</dd></div>
            <div><dt>Save Transcript</dt><dd>{detail.session.saveTranscript === false ? 'Off' : 'On'}</dd></div>
            {detail.session.interviewUrl && <div className="wide"><dt>Interview post URL</dt><dd>{detail.session.interviewUrl}</dd></div>}
          </dl>
          <SetupText label={detail.session.resumeFileName ? `Resume / CV — ${detail.session.resumeFileName}` : 'Resume / CV'} text={detail.session.resumeText}/>
          <SetupText label="Interview description / JD" text={detail.session.jobDescription}/>
          {detail.documents.filter((document) => document.type === 'supporting').map((document) => <SetupText key={document.id} label={document.name === 'Session supporting context' ? 'Supporting context' : document.name} text={document.text}/>)}
          <SetupText label="Instructions" text={detail.session.instructions}/>
        </details>

        {detail.rounds?.length ? <RoundHistorySection key={detail.session.id} sessionId={detail.session.id} rounds={detail.rounds}/> : <section className="transcript-section" aria-label="Interviewer questions and candidate answers">
          <div className="transcript-section-heading"><div><p>TRANSCRIPT</p><h2>Questions and answers</h2></div><span>{exchanges.length} {exchanges.length === 1 ? 'question' : 'questions'}</span></div>
          {exchanges.length ? <div className="transcript-exchanges">{exchanges.map((exchange, index) => {
            const candidateAnswer = exchange.candidate.map((turn) => turn.text.trim()).filter(Boolean).join(' ');
            const candidateTime = exchange.candidate.at(0)?.createdAt;
            return <article className="transcript-exchange" key={exchange.interviewer.id}>
              <div className="exchange-index">{String(index + 1).padStart(2, '0')}</div>
              <div className="exchange-content">
                <div className="exchange-line interviewer">
                  <div className="exchange-speaker"><strong>Interviewer</strong><time>{new Date(exchange.interviewer.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
                  <p>{exchange.interviewer.text}</p>
                </div>
                <div className="exchange-line candidate">
                  <div className="exchange-speaker"><strong>You</strong>{candidateTime && <time>{new Date(candidateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}</div>
                  <p className={candidateAnswer ? '' : 'not-answered'}>{candidateAnswer || 'Not answered'}</p>
                </div>
              </div>
            </article>;
          })}</div> : <div className="transcript-empty-inline">No interviewer questions were saved for this session.</div>}
        </section>}
      </>}
    </div>
  </main>;
}

function SetupText({ label, text }: { label: string; text: string }): JSX.Element {
  return <details className="session-setup-text"><summary>{label}</summary><p>{text || 'Not provided'}</p></details>;
}
