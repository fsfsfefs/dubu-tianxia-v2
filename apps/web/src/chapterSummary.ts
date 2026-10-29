import {getDocument, GlobalWorkerOptions} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {listOcrPages, saveOcrPage} from './api';
import {recognizeCanvas} from './ocr';

GlobalWorkerOptions.workerSrc = workerUrl;

export type ChapterSourceProgress = {
  completed: number;
  total: number;
  page: number;
  phase: 'reading' | 'ocr';
};

function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('全书结构生成已取消', 'AbortError');
}

export async function collectChapterSource(
  documentId: string,
  startPage: number,
  requestedEndPage: number | undefined,
  onProgress: (progress: ChapterSourceProgress) => void,
  signal?: AbortSignal,
): Promise<{source: string; endPage: number; pageCount: number; unreadablePages: number[]}> {
  throwIfCancelled(signal);
  const loadingTask = getDocument({url: `/api/documents/${documentId}/file`});
  const [pdf, savedPages] = await Promise.all([
    loadingTask.promise,
    listOcrPages(documentId).catch(() => []),
  ]);
  const endPage = Math.min(pdf.numPages, Math.max(startPage, requestedEndPage || pdf.numPages));
  const cached = new Map(savedPages.map(item => [item.page_number, item.text]));
  const pageTexts: {page: number; text: string}[] = [];
  const unreadablePages: number[] = [];
  const total = endPage - startPage + 1;

  try {
    for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
      throwIfCancelled(signal);
      let text = cached.get(pageNumber) || '';
      let phase: ChapterSourceProgress['phase'] = 'reading';
      onProgress({completed: pageNumber - startPage, total, page: pageNumber, phase});
      if (!text.trim()) {
        try {
          const page = await pdf.getPage(pageNumber);
          throwIfCancelled(signal);
          const textContent = await page.getTextContent();
          throwIfCancelled(signal);
          text = textContent.items.map(item => 'str' in item ? item.str : '').join(' ').trim();
          if (text.replace(/\s/g, '').length < 8) {
            phase = 'ocr';
            onProgress({completed: pageNumber - startPage, total, page: pageNumber, phase});
            const viewport = page.getViewport({scale: 1.1});
            const canvas = window.document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext('2d');
            if (context) {
              await page.render({canvas, canvasContext: context, viewport}).promise;
              throwIfCancelled(signal);
              const words = await recognizeCanvas(canvas, () => undefined);
              throwIfCancelled(signal);
              text = words.map(word => word.text).join(' ').trim();
            }
          }
          throwIfCancelled(signal);
          await saveOcrPage(documentId, pageNumber, text).catch(() => undefined);
        } catch (reason) {
          if (reason instanceof Error && reason.name === 'AbortError') throw reason;
          unreadablePages.push(pageNumber);
          text = '';
        }
      }
      throwIfCancelled(signal);
      pageTexts.push({page: pageNumber, text});
      onProgress({completed: pageNumber - startPage + 1, total, page: pageNumber, phase});
    }
  } finally {
    await loadingTask.destroy();
  }

  throwIfCancelled(signal);
  const source = pageTexts
    .map(item => `【PDF ${item.page}】${item.text || '本页未识别到文字'}`)
    .join('\n');
  if (!pageTexts.some(item => item.text.trim())) throw new Error('该章节未能识别出可总结的原文，请先进入教材确认 PDF 可以正常显示。');
  return {source, endPage, pageCount: pageTexts.length, unreadablePages};
}
