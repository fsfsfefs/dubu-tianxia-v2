import {useEffect, useRef, useState} from 'react';
import {GlobalWorkerOptions, PDFDocumentProxy, TextLayer} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {saveOcrPage, type DocumentRecord, type Highlight, type HighlightRect, type Note} from './api';
import './pdf-reader.css';
import {AnnotationLayer, type InkStyle} from './features/reader/AnnotationLayer';
import './features/reader/AnnotationLayer.css';
import {OcrWord, recognizeCanvas} from './ocr';

GlobalWorkerOptions.workerSrc = workerUrl;

export type SelectionState = {page: number; text: string; rects: HighlightRect[]} | null;
export type SearchResult = {page: number; snippet: string};
export type OutlineEntry = {title: string; page: number; depth: number};
export type PageRegion = {page: number; rect: HighlightRect} | null;
export type AnnotationTool = 'pen' | 'marker' | 'eraser' | null;
export type AnnotationPoint = {x: number; y: number};
export type AnnotationDraft = {page: number; points: AnnotationPoint[]};
export type AnnotationUndoAction = {type: 'add' | 'erase'; addedIds: string[]; removed?: Highlight[]};
export const INK_TAG = '__ink__';

export {smoothAnnotationPath} from './features/reader/inkPath';
export type SourceTraceLocation = {page: number; snippet: string; score: number};
export type SourceTraceNavigation = {query: string; summaryKey: string; locations: SourceTraceLocation[]; index: number};

export {matchPageText} from './features/reader/searchText';

export type ReaderProps = {
  document: DocumentRecord;
  onExcerpt: (text: string) => void;
  onRegionExcerpt?: (text: string, page: number) => void;
  onAiAssist?: (text: string, action: 'explain' | 'summary' | 'questions' | 'connect') => void;
  onPageChange?: (page: number) => void;
  onBack?: () => void;
  onOpenGuide?: () => void;
  onAssistantToggle?: () => void;
  assistantOpen?: boolean;
  notes?: Note[];
  onCreatePageNote?: (page: number, content: string) => Promise<void>;
  onUpdatePageNote?: (note: Note, content: string) => Promise<void>;
  onDeletePageNote?: (note: Note) => Promise<void>;
  targetPage?: number;
  targetPageRevision?: number;
  restoreLastPosition?: boolean;
  sourceTrace?: SourceTraceNavigation | null;
  onSourceTraceNavigate?: (index: number) => void;
  onSourceTraceReturn?: () => void;
  onSourceTraceClose?: () => void;
};

export type ContinuousPageProps = {
  pdf: PDFDocumentProxy;
  documentId: string;
  pageNumber: number;
  zoom: number;
  initialDimensions: {width: number; height: number};
  scrollRoot: React.RefObject<HTMLDivElement | null>;
  highlights: Highlight[];
  regionMode: boolean;
  region: PageRegion;
  annotationTool: AnnotationTool;
  annotationColor: Highlight['color'];
  annotationWidth: number;
  eraserSize: number;
  penOnly: boolean;
  annotationDraft: AnnotationDraft | null;
  onAnnotationDraft: (draft: AnnotationDraft | null) => void;
  onAnnotationSave: (page: number, points: AnnotationPoint[], style: InkStyle) => void;
  onAnnotationErase: (page: number, points: AnnotationPoint[], dimensions: {width: number; height: number}, radius: number) => Promise<void>;
  pageTextCache: React.MutableRefObject<Map<number, string>>;
  ocrCache: React.MutableRefObject<Map<number, OcrWord[]>>;
  onTextReady: (page: number, text: string, source: 'native' | 'ocr') => void;
  onOcrProgress: (page: number, progress: number | null) => void;
  onError: (message: string) => void;
  onMouseUp: (event: React.MouseEvent<HTMLDivElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
};

export type PdfThumbnailProps = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  current: boolean;
  marked: boolean;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
  onSelect: (page: number) => void;
  onToggleMark: (page: number) => void;
};

