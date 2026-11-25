import type { ContextDocument, ContextSnapshot } from '../../shared/accountContext';

/** Answers can draw on at most this many saved documents at once (the server allows eight per request). */
export const MAX_DOCUMENTS_IN_USE = 8;

/** The saved documents that answers use: the newest ones, up to the limit. Customers no longer tick documents by hand. */
export function documentsInUse(documents: ContextDocument[]): string[] {
  return [...documents]
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    .slice(0, MAX_DOCUMENTS_IN_USE)
    .map((document) => document.id);
}

const sameIds = (a: string[], b: string[]): boolean => a.length === b.length && a.every((id) => b.includes(id));

/**
 * Makes the saved documents the ones answers use. Resolves to the latest snapshot; a lookup that fails leaves the
 * snapshot as it was (the documents are then simply not used until the next try), it never blocks the page.
 */
export async function useSavedDocuments(snapshot: ContextSnapshot, select: (ids: string[]) => Promise<ContextSnapshot>): Promise<ContextSnapshot> {
  if (snapshot.pending) return snapshot;
  const ids = documentsInUse(snapshot.documents);
  if (sameIds(ids, snapshot.selectedIds)) return snapshot;
  try { return await select(ids); } catch { return snapshot; }
}
