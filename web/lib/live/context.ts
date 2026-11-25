import type {
  AnswerContext, ContextChunk, ConversationTurn, DocumentType, QuestionIntent, Session,
} from '../../../desktop/src/shared/types';
import type { LiveSetup, LiveTurn } from './types';

// The same lexical search the Windows app uses for a session's documents, kept in the browser: no network, no embeddings.
const STOP_WORDS = new Set(['the','a','an','and','or','to','of','in','on','for','with','is','are','was','were','be','been','i','my','we','our','you','your','it','that','this','as','at','by','from']);
const QUESTION_FILLER = new Set(['about','tell','me','what','which','who','whom','how','why','when','where','do','does','did','have','has','had','can','could','would','will','please','describe','explain','walk','through','give','share','yourself','myself','am','there','any','some','also','than','then','they','their','not','but','if','so','such','into','over','out','up','all','tell','talk','know','like']);
type Vector = Record<string, number>;

export const CHUNK_SIZE = 850;
export const CHUNK_OVERLAP = 120;
export const TOP_K = 5;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{1,}/g) ?? []).filter(word => !STOP_WORDS.has(word));
}
function normalize(vector: Vector): Vector {
  const length = Math.sqrt(Object.values(vector).reduce((sum, value) => sum + value * value, 0)) || 1;
  for (const token of Object.keys(vector)) vector[token] /= length;
  return vector;
}
export function vectorize(text: string): Vector {
  const vector: Vector = {};
  for (const token of tokenize(text)) vector[token] = (vector[token] ?? 0) + 1;
  return normalize(vector);
}
function wordForms(word: string): string[] {
  const forms = new Set([word]);
  if (word.length > 3 && word.endsWith('ies')) forms.add(`${word.slice(0, -3)}y`);
  if (word.length > 3 && word.endsWith('es')) forms.add(word.slice(0, -2));
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) forms.add(word.slice(0, -1));
  else if (word.length > 2 && !word.endsWith('s')) forms.add(`${word}s`);
  return [...forms];
}
/** A question as search terms: filler dropped, singular and plural wording both searched. */
export function queryVector(text: string): Vector {
  const words = tokenize(text).filter(word => !QUESTION_FILLER.has(word));
  const vector: Vector = {};
  for (const word of words) vector[word] = (vector[word] ?? 0) + 1;
  for (const word of words) for (const form of wordForms(word)) if (!(form in vector)) vector[form] = 0.5;
  return normalize(vector);
}
export function cosine(a: Vector, b: Vector): number {
  let score = 0;
  const [small, large] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a];
  for (const [key, value] of Object.entries(small)) score += value * (large[key] ?? 0);
  return score;
}

export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const paragraphs = text.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
  const output: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if ((current + paragraph).length <= size) { current += `${current ? '\n\n' : ''}${paragraph}`; continue; }
    if (current) output.push(current);
    if (paragraph.length <= size) { current = paragraph; continue; }
    for (let start = 0; start < paragraph.length; start += size - overlap) output.push(paragraph.slice(start, start + size));
    current = '';
  }
  if (current) output.push(current);
  return output;
}

interface IndexedChunk extends ContextChunk { vector: Vector }

/** The session's documents, cut into pieces and indexed once when the session starts. */
export class DocumentIndex {
  private readonly chunks: IndexedChunk[] = [];
  constructor(sessionId: string, documents: Array<{ type: DocumentType; name: string; text: string }>) {
    for (const document of documents) {
      chunkText(document.text).forEach((text, index) => this.chunks.push({
        id: `${document.type}-${document.name}-${index}`, sessionId, documentId: `${document.type}-${document.name}`,
        documentType: document.type, section: text.split('\n')[0]?.trim().slice(0, 80) || 'General', page: null,
        chunkIndex: index, text, vector: vectorize(text),
      }));
    }
  }
  search(query: string, topK = TOP_K): {
    matched(type: DocumentType): ContextChunk[];
    leading(type: DocumentType, count: number): ContextChunk[];
  } {
    const vector = queryVector(query);
    const strip = ({ vector: _vector, ...chunk }: IndexedChunk, score: number): ContextChunk => ({ ...chunk, score });
    const scored = this.chunks.map(chunk => ({ chunk, score: cosine(vector, chunk.vector) }))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    return {
      matched: type => scored.filter(item => item.chunk.documentType === type).slice(0, topK).map(item => strip(item.chunk, item.score)),
      leading: (type, count) => this.chunks.filter(chunk => chunk.documentType === type).slice(0, count).map(chunk => strip(chunk, 0)),
    };
  }
}

