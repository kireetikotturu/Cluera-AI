import { randomUUID } from 'node:crypto';
import type { ContextChunk, DocumentRecord } from '../../shared/types';
import type { AppConfig } from '../config/appConfig';
import { Repositories } from '../database/Repositories';

type Vector = Record<string, number>;

const STOP_WORDS = new Set(['the','a','an','and','or','to','of','in','on','for','with','is','are','was','were','be','been','i','my','we','our','you','your','it','that','this','as','at','by','from']);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{1,}/g) ?? []).filter((word) => !STOP_WORDS.has(word));
}

export function vectorize(text: string): Vector {
  const vector: Vector = {};
  for (const token of tokenize(text)) vector[token] = (vector[token] ?? 0) + 1;
  const length = Math.sqrt(Object.values(vector).reduce((sum, value) => sum + value * value, 0)) || 1;
  for (const token of Object.keys(vector)) vector[token] /= length;
  return vector;
}

export function cosine(a: Vector, b: Vector): number {
  let score = 0;
  const [small, large] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a];
  for (const [key, value] of Object.entries(small)) score += value * (large[key] ?? 0);
  return score;
}

export class LocalRetriever {
  constructor(private readonly repositories: Repositories, private readonly config: AppConfig['retrieval']) {}

  index(document: DocumentRecord): void {
    const chunks = this.chunk(document.text).map((text, index) => ({
      id: randomUUID(), sessionId: document.sessionId, documentId: document.id, documentType: document.type,
      section: this.detectSection(text), page: null, chunkIndex: index, text, tokenVector: JSON.stringify(vectorize(text)),
    }));
    this.repositories.replaceChunks(document.id, chunks);
  }

  retrieve(sessionId: string, query: string, topK = this.config.topK): ContextChunk[] {
    const queryVector = vectorize(query);
    return this.repositories.listChunks(sessionId, Object.keys(queryVector))
      .map(({ tokenVector, ...chunk }) => ({ ...chunk, score: cosine(queryVector, JSON.parse(tokenVector) as Vector) }))
      .filter((chunk) => (chunk.score ?? 0) > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, topK);
  }

  private chunk(text: string): string[] {
    const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const output: string[] = [];
    let current = '';
    for (const paragraph of paragraphs) {
      if ((current + paragraph).length <= this.config.chunkSize) { current += `${current ? '\n\n' : ''}${paragraph}`; continue; }
      if (current) output.push(current);
      if (paragraph.length <= this.config.chunkSize) { current = paragraph; continue; }
      for (let start = 0; start < paragraph.length; start += this.config.chunkSize - this.config.chunkOverlap) {
        output.push(paragraph.slice(start, start + this.config.chunkSize));
      }
      current = '';
    }
    if (current) output.push(current);
    return output;
  }

  private detectSection(text: string): string {
    const first = text.split('\n')[0]?.trim() ?? 'General';
    return first.length <= 80 ? first : 'General';
  }
}
