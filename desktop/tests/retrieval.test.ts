import { describe, expect, it } from 'vitest';
import { cosine, tokenize, vectorize } from '../src/main/retrieval/LocalRetriever';

describe('local retrieval math', () => {
  it('normalizes useful tokens and removes common stop words', () => expect(tokenize('The React application with TypeScript')).toEqual(['react', 'application', 'typescript']));
  it('ranks related text above unrelated text', () => {
    const query = vectorize('React TypeScript frontend');
    expect(cosine(query, vectorize('Built a React frontend using TypeScript'))).toBeGreaterThan(cosine(query, vectorize('Managed AWS database backups')));
  });
});