export function PdfThumbnail({pdf, pageNumber, current, marked, scrollRoot, onSelect, onToggleMark}: PdfThumbnailProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState(current);

  useEffect(() => {
    const host = hostRef.current;
    const root = scrollRoot.current;
    if (!host || !root) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setActive(true);
    }, {root, rootMargin: '500px 0px'});
    observer.observe(host);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!active || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: {cancel: () => void; promise: Promise<unknown>} | null = null;
    void pdf.getPage(pageNumber).then(page => {
      if (cancelled || !canvasRef.current) return;
      const viewport = page.getViewport({scale: .2});
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = canvasRef.current;
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext('2d');
      if (!context) return;
      renderTask = page.render({canvas, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0]});
      return renderTask.promise;
    }).catch(reason => {
      if (!cancelled && reason?.name !== 'RenderingCancelledException') console.warn(`缩略图 ${pageNumber} 渲染失败`, reason);
    });
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [active, pageNumber, pdf]);

  return <div ref={hostRef} className="thumbnail-item" data-thumbnail-page={pageNumber} aria-current={current ? 'page' : undefined}>
    <button className="thumbnail-jump" type="button" onClick={() => onSelect(pageNumber)}><span className="thumbnail-canvas"><canvas ref={canvasRef}/>{!active && <i>PDF</i>}</span><small>{pageNumber}</small></button>
    <button className={`thumbnail-star ${marked ? 'marked' : ''}`} type="button" aria-label={marked ? `取消第 ${pageNumber} 页星标` : `将第 ${pageNumber} 页加入高亮管理`} aria-pressed={marked} title={marked ? '取消整页星标' : '加入高亮管理'} onClick={() => onToggleMark(pageNumber)}>{marked ? '★' : '☆'}</button>
  </div>;
}

