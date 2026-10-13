import { randomUUID } from 'node:crypto';
import type { Database as SqlDatabase } from 'sql.js';
import type {
  AnswerRecord, AppSettings, AudioSourceDescriptor, ContextChunk, ConversationTurn, DocumentRecord, DocumentType,
  LibraryFileCategory, QuestionIntent, QuestionRecord, Session, SessionDetail, SessionInput, SessionSummary,
  ScreenContext, InterviewRound, RoundHistory,
} from '../../shared/types';
import { Database } from './Database';

interface SessionRow extends Record<string, string> {
  interview_type: Session['interviewType']; answer_style: string; answer_length: Session['answerLength'];
  job_description: string; resume_text: string; selected_model: string; created_at: string; updated_at: string;
}
interface DocumentRow extends Record<string, string | number> { session_id: string; mime_type: string; size_bytes: number; created_at: string; }
interface TurnRow extends Record<string, string | number | null> { session_id: string; created_at: string; }
interface QuestionRow extends Record<string, string | number> { session_id: string; confidence: number; created_at: string; }
interface AnswerRow extends Record<string, string | number> { session_id: string; question_id: string; latency_ms: number; created_at: string; }
interface ChunkRow extends Record<string, string | number | null> { session_id: string; document_id: string; document_type: string; chunk_index: number; page: number | null; }
interface LibraryFileRow extends Record<string, string | number> {
  category: LibraryFileCategory; mime_type: string; size_bytes: number; content_hash: string; storage_name: string; created_at: string;
}

export interface StoredLibraryFile {
  id: string;
  category: LibraryFileCategory;
  name: string;
  mimeType: string;
  text: string;
  sizeBytes: number;
  contentHash: string;
  storageName: string;
  createdAt: string;
}

