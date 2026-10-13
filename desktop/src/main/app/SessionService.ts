import path from 'node:path';
import type { DocumentRecord, DocumentType, ExtractedDocument, Session, SessionInput } from '../../shared/types';
import { Repositories } from '../database/Repositories';
import { DocumentProcessor } from '../documents/DocumentProcessor';
import { LocalRetriever } from '../retrieval/LocalRetriever';

export class SessionService {
  constructor(
    private readonly repositories: Repositories,
    private readonly documents: DocumentProcessor,
    private readonly retriever: LocalRetriever,
  ) {}

  startRound(sessionId: string, note = ''): void {
    if (note.length > 2000) throw new Error('Round note must be 2,000 characters or fewer.');
    this.finishRound(sessionId);
    // Legacy/interrupted rounds are indexed once, only when continuing them.
    for (const round of this.repositories.unindexedRounds(sessionId)) this.indexRound(sessionId, round.id, round.number, round.note);
    this.repositories.beginRound(sessionId, note);
  }

  finishRound(sessionId: string): void {
    const round = this.repositories.currentRound(sessionId);
    if (!round) return;
    // Close the source records first. A failed optional retrieval index must
    // not leave a finished round open; the next continuation retries it.
    this.repositories.finishRound(sessionId, '');
    this.indexRound(sessionId, round.id, round.number, round.note);
  }

  private indexRound(sessionId: string, roundId: string, number: number, note: string): string {
    const evidence = this.repositories.roundEvidence(sessionId, roundId);
    // Extractive, not generated: no hallucinated conclusions or extra AI usage.
    const excerpts = evidence.split('\n\n').filter(Boolean);
    const summary = `Round ${number} — recorded excerpts (not a verified biography):\n${excerpts.slice(-8).map(text => text.slice(0, 280)).join('\n')}`.slice(0, 3000);
    const text = `Previous round ${number}. Round brief: ${note}\n${summary}\n\n${evidence}`;
    const document = this.repositories.roundDocument(sessionId, roundId, `Round ${number} discussion`, text);
    this.retriever.index(document);
    this.repositories.markRoundIndexed(roundId, document.id, summary);
    return summary;
  }

  save(input: SessionInput): Session {
    const session = this.repositories.saveSession(input);
    this.syncBuiltInDocument(session, 'Session resume', 'resume', session.resumeText);
    this.syncBuiltInDocument(session, 'Session job description', 'job-description', session.jobDescription);
    return session;
  }

  async addFile(sessionId: string, type: DocumentType, filePath: string): Promise<DocumentRecord> {
    const extracted = await this.documents.extract(filePath);
    const document = this.repositories.addDocument(sessionId, path.basename(filePath), type, extracted.mimeType, extracted.text, extracted.sizeBytes);
    this.retriever.index(document);
    return document;
  }

  async extractFile(filePath: string): Promise<ExtractedDocument> {
    const extracted = await this.documents.extract(filePath);
    return { name: path.basename(filePath), ...extracted };
  }

  addExtracted(sessionId: string, type: DocumentType, extracted: ExtractedDocument): DocumentRecord {
    const clean = extracted.text.replace(/\r\n/g, '\n').trim();
    if (!clean) throw new Error('The document text cannot be empty.');
    const document = this.repositories.addDocument(
      sessionId,
      path.basename(extracted.name),
      type,
      extracted.mimeType,
      clean,
      extracted.sizeBytes,
    );
    this.retriever.index(document);
    return document;
  }

  addText(sessionId: string, type: DocumentType, name: string, text: string): DocumentRecord {
    const clean = text.replace(/\r\n/g, '\n').trim();
    if (!clean) throw new Error('The document text cannot be empty.');
    const document = this.repositories.addDocument(sessionId, name, type, 'text/plain', clean, Buffer.byteLength(clean, 'utf8'));
    this.retriever.index(document);
    return document;
  }

  private syncBuiltInDocument(session: Session, name: string, type: DocumentType, text: string): void {
    for (const doc of this.repositories.listDocuments(session.id).filter((item) => item.name === name)) this.repositories.removeDocument(doc.id);
    if (text.trim()) {
      const doc = this.repositories.addDocument(session.id, name, type, 'text/plain', text.trim(), Buffer.byteLength(text, 'utf8'));
      this.retriever.index(doc);
    }
  }
}
