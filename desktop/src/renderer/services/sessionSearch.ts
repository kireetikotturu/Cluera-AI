import type { Session } from '../../shared/types';

const normalize = (value: string): string => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** Search list metadata only; never fetch documents, transcripts or providers. */
export function filterSessions(sessions: Session[], query: string): Session[] {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return sessions;
  return sessions.filter((session) => {
    const text = normalize(`${session.title} ${session.company} ${session.role}`);
    return terms.every((term) => text.includes(term));
  });
}
