import {getDocument, GlobalWorkerOptions} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

export type OutlineEntry = {
  title: string;
  page: number;
  depth: number;
};

const outlineCache = new Map<string, Promise<OutlineEntry[]>>();

export function loadPdfOutline(documentId: string): Promise<OutlineEntry[]> {
  const cached = outlineCache.get(documentId);
  if (cached) return cached;

  const loadingTask = getDocument({url: `/api/documents/${documentId}/file`});
  const outlinePromise = loadingTask.promise.then(async pdf => {
    const entries: OutlineEntry[] = [];
    const items = await pdf.getOutline();

    const walk = async (nodes: typeof items, depth: number) => {
      for (const item of nodes || []) {
        let page = 1;
        try {
          const destination = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
          const reference = destination?.[0];
          if (typeof reference === 'number') page = reference + 1;
          else if (reference && typeof reference === 'object') page = (await pdf.getPageIndex(reference)) + 1;
        } catch {
          // Keep the entry visible even when an individual bookmark target is invalid.
        }
        entries.push({title: item.title?.trim() || '未命名章节', page, depth});
        if (item.items?.length) await walk(item.items, depth + 1);
      }
    };

    await walk(items, 0);
    await loadingTask.destroy();
    return entries;
  }).catch(error => {
    outlineCache.delete(documentId);
    void loadingTask.destroy();
    throw error;
  });

  outlineCache.set(documentId, outlinePromise);
  return outlinePromise;
}