export function ContinuousPdfPage({pdf, documentId, pageNumber, zoom, initialDimensions, scrollRoot, highlights, regionMode, region, annotationTool, annotationColor, annotationWidth, eraserSize, penOnly, annotationDraft, onAnnotationDraft, onAnnotationSave, onAnnotationErase, pageTextCache, ocrCache, onTextReady, onOcrProgress, onError, onMouseUp, onPointerDown, onPointerMove, onPointerUp}: ContinuousPageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderId = useRef(0);
  const [active, setActive] = useState(false);
  const [dimensions, setDimensions] = useState(initialDimensions);
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const root = scrollRoot.current;
    if (!host || !root) return;
    const observer = new IntersectionObserver(entries => {
      setActive(entries.some(entry => entry.isIntersecting));
    }, {root, rootMargin: '1400px 0px', threshold: 0});
    observer.observe(host);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!active || !canvasRef.current || !textLayerRef.current) return;
    const currentRender = ++renderId.current;
    const canvas = canvasRef.current;
    const container = textLayerRef.current;
    setRendering(true);
    container.replaceChildren();
    pdf.getPage(pageNumber).then(async page => {
      if (currentRender !== renderId.current) return;
      const baseViewport = page.getViewport({scale: 1});
      const viewport = page.getViewport({scale: zoom});
      setDimensions({width: baseViewport.width, height: baseViewport.height});
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      container.style.width = `${viewport.width}px`;
      container.style.height = `${viewport.height}px`;
      container.style.setProperty('--total-scale-factor', `${viewport.scale}`);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器无法创建画布。');
      await page.render({canvas, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0]}).promise;
      if (currentRender !== renderId.current) return;
      const textContent = await page.getTextContent();
      if (currentRender !== renderId.current) return;
      const nativeText = textContent.items.map(item => 'str' in item ? item.str : '').join(' ').trim();
      if (nativeText.replace(/\s/g, '').length >= 8) {
        const textLayer = new TextLayer({textContentSource: textContent, container, viewport});
        await textLayer.render();
        if (currentRender !== renderId.current) return;
        pageTextCache.current.set(pageNumber, nativeText);
        void saveOcrPage(documentId, pageNumber, nativeText).catch(() => undefined);
        onTextReady(pageNumber, nativeText, 'native');
      } else {
        onOcrProgress(pageNumber, 0);
        let words = ocrCache.current.get(pageNumber);
        if (!words) {
          words = await recognizeCanvas(canvas, progress => {if (currentRender === renderId.current) onOcrProgress(pageNumber, Math.round(progress * 100));});
          if (currentRender !== renderId.current) return;
          ocrCache.current.set(pageNumber, words);
        }
        if (currentRender !== renderId.current) return;
        container.replaceChildren();
        for (const word of words) {
          const span = window.document.createElement('span');
          span.className = 'ocr-word';
          span.textContent = `${word.text} `;
          span.style.left = `${word.bbox.x0 / canvas.width * 100}%`;
          span.style.top = `${word.bbox.y0 / canvas.height * 100}%`;
          span.style.width = `${(word.bbox.x1 - word.bbox.x0) / canvas.width * 100}%`;
          span.style.height = `${(word.bbox.y1 - word.bbox.y0) / canvas.height * 100}%`;
          span.style.fontSize = `${Math.max(6, (word.bbox.y1 - word.bbox.y0) / canvas.height * viewport.height)}px`;
          container.append(span);
        }
        const recognizedText = words.map(word => word.text).join(' ');
        pageTextCache.current.set(pageNumber, recognizedText);
        void saveOcrPage(documentId, pageNumber, recognizedText).catch(() => undefined);
        onTextReady(pageNumber, recognizedText, 'ocr');
      }
    }).catch(reason => {if (currentRender === renderId.current) onError(reason instanceof Error ? reason.message : `第 ${pageNumber} 页渲染失败`);})
      .finally(() => {
        if (currentRender === renderId.current) {
          onOcrProgress(pageNumber, null);
          setRendering(false);
        }
      });
    return () => { renderId.current += 1; };
  }, [active, documentId, ocrCache, onError, onOcrProgress, onTextReady, pageNumber, pageTextCache, pdf, zoom]);

  const pageRegion = region?.page === pageNumber ? region.rect : null;
  const inkAnnotations = highlights.filter(item => item.tags?.includes(INK_TAG));
  const textHighlights = highlights.filter(item => !item.tags?.includes(INK_TAG));
  return <div
    ref={hostRef}
    className={`pdf-page continuous-page ${regionMode ? 'region-mode' : ''} ${annotationTool ? 'annotation-mode' : ''}`}
    data-page-number={pageNumber}
    style={{width: `${dimensions.width * zoom}px`, height: `${dimensions.height * zoom}px`}}
    onMouseUp={annotationTool ? undefined : onMouseUp}
  >
    {active ? <>
      <canvas ref={canvasRef}/>
      <div ref={textLayerRef} className="textLayer"/>
      <div className="highlight-layer">{textHighlights.flatMap(item => item.rects.map((rect, index) => <span key={`${item.id}-${index}`} className={`highlight ${item.color}`} title={item.text} style={{left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`}}/>))}</div>
      <AnnotationLayer documentId={documentId} page={pageNumber} dimensions={dimensions} zoom={zoom}
        highlights={inkAnnotations} tool={annotationTool} color={annotationColor} width={annotationWidth}
        eraserSize={eraserSize} penOnly={penOnly} draft={annotationDraft} onDraft={onAnnotationDraft}
        onSave={onAnnotationSave} onErase={onAnnotationErase}/>
      {rendering && <div className="page-loading">正在载入第 {pageNumber} 页…</div>}
      {regionMode && !annotationTool && <div className="region-capture" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>{pageRegion && <span style={{left: `${pageRegion.x * 100}%`, top: `${pageRegion.y * 100}%`, width: `${pageRegion.width * 100}%`, height: `${pageRegion.height * 100}%`}}/>}</div>}
    </> : <div className="page-placeholder">PDF {pageNumber}</div>}
  </div>;
}