const mapSession = (r: SessionRow): Session => ({
  id: r.id, title: r.title, role: r.role, company: r.company,
  interviewType: r.interview_type, language: r.language, answerStyle: r.answer_style,
  answerLength: r.answer_length, jobDescription: r.job_description, resumeText: r.resume_text,
  instructions: r.instructions, selectedModel: r.selected_model, createdAt: r.created_at, updatedAt: r.updated_at,
  autoAnswer: Number(r.auto_answer) === 1, saveTranscript: Number(r.save_transcript) !== 0,
  interviewUrl: r.interview_url ?? '', resumeFileName: r.resume_file_name ?? '',
});
const mapDocument = (r: DocumentRow): DocumentRecord => ({
  id: String(r.id), sessionId: String(r.session_id), name: String(r.name), type: String(r.type) as DocumentType,
  mimeType: String(r.mime_type), text: String(r.text), sizeBytes: Number(r.size_bytes), createdAt: String(r.created_at),
});
const mapTurn = (r: TurnRow): ConversationTurn => ({
  roundId: r.round_id ? String(r.round_id) : undefined,
  id: String(r.id), sessionId: r.session_id, speaker: String(r.speaker) as ConversationTurn['speaker'],
  text: String(r.text), createdAt: r.created_at,
  questionId: r.question_id ? String(r.question_id) : undefined,
  sourceId: r.source_id ? String(r.source_id) : undefined,
  sourceKind: r.source_kind ? String(r.source_kind) as ConversationTurn['sourceKind'] : undefined,
  sourceRole: r.source_role ? String(r.source_role) as ConversationTurn['sourceRole'] : undefined,
  canTriggerAnswers: r.can_trigger_answers === null || r.can_trigger_answers === undefined ? undefined : Boolean(r.can_trigger_answers),
});
const mapQuestion = (r: QuestionRow): QuestionRecord => ({ id: String(r.id), sessionId: String(r.session_id), roundId: r.round_id ? String(r.round_id) : undefined, text: String(r.text), intent: String(r.intent) as QuestionRecord['intent'], confidence: Number(r.confidence), createdAt: String(r.created_at) });
const mapAnswer = (r: AnswerRow): AnswerRecord => ({ id: String(r.id), sessionId: String(r.session_id), questionId: String(r.question_id), text: String(r.text), model: String(r.model), latencyMs: Number(r.latency_ms), createdAt: String(r.created_at) });
const mapLibraryFile = (r: LibraryFileRow): StoredLibraryFile => ({
  id: String(r.id), category: r.category, name: String(r.name), mimeType: String(r.mime_type), text: String(r.text),
  sizeBytes: Number(r.size_bytes), contentHash: String(r.content_hash), storageName: String(r.storage_name), createdAt: String(r.created_at),
});
const normalizeQuestionText = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export class Repositories {
  // Unrecorded speech is bounded, session-local context, never History data.
  private readonly transientTurns = new Map<string, ConversationTurn[]>();
  constructor(private readonly database: Database) {}

  listRounds(sessionId: string): InterviewRound[] {
    return this.database.all<InterviewRound>(`SELECT id,session_id AS sessionId,number,note,started_at AS startedAt,
      ended_at AS endedAt,state,summary FROM interview_rounds WHERE session_id=$id ORDER BY number DESC`, { $id: sessionId });
  }

  currentRound(sessionId: string): InterviewRound | null {
    return this.database.get<InterviewRound>(`SELECT id,session_id AS sessionId,number,note,started_at AS startedAt,
      ended_at AS endedAt,state,summary FROM interview_rounds WHERE session_id=$id AND state='open'`, { $id: sessionId });
  }

  beginRound(sessionId: string, note = ''): InterviewRound {
    if (!this.getSession(sessionId)) throw new Error('Session not found.');
    if (this.currentRound(sessionId)) throw new Error('End the current round before starting another.');
    if (note.length > 2000) throw new Error('Round note must be 2,000 characters or fewer.');
    const nextNumber = this.database.get<{ number: number }>('SELECT COALESCE(MAX(number),0)+1 AS number FROM interview_rounds WHERE session_id=$id', { $id: sessionId })!.number;
    const round: InterviewRound = { id: randomUUID(), sessionId, number: nextNumber,
      note: note.trim(), startedAt: new Date().toISOString(), endedAt: null, state: 'open', summary: '' };
    this.database.transaction(db => {
      db.run(`INSERT INTO interview_rounds(id,session_id,number,note,started_at,state)
        VALUES($id,$sessionId,$number,$note,$startedAt,'open')`, { $id: round.id, $sessionId: sessionId, $number: round.number, $note: round.note, $startedAt: round.startedAt });
      db.run('UPDATE sessions SET updated_at=$now WHERE id=$id', { $now: round.startedAt, $id: sessionId });
    });
    this.clearTransientTurns(sessionId);
    return round;
  }

  ensureRound(sessionId: string): InterviewRound { return this.currentRound(sessionId) ?? this.beginRound(sessionId); }

  finishRound(sessionId: string, summary: string): void {
    this.database.mutate(`UPDATE interview_rounds SET state='completed',ended_at=$now,summary=$summary
      WHERE session_id=$id AND state='open'`, { $id: sessionId, $now: new Date().toISOString(), $summary: summary.slice(0, 3000) });
    this.clearTransientTurns(sessionId);
  }

  unindexedRounds(sessionId: string): InterviewRound[] {
    return this.database.all<InterviewRound>(`SELECT id,session_id AS sessionId,number,note,started_at AS startedAt,
      ended_at AS endedAt,state,summary FROM interview_rounds WHERE session_id=$id AND context_document_id IS NULL ORDER BY number`, { $id: sessionId });
  }

  markRoundIndexed(id: string, documentId: string, summary: string): void {
    this.database.mutate('UPDATE interview_rounds SET context_document_id=$doc,summary=$summary WHERE id=$id', { $id: id, $doc: documentId, $summary: summary });
  }

  roundDocument(sessionId: string, roundId: string, name: string, text: string): DocumentRecord {
    const id = `round-context-${roundId}`;
    const existing = this.database.get<DocumentRow>('SELECT * FROM documents WHERE id=$id AND session_id=$session', { $id: id, $session: sessionId });
    if (existing) return mapDocument(existing);
    return this.addDocument(sessionId, name, 'round-context', 'text/plain', text, Buffer.byteLength(text), id);
  }

  roundEvidence(sessionId: string, roundId: string): string {
    // Bounded extractive evidence. Save Transcript OFF speech is never indexed.
    const rows = this.database.all<{ label: string; text: string }>(`SELECT label,substr(text,1,2000) AS text FROM (
      SELECT speaker AS label,text,created_at FROM conversation_turns WHERE session_id=$session AND round_id=$round AND speaker!='copilot'
      UNION ALL SELECT 'submitted question',text,created_at FROM questions WHERE session_id=$session AND round_id=$round
      UNION ALL SELECT 'AI suggestion (not a candidate claim)',a.text,a.created_at FROM answers a JOIN questions q ON q.id=a.question_id
        WHERE q.session_id=$session AND q.round_id=$round
      ) ORDER BY created_at DESC LIMIT 250`, { $session: sessionId, $round: roundId });
    return rows.reverse().map(row => `${row.label === 'copilot' ? 'AI suggestion (not a candidate claim)' : row.label}: ${row.text}`).join('\n\n').slice(-100_000);
  }

  roundHistory(sessionId: string, roundId: string, page = 0): RoundHistory {
    if (!this.database.get('SELECT id FROM interview_rounds WHERE id=$round AND session_id=$session', { $round: roundId, $session: sessionId })) throw new Error('Round not found.');
    const params = { $session: sessionId, $round: roundId, $offset: Math.max(0, Math.floor(page)) * 100 };
    const turns = this.database.all<TurnRow>(`SELECT * FROM conversation_turns WHERE session_id=$session AND round_id=$round AND speaker!='copilot' ORDER BY created_at,rowid LIMIT 101 OFFSET $offset`, params);
    const questions = this.database.all<QuestionRow>(`SELECT * FROM questions WHERE session_id=$session AND round_id=$round ORDER BY created_at,rowid LIMIT 101 OFFSET $offset`, params);
    const answers = new Map(this.database.all<AnswerRow>(`SELECT a.* FROM answers a WHERE a.id IN (
      SELECT (SELECT id FROM answers WHERE question_id=q.id AND session_id=$session ORDER BY created_at DESC,rowid DESC LIMIT 1)
      FROM (SELECT id FROM questions WHERE session_id=$session AND round_id=$round ORDER BY created_at,rowid LIMIT 100 OFFSET $offset) q
    )`, params).map(row => [String(row.question_id), mapAnswer(row)]));
    return { conversation: turns.slice(0, 100).map(mapTurn), hasMore: turns.length > 100 || questions.length > 100,
      questions: questions.slice(0, 100).map(mapQuestion).map(q => ({ ...q, answer: answers.get(q.id) })) };
  }

  listSessions(): Session[] {
    return this.database.all<SessionRow>('SELECT * FROM sessions ORDER BY updated_at DESC').map(mapSession);
  }

  getSession(id: string): Session | null {
    const row = this.database.get<SessionRow>('SELECT * FROM sessions WHERE id = $id', { $id: id });
    return row ? mapSession(row) : null;
  }

  saveSession(input: SessionInput): Session {
    const previous = input.id ? this.getSession(input.id) : null;
    const now = new Date().toISOString();
    const session: Session = { ...input, id: input.id ?? randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now,
      autoAnswer: input.autoAnswer ?? previous?.autoAnswer ?? false,
      saveTranscript: input.saveTranscript ?? previous?.saveTranscript ?? false,
      interviewUrl: input.interviewUrl ?? previous?.interviewUrl ?? '',
      resumeFileName: input.resumeFileName ?? previous?.resumeFileName ?? '',
    };
    this.database.mutate(`INSERT INTO sessions
      (id,title,role,company,interview_type,language,answer_style,answer_length,job_description,resume_text,instructions,selected_model,created_at,updated_at,auto_answer,save_transcript,interview_url,resume_file_name)
      VALUES ($id,$title,$role,$company,$interviewType,$language,$answerStyle,$answerLength,$jobDescription,$resumeText,$instructions,$selectedModel,$createdAt,$updatedAt,$autoAnswer,$saveTranscript,$interviewUrl,$resumeFileName)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, role=excluded.role, company=excluded.company, interview_type=excluded.interview_type,
        language=excluded.language, answer_style=excluded.answer_style, answer_length=excluded.answer_length,
        job_description=excluded.job_description, resume_text=excluded.resume_text, instructions=excluded.instructions,
        selected_model=excluded.selected_model, updated_at=excluded.updated_at,
        auto_answer=excluded.auto_answer, save_transcript=excluded.save_transcript,
        interview_url=excluded.interview_url, resume_file_name=excluded.resume_file_name`, this.values(session));
    return session;
  }

  deleteSession(id: string): void {
    this.clearTransientTurns(id);
    this.database.transaction((db) => {
      const params = { $id: id };
      for (const table of ['answers','questions','conversation_turns','document_chunks','documents','session_events','session_audio_sources','screen_contexts','interview_rounds']) {
        db.run(`DELETE FROM ${table} WHERE session_id = $id`, params);
      }
      db.run('DELETE FROM sessions WHERE id = $id', params);
    });
  }

  listDocuments(sessionId: string, includeRoundContext = true): DocumentRecord[] {
    return this.database.all<DocumentRow>(`SELECT * FROM documents WHERE session_id = $id ${includeRoundContext ? '' : "AND type!='round-context'"} ORDER BY created_at`, { $id: sessionId }).map(mapDocument);
  }

  addDocument(sessionId: string, name: string, type: DocumentType, mimeType: string, text: string, sizeBytes: number, id: string = randomUUID()): DocumentRecord {
    const document: DocumentRecord = { id, sessionId, name, type, mimeType, text, sizeBytes, createdAt: new Date().toISOString() };
    this.database.mutate(`INSERT INTO documents (id,session_id,name,type,mime_type,text,size_bytes,created_at)
      VALUES ($id,$sessionId,$name,$type,$mimeType,$text,$sizeBytes,$createdAt)`, {
      $id: document.id, $sessionId: document.sessionId, $name: document.name, $type: document.type,
      $mimeType: document.mimeType, $text: document.text, $sizeBytes: document.sizeBytes, $createdAt: document.createdAt,
    });
    return document;
  }

  removeDocument(id: string): void { this.database.mutate('DELETE FROM documents WHERE id = $id', { $id: id }); }

  listLibraryFiles(category?: LibraryFileCategory): StoredLibraryFile[] {
    const rows = category
      ? this.database.all<LibraryFileRow>('SELECT * FROM library_files WHERE category = $category ORDER BY created_at DESC', { $category: category })
      : this.database.all<LibraryFileRow>('SELECT * FROM library_files ORDER BY created_at DESC');
    return rows.map(mapLibraryFile);
  }

  getLibraryFile(id: string): StoredLibraryFile | null {
    const row = this.database.get<LibraryFileRow>('SELECT * FROM library_files WHERE id = $id', { $id: id });
    return row ? mapLibraryFile(row) : null;
  }

  findLibraryFile(category: LibraryFileCategory, contentHash: string): StoredLibraryFile | null {
    const row = this.database.get<LibraryFileRow>(
      'SELECT * FROM library_files WHERE category = $category AND content_hash = $contentHash',
      { $category: category, $contentHash: contentHash },
    );
    return row ? mapLibraryFile(row) : null;
  }

  addLibraryFile(file: StoredLibraryFile): StoredLibraryFile {
    this.database.mutate(`INSERT INTO library_files
      (id,category,name,mime_type,text,size_bytes,content_hash,storage_name,created_at)
      VALUES ($id,$category,$name,$mimeType,$text,$sizeBytes,$contentHash,$storageName,$createdAt)`, {
      $id: file.id, $category: file.category, $name: file.name, $mimeType: file.mimeType, $text: file.text,
      $sizeBytes: file.sizeBytes, $contentHash: file.contentHash, $storageName: file.storageName, $createdAt: file.createdAt,
    });
    return file;
  }

  deleteLibraryFile(id: string): void {
    this.database.mutate('DELETE FROM library_files WHERE id = $id', { $id: id });
  }

  replaceChunks(documentId: string, chunks: Array<ContextChunk & { tokenVector: string }>): void {
    this.database.transaction((db: SqlDatabase) => {
      db.run('DELETE FROM document_chunks WHERE document_id = $documentId', { $documentId: documentId });
      for (const c of chunks) db.run(`INSERT INTO document_chunks
        (id,session_id,document_id,document_type,section,page,chunk_index,text,token_vector)
        VALUES ($id,$sessionId,$documentId,$documentType,$section,$page,$chunkIndex,$text,$tokenVector)`, {
        $id: c.id, $sessionId: c.sessionId, $documentId: c.documentId, $documentType: c.documentType,
        $section: c.section, $page: c.page, $chunkIndex: c.chunkIndex, $text: c.text, $tokenVector: c.tokenVector,
      });
    });
  }

  listChunks(sessionId: string, queryTokens: string[] = []): Array<ContextChunk & { tokenVector: string }> {
    const tokens = queryTokens.slice(0, 24);
    const matches = tokens.length ? tokens.map((_token, index) => `token_vector LIKE $token${index}`).join(' OR ') : '0';
    const params: Record<string, string> = { $id: sessionId };
    tokens.forEach((token, index) => { params[`$token${index}`] = `%"${token}":%`; });
    return this.database.all<ChunkRow & { text: string; section: string; id: string; token_vector: string }>(
      `SELECT * FROM document_chunks WHERE session_id=$id AND (document_type!='round-context' OR id IN (
        SELECT id FROM document_chunks WHERE session_id=$id AND document_type='round-context' AND (${matches}) ORDER BY rowid DESC LIMIT 400
      ))`, params,
    ).map((r) => ({
      id: r.id, sessionId: r.session_id, documentId: r.document_id, documentType: r.document_type as DocumentType,
      section: r.section, page: r.page, chunkIndex: r.chunk_index, text: r.text, tokenVector: r.token_vector,
    }));
  }

  addTurn(sessionId: string, speaker: ConversationTurn['speaker'], text: string, source?: AudioSourceDescriptor, questionId?: string): ConversationTurn {
    const roundId = this.ensureRound(sessionId).id;
    const turn: ConversationTurn = { id: randomUUID(), sessionId, roundId, speaker, text, createdAt: new Date().toISOString(), questionId,
      sourceId: source?.id, sourceKind: source?.kind, sourceRole: source?.role, canTriggerAnswers: source?.canTriggerAnswers };
    if (speaker !== 'copilot' && this.getSession(sessionId)?.saveTranscript === false) {
      this.transientTurns.set(sessionId, [...(this.transientTurns.get(sessionId) ?? []), turn].slice(-120));
      return turn;
    }
    this.database.mutate(`INSERT INTO conversation_turns
      (id,session_id,speaker,text,created_at,source_id,source_kind,source_role,can_trigger_answers,question_id,round_id)
      VALUES ($id,$sessionId,$speaker,$text,$createdAt,$sourceId,$sourceKind,$sourceRole,$canTrigger,$questionId,$roundId)`, {
      $roundId: roundId,
      $id: turn.id, $sessionId: turn.sessionId, $speaker: turn.speaker, $text: turn.text, $createdAt: turn.createdAt,
      $sourceId: source?.id ?? null, $sourceKind: source?.kind ?? null, $sourceRole: source?.role ?? null,
      $canTrigger: source?.canTriggerAnswers ? 1 : 0, $questionId: questionId ?? null,
    });
    return turn;
  }

  updateTurnText(id: string, text: string): ConversationTurn | null {
    const normalized = text.trim();
    if (!normalized) return null;
    for (const turns of this.transientTurns.values()) {
      const turn = turns.find((item) => item.id === id);
      if (turn) { turn.text = normalized; return { ...turn }; }
    }
    this.database.mutate('UPDATE conversation_turns SET text = $text WHERE id = $id', { $id: id, $text: normalized });
    const row = this.database.get<TurnRow>('SELECT * FROM conversation_turns WHERE id = $id', { $id: id });
    return row ? mapTurn(row) : null;
  }

  saveAudioSource(sessionId: string, source: AudioSourceDescriptor): void {
    this.database.mutate(`INSERT OR REPLACE INTO session_audio_sources (session_id,source_json,updated_at) VALUES ($sessionId,$source,$updatedAt)`,
      { $sessionId: sessionId, $source: JSON.stringify(source), $updatedAt: new Date().toISOString() });
  }

  saveScreenContext(sessionId: string, context: ScreenContext): void {
    this.database.mutate('INSERT INTO screen_contexts (id,session_id,context_json,created_at) VALUES ($id,$sessionId,$context,$createdAt)',
      { $id: randomUUID(), $sessionId: sessionId, $context: JSON.stringify(context), $createdAt: context.capturedAt });
  }

  recentTurns(sessionId: string, limit = 12): ConversationTurn[] {
    return this.database.all<TurnRow>(`SELECT * FROM conversation_turns WHERE session_id = $id ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(limit, 120))}`, { $id: sessionId }).map(mapTurn).reverse();
  }

  contextTurns(sessionId: string, limit = 12): ConversationTurn[] {
    const round = this.currentRound(sessionId);
    const recorded = this.database.all<TurnRow>(`SELECT * FROM conversation_turns WHERE session_id=$id AND round_id=$round
      ORDER BY created_at DESC LIMIT $limit`, { $id: sessionId, $round: round?.id ?? '', $limit: Math.max(1, Math.min(limit, 120)) }).map(mapTurn);
    return [...recorded, ...(this.transientTurns.get(sessionId) ?? []).filter(turn => turn.roundId === round?.id)]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-Math.max(1, Math.min(limit, 120)));
  }

  clearTransientTurns(sessionId: string): void { this.transientTurns.delete(sessionId); }

  addQuestion(sessionId: string, intent: QuestionIntent): QuestionRecord {
    const item: QuestionRecord = { id: randomUUID(), sessionId, roundId: this.ensureRound(sessionId).id, text: intent.question, intent: intent.intent, confidence: intent.confidence, createdAt: new Date().toISOString() };
    this.database.mutate('INSERT INTO questions (id,session_id,text,intent,confidence,created_at,round_id) VALUES ($id,$sessionId,$text,$intent,$confidence,$createdAt,$roundId)', {
      $roundId: item.roundId!,
      $id: item.id, $sessionId: item.sessionId, $text: item.text, $intent: item.intent, $confidence: item.confidence, $createdAt: item.createdAt,
    });
    return item;
  }

  updateQuestionText(id: string, text: string): void {
    const normalized = text.trim();
    if (!normalized) return;
    this.database.mutate('UPDATE questions SET text = $text WHERE id = $id', { $id: id, $text: normalized });
  }

  addAnswer(sessionId: string, questionId: string, text: string, model: string, latencyMs: number): AnswerRecord {
    const answer: AnswerRecord = { id: randomUUID(), sessionId, questionId, text, model, latencyMs, createdAt: new Date().toISOString() };
    this.database.mutate('INSERT INTO answers VALUES ($id,$sessionId,$questionId,$text,$model,$latencyMs,$createdAt)', {
      $id: answer.id, $sessionId: answer.sessionId, $questionId: answer.questionId, $text: answer.text,
      $model: answer.model, $latencyMs: answer.latencyMs, $createdAt: answer.createdAt,
    });
    return answer;
  }

  hasCompletedAnswerForQuestion(sessionId: string, text: string): boolean {
    const target = normalizeQuestionText(text);
    if (!target) return false;
    const rows = this.database.all<{ text: string }>(`SELECT q.text
      FROM questions q INNER JOIN answers a ON a.question_id = q.id
      WHERE q.session_id = $sessionId AND q.round_id=$roundId`, { $sessionId: sessionId, $roundId: this.currentRound(sessionId)?.id ?? '' });
    return rows.some((row) => normalizeQuestionText(row.text) === target);
  }

  getDetail(id: string): SessionDetail | null {
    const session = this.getSession(id);
    if (!session) return null;
    const answers = this.database.all<AnswerRow>(`SELECT * FROM answers WHERE session_id=$id AND question_id IN
      (SELECT id FROM questions WHERE session_id=$id ORDER BY created_at DESC LIMIT 100) ORDER BY created_at DESC`, { $id: id }).map(mapAnswer);
    return {
      session, rounds: this.listRounds(id), documents: this.listDocuments(id, false),
      conversation: this.recentTurns(id, 120),
      questions: this.database.all<QuestionRow>('SELECT * FROM questions WHERE session_id = $id ORDER BY created_at DESC LIMIT 100', { $id: id })
        .map(mapQuestion).map((q) => ({ ...q, answer: answers.find((a) => a.questionId === q.id) })),
    };
  }

  summary(id: string): SessionSummary {
    const session = this.getSession(id);
    if (!session) throw new Error('Session not found');
    const questions = this.database.all<QuestionRow>('SELECT * FROM questions WHERE session_id = $id', { $id: id }).map(mapQuestion);
    const answers = this.database.all<AnswerRow>('SELECT * FROM answers WHERE session_id = $id', { $id: id }).map(mapAnswer);
    const topicCounts = new Map<string, number>();
    for (const q of questions) for (const word of q.text.toLowerCase().match(/[a-z][a-z+#.-]{3,}/g) ?? []) {
      if (!['what','when','where','which','would','could','about','your','with','have','tell','explain'].includes(word)) topicCounts.set(word, (topicCounts.get(word) ?? 0) + 1);
    }
    return {
      totalQuestions: questions.length,
      averageLatencyMs: answers.length ? Math.round(answers.reduce((sum, a) => sum + a.latencyMs, 0) / answers.length) : 0,
      topics: [...topicCounts.entries()].sort((a,b) => b[1]-a[1]).slice(0, 6).map(([word]) => word),
      startedAt: session.createdAt,
      lastActivityAt: questions[questions.length - 1]?.createdAt ?? session.updatedAt,
    };
  }

  getSettings(defaults: AppSettings): AppSettings {
    const row = this.database.get<{ value: string }>('SELECT value FROM settings WHERE key = $key', { $key: 'app' });
    if (!row) return defaults;
    try { return { ...defaults, ...JSON.parse(row.value) as Partial<AppSettings> }; } catch { return defaults; }
  }

  saveSettings(settings: AppSettings): AppSettings {
    this.database.mutate('INSERT OR REPLACE INTO settings (key,value) VALUES ($key,$value)', { $key: 'app', $value: JSON.stringify(settings) });
    return settings;
  }

  addEvent(sessionId: string, eventType: string, payload: object = {}): void {
    this.database.mutate('INSERT INTO session_events VALUES ($id,$sessionId,$type,$payload,$createdAt)', {
      $id: randomUUID(), $sessionId: sessionId, $type: eventType, $payload: JSON.stringify(payload), $createdAt: new Date().toISOString(),
    });
  }

  private values(s: Session): Record<string, string | number> {
    return { $id:s.id,$title:s.title,$role:s.role,$company:s.company,$interviewType:s.interviewType,$language:s.language,
      $answerStyle:s.answerStyle,$answerLength:s.answerLength,$jobDescription:s.jobDescription,$resumeText:s.resumeText,
      $instructions:s.instructions,$selectedModel:s.selectedModel,$createdAt:s.createdAt,$updatedAt:s.updatedAt,
      $autoAnswer:s.autoAnswer ? 1 : 0,$saveTranscript:s.saveTranscript === false ? 0 : 1,
      $interviewUrl:s.interviewUrl ?? '',$resumeFileName:s.resumeFileName ?? '' };
  }
}
