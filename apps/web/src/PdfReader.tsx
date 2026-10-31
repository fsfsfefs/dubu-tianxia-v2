import {usePdfSearch} from './features/reader/usePdfSearch';
import {useAnnotations} from './features/reader/useAnnotations';
import {useCallback, useEffect, useRef, useState} from 'react';
import {getDocument, GlobalWorkerOptions, PDFDocumentProxy} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  getPosition, Highlight,
  listHighlights, listOcrPages, savePosition,
} from './api';
import './pdf-reader.css';
import {OcrWord} from './ocr';
import {useAutoDismiss} from './useAutoDismiss';

GlobalWorkerOptions.workerSrc = workerUrl;

import {PdfThumbnail, ContinuousPdfPage, INK_TAG} from './PdfPages';
import type {SelectionState, OutlineEntry, PageRegion, ReaderProps} from './PdfPages';
export type {SourceTraceLocation, SourceTraceNavigation} from './PdfPages';
export function PdfReader({document, onExcerpt, onRegionExcerpt, onAiAssist, onPageChange, onBack, onOpenGuide, onAssistantToggle, assistantOpen, notes = [], onCreatePageNote, onUpdatePageNote, onDeletePageNote, targetPage, targetPageRevision = 0, restoreLastPosition = true, sourceTrace, onSourceTraceNavigate, onSourceTraceReturn, onSourceTraceClose}: ReaderProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [initialPageDimensions, setInitialPageDimensions] = useState({width: 595, height: 842});
  const [pageNumber, setPageNumber] = useState(() => targetPage || 1);
  const [zoom, setZoom] = useState(1);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [selection, setSelection] = useState<SelectionState>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightOpen, setHighlightOpen] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<'pages' | 'outline' | null>(null);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [paperTone, setPaperTone] = useState(false);
  const [regionMode, setRegionMode] = useState(false);
  const [region, setRegion] = useState<PageRegion>(null);
  const [notePanelOpen, setNotePanelOpen] = useState(false);
  const [stickyDraft, setStickyDraft] = useState('');
  const [editingStickyId, setEditingStickyId] = useState<string | null>(null);
  const [editingStickyContent, setEditingStickyContent] = useState('');
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [textSource, setTextSource] = useState<'native' | 'ocr' | 'none'>('none');
  const [ocrProgress, setOcrProgress] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const thumbnailListRef = useRef<HTMLDivElement>(null);
  const currentPageRef = useRef(pageNumber);
  const currentZoomRef = useRef(zoom);
  const readingPositionRef = useRef({pageNumber, pageOffset: 0});
  const pendingRestoreRef = useRef<{pageNumber: number; pageOffset: number} | null>(null);
  const positionReadyRef = useRef(false);
  const positionSaveTimer = useRef<number | null>(null);
  const dragStart = useRef<{x: number; y: number} | null>(null);
  const dragPage = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const pageSources = useRef(new Map<number, 'native' | 'ocr'>());
  const ocrCache = useRef(new Map<number, OcrWord[]>());
  const {query, setQuery, searching, searchedPages, setSearchedPages, lastSearchQuery, setLastSearchQuery, results, setResults, searchDocument, cancelSearch, pageTextCache} = usePdfSearch(document.id, pdf, setError);
  const {annotationTool, setAnnotationTool, annotationColor, setAnnotationColor, annotationWidth, setAnnotationWidth, annotationDraft, setAnnotationDraft, annotationToolbarOpen, setAnnotationToolbarOpen, annotationUndoDepth,
    highlightQuery, setHighlightQuery, editingHighlight, setEditingHighlight, highlightComment, setHighlightComment, highlightTags, setHighlightTags,
    saveTextHighlight, recolorHighlight, saveHighlightDetails, removeHighlight, saveInkAnnotation, eraseInkAt, undoAnnotation, togglePageMark} = useAnnotations(document, highlights, setHighlights, setError);
  const url = `/api/documents/${document.id}/file`;
  currentPageRef.current = pageNumber;
  currentZoomRef.current = zoom;

  const flushReadingPosition = useCallback(() => {
    if (!positionReadyRef.current) return;
    if (positionSaveTimer.current !== null) {
      window.clearTimeout(positionSaveTimer.current);
      positionSaveTimer.current = null;
    }
    const {pageNumber: savedPage, pageOffset} = readingPositionRef.current;
    void savePosition(document.id, {page_number: savedPage, page_offset: pageOffset, zoom: currentZoomRef.current}).catch(() => undefined);
  }, [document.id]);

  const queueReadingPosition = useCallback((savedPage: number, pageOffset: number) => {
    readingPositionRef.current = {pageNumber: savedPage, pageOffset};
    if (!positionReadyRef.current) return;
    if (positionSaveTimer.current !== null) window.clearTimeout(positionSaveTimer.current);
    positionSaveTimer.current = window.setTimeout(flushReadingPosition, 450);
  }, [flushReadingPosition]);

  useAutoDismiss(error, () => setError(''));

  useEffect(() => {
    let alive = true;
    const loadingTask = getDocument({url});
    positionReadyRef.current = false;
    pendingRestoreRef.current = null;
    if (positionSaveTimer.current !== null) window.clearTimeout(positionSaveTimer.current);
    setLoading(true); setError(''); setPdf(null); setSelection(null); setResults([]); setQuery(''); setSearchedPages(0); setLastSearchQuery(''); setTextSource('none'); setOcrProgress(null); pageTextCache.current.clear(); ocrCache.current.clear();
    Promise.all([getPosition(document.id), listHighlights(document.id), listOcrPages(document.id).catch(() => []), loadingTask.promise])
      .then(async ([position, savedHighlights, savedOcrPages, loadedPdf]) => {
        if (!alive) return;
        const firstPage = await loadedPdf.getPage(1);
        const firstViewport = firstPage.getViewport({scale: 1});
        if (!alive) return;
        setInitialPageDimensions({width: firstViewport.width, height: firstViewport.height});
        const savedPage = restoreLastPosition ? position.page_number : (targetPage || position.page_number);
        const startPage = Math.max(1, Math.min(savedPage, loadedPdf.numPages));
        const pageOffset = restoreLastPosition ? Math.max(0, Math.min(position.page_offset || 0, 1)) : 0;
        readingPositionRef.current = {pageNumber: startPage, pageOffset};
        pendingRestoreRef.current = {pageNumber: startPage, pageOffset};
        setPageNumber(startPage);
        setZoom(position.zoom);
        setHighlights(savedHighlights);
        savedOcrPages.forEach(item => pageTextCache.current.set(item.page_number, item.text));
        setSearchedPages(pageTextCache.current.size);
        setPdf(loadedPdf);
        void loadedPdf.getOutline().then(async items => {
          const entries: OutlineEntry[] = [];
          const walk = async (nodes: typeof items, depth: number) => {
            for (const item of nodes || []) {
              try {
                const destination = typeof item.dest === 'string' ? await loadedPdf.getDestination(item.dest) : item.dest;
                const reference = destination?.[0];
                const page = reference && typeof reference === 'object' ? (await loadedPdf.getPageIndex(reference)) + 1 : 1;
                entries.push({title: item.title || '未命名章节', page, depth});
              } catch { entries.push({title: item.title || '未命名章节', page: 1, depth}); }
              if (item.items?.length) await walk(item.items, depth + 1);
            }
          };
          await walk(items, 0); if (alive) setOutline(entries);
        });
      })
      .catch(reason => {
        if (alive) setError(reason instanceof Error ? reason.message : 'PDF 加载失败');
      })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; void loadingTask.destroy(); };
    // Opening a document captures whether this entry is a normal resume or an
    // explicit page jump. Later jumps must not reload the PDF.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id, url]);

  useEffect(() => {
    const flush = () => flushReadingPosition();
    window.addEventListener('pagehide', flush);
    window.document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.document.removeEventListener('visibilitychange', flush);
      flushReadingPosition();
    };
  }, [flushReadingPosition]);

  useEffect(() => {
    onPageChange?.(pageNumber);
  }, [onPageChange, pageNumber]);

  useEffect(() => {
    if (sidebarMode !== 'pages') return;
    thumbnailListRef.current?.querySelector<HTMLElement>(`[data-thumbnail-page="${pageNumber}"]`)?.scrollIntoView({block: 'nearest'});
  }, [pageNumber, sidebarMode]);

  useEffect(() => {
    if (!pdf) return;
    if (restoreLastPosition) return;
    const requestedPage = targetPage ? Math.max(1, Math.min(pdf.numPages, targetPage)) : null;
    if (!requestedPage) return;
    setPageNumber(requestedPage);
    window.requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-page-number="${requestedPage}"]`)?.scrollIntoView({block: 'start'});
    });
    // targetPage mirrors ordinary scrolling, while targetPageRevision changes
    // only for an explicit external navigation request. Keeping targetPage out
    // of the dependency list prevents delayed scroll reports from pulling the
    // reader back to an earlier page.
  }, [pdf, restoreLastPosition, targetPageRevision]);

  useEffect(() => {
    if (!pdf || !positionReadyRef.current) return;
    const current = readingPositionRef.current;
    queueReadingPosition(pageNumber, current.pageNumber === pageNumber ? current.pageOffset : 0);
  }, [pageNumber, pdf, queueReadingPosition, zoom]);

  useEffect(() => {
    if (!pdf) return;
    let secondFrame = 0;
    let readyFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const scroller = scrollRef.current;
        const pending = pendingRestoreRef.current;
        if (!scroller || !pending) return;
        const page = scroller.querySelector<HTMLElement>(`[data-page-number="${pending.pageNumber}"]`);
        if (!page) return;
        const focusOffset = Math.min(scroller.clientHeight * .42, 360);
        scroller.scrollTop = Math.max(0, page.offsetTop + pending.pageOffset * page.offsetHeight - focusOffset);
        readingPositionRef.current = pending;
        pendingRestoreRef.current = null;
        readyFrame = window.requestAnimationFrame(() => { positionReadyRef.current = true; });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      window.cancelAnimationFrame(readyFrame);
    };
  }, [pdf]);

  const captureSelection = (event: React.MouseEvent<HTMLDivElement>) => {
    const pageElement = event.currentTarget;
    const layer = pageElement.querySelector<HTMLDivElement>('.textLayer');
    const selectedPage = Number(pageElement.dataset.pageNumber);
    const selected = window.getSelection();
    if (!layer || !selectedPage || !selected || selected.isCollapsed || !selected.rangeCount) { setSelection(null); return; }
    const range = selected.getRangeAt(0);
    if (!layer.contains(range.commonAncestorContainer)) { setSelection(null); return; }
    const bounds = layer.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 1 && rect.height > 1).map(rect => {
      const x = Math.min(1, Math.max(0, (rect.left - bounds.left) / bounds.width));
      const y = Math.min(1, Math.max(0, (rect.top - bounds.top) / bounds.height));
      return {
        x, y,
        width: Math.min(1 - x, rect.width / bounds.width),
        height: Math.min(1 - y, rect.height / bounds.height),
      };
    }).filter(rect => rect.width > 0 && rect.height > 0);
    const text = selected.toString().trim();
    setSelection(text && rects.length ? {page: selectedPage, text, rects} : null);
  };

  const saveHighlight = () => saveTextHighlight(selection, () => {
    window.getSelection()?.removeAllRanges(); setSelection(null);
  });

  const copySelection = async () => {
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setError('复制失败，请使用 Ctrl+C。');
    }
  };

  const changePage = (next: number) => {
    const bounded = Math.max(1, Math.min(pdf?.numPages || 1, next));
    queueReadingPosition(bounded, 0);
    setPageNumber(bounded);
    scrollRef.current?.querySelector<HTMLElement>(`[data-page-number="${bounded}"]`)?.scrollIntoView({behavior: 'smooth', block: 'start'});
  };

  const trackVisiblePage = () => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null;
      const scroller = scrollRef.current;
      if (!scroller) return;
      const rootBounds = scroller.getBoundingClientRect();
      // A stable reading line avoids two adjacent pages alternately becoming
      // the "largest visible" page while the user rests at their boundary.
      const focusY = rootBounds.top + Math.min(rootBounds.height * .42, 360);
      let focusedPage = currentPageRef.current;
      let focusedOffset = readingPositionRef.current.pageOffset;
      let found = false;
      scroller.querySelectorAll<HTMLElement>('[data-page-number]').forEach(element => {
        if (found) return;
        const bounds = element.getBoundingClientRect();
        if (bounds.top <= focusY && bounds.bottom >= focusY) {
          focusedPage = Number(element.dataset.pageNumber) || focusedPage;
          focusedOffset = Math.max(0, Math.min((focusY - bounds.top) / Math.max(bounds.height, 1), 1));
          found = true;
        }
      });
      // Keep the current page while the reading line is in the inter-page gap.
      if (found && focusedPage !== currentPageRef.current) {
        setPageNumber(focusedPage);
        setTextSource(pageSources.current.get(focusedPage) || 'none');
        setSelection(null);
      }
      if (found) queueReadingPosition(focusedPage, focusedOffset);
    });
  };

  const handleTextReady = useCallback((page: number, _text: string, source: 'native' | 'ocr') => {
    pageSources.current.set(page, source);
    setSearchedPages(pageTextCache.current.size);
    if (currentPageRef.current === page) setTextSource(source);
  }, []);

  const handleOcrProgress = useCallback((page: number, progress: number | null) => {
    if (currentPageRef.current === page) setOcrProgress(progress);
  }, []);

  const handlePageError = useCallback((message: string) => setError(message), []);

  const regionPoint = (clientX: number, clientY: number, pageElement: HTMLElement) => {
    const bounds = pageElement.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height)),
    };
  };

  const beginRegion = (event: React.PointerEvent<HTMLDivElement>) => {
    const pageElement = event.currentTarget.closest<HTMLElement>('.pdf-page');
    const selectedPage = Number(pageElement?.dataset.pageNumber);
    if (!pageElement || !selectedPage) return;
    const point = regionPoint(event.clientX, event.clientY, pageElement);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = point;
    dragPage.current = selectedPage;
    setRegion({page: selectedPage, rect: {x: point.x, y: point.y, width: 0, height: 0}});
  };

  const moveRegion = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    const pageElement = event.currentTarget.closest<HTMLElement>('.pdf-page');
    if (!start || !pageElement || dragPage.current !== Number(pageElement.dataset.pageNumber)) return;
    const point = regionPoint(event.clientX, event.clientY, pageElement);
    setRegion({page: dragPage.current, rect: {x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y)}});
  };

  const finishRegion = (event: React.PointerEvent<HTMLDivElement>) => {
    dragStart.current = null;
    dragPage.current = null;
    if (!region || region.rect.width < .01 || region.rect.height < .01) { setRegion(null); return; }
    const pageElement = event.currentTarget.closest<HTMLElement>('.pdf-page');
    const pageBounds = pageElement?.getBoundingClientRect();
    const spans = pageElement?.querySelectorAll('.textLayer span');
    if (!pageElement || !pageBounds || !spans || Number(pageElement.dataset.pageNumber) !== region.page) return;
    const selectedRect = region.rect;
    const words = Array.from(spans).filter(span => {
      const box = span.getBoundingClientRect();
      const centerX = (box.left + box.width / 2 - pageBounds.left) / pageBounds.width;
      const centerY = (box.top + box.height / 2 - pageBounds.top) / pageBounds.height;
      return centerX >= selectedRect.x && centerX <= selectedRect.x + selectedRect.width && centerY >= selectedRect.y && centerY <= selectedRect.y + selectedRect.height;
    }).map(span => span.textContent || '').filter(Boolean);
    const text = words.join(' ').trim();
    if (text) {
      setSelection({page: region.page, text, rects: [selectedRect]});
      onExcerpt(text);
      onRegionExcerpt?.(text, region.page);
      setRegionMode(false);
    } else setError('框选区域没有可读取的文字；扫描版页面请改用模型的图片理解能力。');
  };

  const normalizedHighlightQuery = highlightQuery.trim().toLocaleLowerCase();
  const managedHighlights = highlights.filter(item => !item.tags?.includes(INK_TAG));
  const visibleHighlights = normalizedHighlightQuery ? managedHighlights.filter(item =>
    [item.text, item.comment, ...(item.tags || [])].join(' ').toLocaleLowerCase().includes(normalizedHighlightQuery),
  ) : managedHighlights;
  const pageNotes = notes.filter(note => note.page_number === pageNumber && note.tags?.includes('页边便签'));
  const pageAnnotationCount = highlights.filter(item => item.page_number === pageNumber && item.tags?.includes(INK_TAG)).length;

  const moveToTrace = (index: number) => {
    if (!sourceTrace || index < 0 || index >= sourceTrace.locations.length) return;
    onSourceTraceNavigate?.(index);
    changePage(sourceTrace.locations[index].page);
  };


  return <div className={`pdf-reader original-reader ${paperTone ? 'paper-tone' : ''} ${sidebarMode ? 'side-panel-open' : ''} ${notePanelOpen ? 'note-panel-open' : ''}`}>
    <div className="reader-toolbar original-toolbar">
      <div className="reader-book-heading">
        <button className="back-button" onClick={onBack}>← 返回前一页</button>
        <h1>{document.title}</h1>
      </div>
      <div className="toolbar-group page-controls" aria-label="PDF 翻页">
        <button aria-label="上一页" disabled={pageNumber <= 1} onClick={() => changePage(pageNumber - 1)}>←</button>
        <label><input value={pageNumber} type="number" min="1" max={pdf?.numPages || 1} onChange={event => changePage(Number(event.target.value))}/> / {pdf?.numPages || '—'}</label>
        <button aria-label="下一页" disabled={!pdf || pageNumber >= pdf.numPages} onClick={() => changePage(pageNumber + 1)}>→</button>
      </div>
      <div className="toolbar-group reader-tools">
        <button className="preparation-status" type="button">{ocrProgress !== null ? `OCR 识别 ${ocrProgress}%` : loading || textSource === 'none' ? '正在读取文字层…' : textSource === 'ocr' ? 'OCR 文字可选' : '文字层已就绪'}</button>
        <button className={sidebarMode === 'outline' ? 'active' : ''} aria-expanded={sidebarMode === 'outline'} title="目录" onClick={() => setSidebarMode(value => value === 'outline' ? null : 'outline')}><span className="tool-icon" aria-hidden="true">☰</span><span>目录</span></button>
        <button className={sidebarMode === 'pages' ? 'active' : ''} aria-expanded={sidebarMode === 'pages'} title="页面缩略图" onClick={() => setSidebarMode(value => value === 'pages' ? null : 'pages')}><span className="tool-icon pages-icon" aria-hidden="true">▤</span><span>页面</span></button>
        <button className={searchOpen ? 'active' : ''} aria-expanded={searchOpen} aria-label="书内搜索" title="书内搜索" onClick={() => setSearchOpen(value => {if (value) cancelSearch(); return !value;})}><span className="tool-icon" aria-hidden="true">⌕</span></button>
        <button className={regionMode ? 'active' : ''} aria-pressed={regionMode} title="框选区域解释" onClick={() => {setRegionMode(value => !value); setRegion(null); setAnnotationTool(null);}}><span className="tool-icon" aria-hidden="true">⌗</span><span>框选</span></button>
        <button className={annotationToolbarOpen ? 'active' : ''} aria-expanded={annotationToolbarOpen} title="在 PDF 上绘制标注" onClick={() => {const next = !annotationToolbarOpen; setAnnotationToolbarOpen(next); setAnnotationTool(next ? (annotationTool || 'pen') : null); if (!next) setAnnotationDraft(null); setRegionMode(false); setRegion(null);}}><span className="tool-icon" aria-hidden="true">✎</span><span>标注</span>{pageAnnotationCount ? <sup>{pageAnnotationCount}</sup> : null}</button>
        <button className={notePanelOpen ? 'active' : ''} aria-expanded={notePanelOpen} title="页边便签" onClick={() => setNotePanelOpen(value => !value)}><span className="tool-icon" aria-hidden="true">▤</span><span>便签</span>{pageNotes.length ? <sup>{pageNotes.length}</sup> : null}</button>
        <button className={highlightOpen ? 'active' : ''} aria-expanded={highlightOpen} title="高亮管理" aria-label="高亮管理" onClick={() => setHighlightOpen(value => !value)}><span className="tool-icon" aria-hidden="true">★</span>{managedHighlights.length ? <sup>{managedHighlights.length}</sup> : null}</button>
        {onAssistantToggle && <button className={assistantOpen ? 'active' : ''} aria-expanded={assistantOpen} onClick={onAssistantToggle}><span className="tool-icon assistant-icon" aria-hidden="true">◇</span><span>{assistantOpen ? '收起助读' : 'AI助读'}</span></button>}
        {onOpenGuide && <button aria-label="使用指南" title="使用指南" onClick={onOpenGuide}><span className="tool-icon" aria-hidden="true">?</span></button>}
        <details className="reader-more" open={displayOpen} onToggle={event => setDisplayOpen(event.currentTarget.open)}><summary title="更多阅读工具">···</summary><div>
          <button onClick={() => setZoom(value => Math.max(.5, +(value - .1).toFixed(1)))}>−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(value => Math.min(3, +(value + .1).toFixed(1)))}>＋</button>
          <button onClick={() => setZoom(1)}>适应宽度</button><label><input type="checkbox" checked={paperTone} onChange={event => setPaperTone(event.target.checked)}/>柔和纸色</label>
        </div></details>
      </div>
    </div>
    {annotationToolbarOpen && <div className="annotation-toolbar" aria-label="PDF 标注工具">
      <button className={annotationTool === 'pen' ? 'active' : ''} onClick={() => setAnnotationTool('pen')}>画笔</button>
      <button className={annotationTool === 'marker' ? 'active' : ''} onClick={() => setAnnotationTool('marker')}>荧光笔</button>
      <button className={annotationTool === 'eraser' ? 'active' : ''} onClick={() => setAnnotationTool('eraser')}>橡皮擦</button>
      <span className="annotation-colors">{(['black', 'red', 'blue', 'pink', 'green', 'yellow'] as Highlight['color'][]).map(color => <button key={color} className={`color ${color} ${annotationColor === color ? 'selected' : ''}`} aria-label={`选择${color}标注色`} onClick={() => setAnnotationColor(color)}/>)}</span>
      <label>粗细<input type="range" min="2" max="16" value={Math.round(annotationWidth * 1000)} onChange={event => setAnnotationWidth(Number(event.target.value) / 1000)}/></label>
      <button disabled={!annotationUndoDepth} title="撤销标注（Ctrl+Z）" onClick={() => void undoAnnotation()}>撤销 Ctrl+Z</button>
      <button onClick={() => {setAnnotationTool(null); setAnnotationDraft(null); setAnnotationToolbarOpen(false);}}>完成</button>
    </div>}
    {searchOpen && <div className="search-panel">
      <header><strong>书内搜索</strong><button aria-label="关闭搜索" onClick={() => {cancelSearch(); setSearchOpen(false);}}>×</button></header>
      <form className="search-form" onSubmit={event => {event.preventDefault(); void searchDocument();}}><label className="search-input-wrap"><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索原文文字…"/>{query && <button type="button" aria-label="清空搜索" onClick={() => {cancelSearch(); setQuery(''); setResults([]); setLastSearchQuery(''); setSearchedPages(pageTextCache.current.size);}}>×</button>}</label><button disabled={searching || !query.trim()}>{searching ? '索引中' : '搜索'}</button></form>
      <p className="search-summary">{searching ? `正在建立全文索引 ${searchedPages} / ${pdf?.numPages || 0} 页` : lastSearchQuery ? searchedPages >= (pdf?.numPages || 0) ? `已从全文索引搜索 ${pdf?.numPages || searchedPages} 页 · 找到 ${results.length} 页` : `已索引 ${searchedPages} / ${pdf?.numPages || 0} 页 · 找到 ${results.length} 页` : `已索引 ${searchedPages} / ${pdf?.numPages || 0} 页，可直接搜索已有内容`}</p>
      <div className="search-results">{results.map(result => <button key={result.page} onClick={() => {cancelSearch(); changePage(result.page); setSearchOpen(false);}}><strong>PDF 第 {result.page} 页</strong><span>{result.snippet}</span></button>)}{!searching && lastSearchQuery && !results.length && <p>未找到“{lastSearchQuery}”</p>}{!searching && !lastSearchQuery && <p>输入关键词，搜索结果会按 PDF 页码显示。</p>}</div>
    </div>}
    {highlightOpen && <div className="highlight-panel enhanced">
      <header><strong>高亮与星标</strong><span>{visibleHighlights.length} / {managedHighlights.length} 条</span></header>
      <div className="highlight-search"><input value={highlightQuery} onChange={event => setHighlightQuery(event.target.value)} placeholder="搜索原文、备注或标签…"/>{highlightQuery && <button onClick={() => setHighlightQuery('')}>×</button>}</div>
      <div>{visibleHighlights.map(item => <article key={item.id}>
        <button className="highlight-jump" onClick={() => {changePage(item.page_number); setHighlightOpen(false);}}><strong>第 {item.page_number} 页</strong><span>{item.text}</span></button>
        {item.comment && <p className="highlight-comment">{item.comment}</p>}
        {!!item.tags?.length && <div className="annotation-tags">{item.tags.map(tag => <span key={tag}>#{tag}</span>)}</div>}
        {editingHighlight === item.id && <div className="highlight-editor"><textarea value={highlightComment} onChange={event => setHighlightComment(event.target.value)} placeholder="补充你的理解、疑问或提醒…"/><input value={highlightTags} onChange={event => setHighlightTags(event.target.value)} placeholder="标签，用逗号分隔"/><nav><button onClick={() => setEditingHighlight(null)}>取消</button><button className="accent" onClick={() => void saveHighlightDetails(item)}>保存</button></nav></div>}
        <footer>{item.rects.length ? <select value={item.color} onChange={event => void recolorHighlight(item, event.target.value as Highlight['color'])}><option value="yellow">黄色</option><option value="green">绿色</option><option value="blue">蓝色</option><option value="pink">粉色</option></select> : <span className="page-marker-label">★ 整页星标</span>}<button onClick={() => {setEditingHighlight(item.id); setHighlightComment(item.comment || ''); setHighlightTags((item.tags || []).join(', '));}}>备注</button>{item.rects.length > 0 && <button onClick={() => onAiAssist ? onAiAssist(item.text, 'explain') : onExcerpt(item.text)}>AI 研读</button>}<button onClick={() => void removeHighlight(item)}>删除</button></footer>
      </article>)}{!visibleHighlights.length && <p>{managedHighlights.length ? '没有匹配的高亮。' : '选中文本后可以创建高亮。'}</p>}</div>
    </div>}
    {sidebarMode && pdf && <aside className="reader-side-panel" aria-label="页面与目录导航">
      <header><nav><button className={sidebarMode === 'pages' ? 'active' : ''} aria-selected={sidebarMode === 'pages'} onClick={() => setSidebarMode('pages')}>页面</button><button className={sidebarMode === 'outline' ? 'active' : ''} aria-selected={sidebarMode === 'outline'} onClick={() => setSidebarMode('outline')}>目录</button></nav><span>{sidebarMode === 'pages' ? `${pageNumber} / ${pdf.numPages}` : `${outline.length} 项`}</span><button className="side-panel-collapse" aria-label="收起页面与目录导航" onClick={() => setSidebarMode(null)}>‹</button></header>
      {sidebarMode === 'pages' ? <div className="thumbnail-list" ref={thumbnailListRef}>{Array.from({length: pdf.numPages}, (_, index) => <PdfThumbnail key={index + 1} pdf={pdf} pageNumber={index + 1} current={pageNumber === index + 1} marked={highlights.some(item => item.page_number === index + 1 && item.rects.length === 0)} scrollRoot={thumbnailListRef} onSelect={changePage} onToggleMark={page => void togglePageMark(page)}/>)}</div> : <div className="side-outline-list">{outline.map((item, index) => <button key={`${item.title}-${index}`} style={{paddingLeft: `${12 + item.depth * 14}px`}} aria-current={item.page === pageNumber ? 'page' : undefined} onClick={() => changePage(item.page)}><span>{item.title}</span><small>{item.page}</small></button>)}{!outline.length && <p>尚未从教材书签建立目录。</p>}</div>}
    </aside>}
    {notePanelOpen && <aside className="reader-note-panel" aria-label="页边便签">
      <header><div><small>PDF 第 {pageNumber} 页</small><strong>页边便签</strong></div><button aria-label="关闭便签栏" onClick={() => setNotePanelOpen(false)}>×</button></header>
      <form onSubmit={event => {event.preventDefault(); const content = stickyDraft.trim(); if (!content || !onCreatePageNote) return; void onCreatePageNote(pageNumber, content).then(() => setStickyDraft('')).catch(() => undefined);}}>
        <textarea value={stickyDraft} onChange={event => setStickyDraft(event.target.value)} placeholder="记录这一页的想法、疑问或待办…"/>
        <button disabled={!stickyDraft.trim() || !onCreatePageNote}>添加便签</button>
      </form>
      <div className="page-sticky-list">{pageNotes.map(note => <article key={note.id}>
        <header><span>第 {note.page_number} 页</span><nav><button onClick={() => {setEditingStickyId(note.id); setEditingStickyContent(note.content);}}>编辑</button><button onClick={() => void onDeletePageNote?.(note).catch(() => undefined)}>删除</button></nav></header>
        {editingStickyId === note.id ? <div className="sticky-editor"><textarea value={editingStickyContent} onChange={event => setEditingStickyContent(event.target.value)}/><footer><button onClick={() => setEditingStickyId(null)}>取消</button><button disabled={!editingStickyContent.trim()} onClick={() => {if (!onUpdatePageNote) return; void onUpdatePageNote(note, editingStickyContent.trim()).then(() => setEditingStickyId(null)).catch(() => undefined);}}>保存</button></footer></div> : <p>{note.content}</p>}
      </article>)}{!pageNotes.length && <div className="empty-sticky"><span>便签会固定在当前 PDF 页旁边</span><small>翻到其他页面时，这里会显示对应页面的便签。</small></div>}</div>
    </aside>}
    {sourceTrace && sourceTrace.locations.length > 0 && <aside className="source-trace-bar" aria-label="原文溯源导航">
      <div><small>原文溯源 {sourceTrace.index + 1} / {sourceTrace.locations.length}</small><strong>PDF 第 {sourceTrace.locations[sourceTrace.index].page} 页</strong><span>{sourceTrace.locations[sourceTrace.index].snippet}</span></div>
      <nav><button className="trace-return" onClick={onSourceTraceReturn}>↩ 返回选中内容</button><button disabled={sourceTrace.index <= 0} onClick={() => moveToTrace(sourceTrace.index - 1)}>← 上一处</button><button disabled={sourceTrace.index >= sourceTrace.locations.length - 1} onClick={() => moveToTrace(sourceTrace.index + 1)}>下一处 →</button><button aria-label="关闭原文溯源" onClick={onSourceTraceClose}>×</button></nav>
    </aside>}
    <div
      ref={scrollRef}
      className="pdf-scroll"
      title="上下滚动连续阅读 PDF"
      onScroll={trackVisiblePage}
    >
      {error && <div className="pdf-status error">{error}</div>}
      {loading && <div className="pdf-status">正在载入 PDF…</div>}
      {pdf && Array.from({length: pdf.numPages}, (_, index) => {
        const continuousPage = index + 1;
        return <ContinuousPdfPage
          key={continuousPage}
          pdf={pdf}
          documentId={document.id}
          pageNumber={continuousPage}
          zoom={zoom}
          initialDimensions={initialPageDimensions}
          scrollRoot={scrollRef}
          highlights={highlights.filter(item => item.page_number === continuousPage)}
          regionMode={regionMode}
          region={region}
          annotationTool={annotationTool}
          annotationColor={annotationColor}
          annotationWidth={annotationWidth}
          annotationDraft={annotationDraft}
          onAnnotationDraft={setAnnotationDraft}
          onAnnotationSave={(page, points) => void saveInkAnnotation(page, points)}
          onAnnotationErase={(page, points, dimensions) => void eraseInkAt(page, points, dimensions)}
          pageTextCache={pageTextCache}
          ocrCache={ocrCache}
          onTextReady={handleTextReady}
          onOcrProgress={handleOcrProgress}
          onError={handlePageError}
          onMouseUp={captureSelection}
          onPointerDown={beginRegion}
          onPointerMove={moveRegion}
          onPointerUp={finishRegion}
        />;
      })}
    </div>
    {selection && <div className="selection-actions"><span>已选择 {selection.text.length} 字</span><button onClick={() => void copySelection()}>{copied ? '已复制' : '复制'}</button><details><summary>AI 研读</summary><div className="selection-ai-menu"><button onClick={() => onAiAssist?.(selection.text, 'explain')}>解释概念</button><button onClick={() => onAiAssist?.(selection.text, 'summary')}>提炼要点</button><button onClick={() => onAiAssist?.(selection.text, 'questions')}>生成问题</button><button onClick={() => onAiAssist?.(selection.text, 'connect')}>联系全书</button></div></details><button className="accent" onClick={saveHighlight}>高亮</button><button onClick={() => setSelection(null)}>×</button></div>}
  </div>;
}