/** Questions about the candidate themself need the whole résumé, not a few matching lines. */
const PERSONAL_QUESTION = /\b(?:introduce|yourself|myself|about you|about me|who are you|your name|my name|your (?:background|experiences?|projects?|skills?|strengths?|weakness(?:es)?|education|college|degree|achievements?|career|journey|role|responsibilit\w+|favou?rite\w*|best|strongest|certifications?|internships?|work|company|companies|resume|cv|profile|tech stack|technologies)|projects? (?:you|have you|did you|you've)|what (?:have|did) you (?:do|done|built|build|work|worked)|walk (?:me )?through your)\b/i;

export function sessionFromSetup(setup: LiveSetup, now = new Date()): Session {
  const stamp = now.toISOString();
  return {
    id: setup.id, title: setup.title, role: setup.role, company: setup.company, interviewType: setup.interviewType,
    language: setup.language, answerStyle: setup.answerStyle, answerLength: setup.answerLength,
    jobDescription: setup.jobDescription, resumeText: setup.resumeText, instructions: setup.instructions,
    selectedModel: setup.modelId, autoAnswer: setup.autoAnswer, saveTranscript: setup.saveHistory,
    answerPreferences: setup.answerPreferences, kind: setup.kind, createdAt: stamp, updatedAt: stamp,
  };
}

export function indexSetup(setup: LiveSetup): DocumentIndex {
  return new DocumentIndex(setup.id, [
    ...(setup.resumeText.trim() ? [{ type: 'resume' as const, name: 'Resume', text: setup.resumeText }] : []),
    ...(setup.jobDescription.trim() ? [{ type: 'job-description' as const, name: 'Job description', text: setup.jobDescription }] : []),
    ...setup.supporting.filter(item => item.text.trim()).map(item => ({ type: 'supporting' as const, name: item.name, text: item.text })),
  ]);
}

/** The earlier questions and answers of this session, in the shape the prompt expects (most recent last). */
export function conversationFrom(sessionId: string, turns: readonly LiveTurn[], limit = 30): ConversationTurn[] {
  const list: ConversationTurn[] = [];
  for (const turn of turns) {
    list.push({ id: `${turn.id}-q`, sessionId, speaker: 'interviewer', text: turn.question.slice(0, 1_000), createdAt: turn.at, questionId: turn.id });
    if (turn.state === 'done' && turn.answer.trim()) {
      list.push({ id: `${turn.id}-a`, sessionId, speaker: 'copilot', text: turn.answer.slice(0, 500), createdAt: turn.at, questionId: turn.id });
    }
  }
  return list.slice(-limit);
}

/** The same choices as the Windows app's context builder: what from the résumé, job description and notes goes into one answer. */
export function buildAnswerContext(setup: LiveSetup, index: DocumentIndex, intent: QuestionIntent, previous: readonly LiveTurn[]): AnswerContext {
  const session = sessionFromSetup(setup);
  const search = index.search(intent.question, TOP_K);
  const chunks = [...search.matched('resume'), ...search.matched('job-description'), ...search.matched('supporting'), ...search.matched('round-context')];
  const byType = (type: DocumentType): ContextChunk[] => chunks.filter(chunk => chunk.documentType === type);
  const fallback = (type: DocumentType, text: string, section: string, limit: number): ContextChunk[] => text.trim() ? [{
    id: `session-${type}`, sessionId: session.id, documentId: `session-${type}`, documentType: type, section, page: null,
    chunkIndex: 0, text: text.trim().slice(0, limit), score: 0,
  }] : [];
  const broad = ['BEHAVIORAL_QUESTION', 'EXPERIENCE_QUESTION'].includes(intent.intent) || PERSONAL_QUESTION.test(intent.question);
  const profile = search.leading('resume', 1);
  const matchedResume = byType('resume');
  const withProfile = (list: ContextChunk[]): ContextChunk[] =>
    profile.length && !list.some(chunk => chunk.id === profile[0].id) ? [...profile, ...list.slice(0, TOP_K - 1)] : list;
  let resumeContext: ContextChunk[];
  if (broad && session.resumeText.trim()) {
    const whole = fallback('resume', session.resumeText, 'Resume', 8_000);
    resumeContext = [...whole, ...matchedResume.filter(chunk => !whole[0].text.includes(chunk.text.slice(0, 120))).slice(0, 2)];
  } else resumeContext = matchedResume.length ? withProfile(matchedResume) : profile;
  const matchedJob = byType('job-description');
  const jobContext = matchedJob.length ? matchedJob : broad ? fallback('job-description', session.jobDescription, 'Job description fallback', 6_000) : [];
  const matchedSupporting = [...byType('supporting'), ...byType('round-context')];
  const documentContext = matchedSupporting.length || !broad ? matchedSupporting : search.leading('supporting', 3);
  return {
    question: intent.question, intent: intent.intent, recentConversation: conversationFrom(session.id, previous),
    resumeContext, jobContext, documentContext, instructions: session.instructions.trim(), session,
  };
}
