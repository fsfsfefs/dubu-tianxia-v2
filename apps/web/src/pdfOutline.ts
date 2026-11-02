import {getDocumentOutline} from './api';
export type OutlineEntry = {title: string; page: number; depth: number};
// Both reader and overview resolve the same saved/original directory; no stale cache.
export async function loadPdfOutline(documentId: string): Promise<OutlineEntry[]> {
  return (await getDocumentOutline(documentId)).outline;
}
