import {getDocument, GlobalWorkerOptions} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {listOcrPages, saveOcrPage} from './api';
import {recognizeCanvas} from './ocr';

GlobalWorkerOptions.workerSrc = workerUrl;

export type RagIndexProgress = {
  completed: number;
  total: number;
  page: number;
  phase: 'read' | 'ocr' | 'done';
};

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('全文索引已取消', 'AbortError');
}

export async function ensureFullDocumentIndex(
  documentId: string,
  onProgress: (progress: RagIndexProgress) => void,
  signal?: AbortSignal,
): Promise<{indexedPages: number; totalPages: number}> {
  const saved = await listOcrPages(documentId);
  const existing = new Set(saved.map(page => page.page_number));
  const loadingTask = getDocument({url: `/api/documents/${documentId}/file`});
  try {
    const pdf = await loadingTask.promise;
    let completed = Math.min(existing.size, pdf.numPages);
    onProgress({completed, total: pdf.numPages, page: 0, phase: completed >= pdf.numPages ? 'done' : 'read'});
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      throwIfAborted(signal);
      if (existing.has(pageNumber)) continue;
      onProgress({completed, total: pdf.numPages, page: pageNumber, phase: 'read'});
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      let text = textContent.items.map(item => 'str' in item ? item.str : '').join(' ').trim();
      if (text.replace(/\s/g, '').length < 8) {
        onProgress({completed, total: pdf.numPages, page: pageNumber, phase: 'ocr'});
        const viewport = page.getViewport({scale: 1.2});
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        if (context) {
          await page.render({canvas, canvasContext: context, viewport}).promise;
          const words = await recognizeCanvas(canvas, () => undefined);
          text = words.map(word => word.text).join(' ').trim();
        }
      }
      throwIfAborted(signal);
      await saveOcrPage(documentId, pageNumber, text);
      completed += 1;
      onProgress({completed, total: pdf.numPages, page: pageNumber, phase: 'read'});
    }
    onProgress({completed, total: pdf.numPages, page: pdf.numPages, phase: 'done'});
    return {indexedPages: completed, totalPages: pdf.numPages};
  } finally {
    await loadingTask.destroy();
  }
}
