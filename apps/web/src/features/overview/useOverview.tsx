import React, {useEffect, useRef, useState} from 'react';
import {chapterKey, chapterPlan as planChapter} from '../../chapters';
import {reconcileOutline, getImportedOutline, importLearningStructure, listChapterSummaries, listSummaryGaps, saveChapterSummary, listOcrPages, createSummaryTask, pauseSummaryTask,
 type ChapterSummary, type SummaryGap, type DocumentRecord, type BackgroundTask, type Note, type Flashcard} from '../../api';
import type {OutlineEntry} from '../../pdfOutline';
import type {SourceTraceLocation, SourceTraceNavigation} from '../../PdfPages';
import {useDocumentScope} from '../../shared/useDocumentScope';
import {parseLearningStructureImport} from '../../summaryImport';
import {useAutoDismiss} from '../../useAutoDismiss';
import {SummaryContent} from '../../StructuredContent';
import {locateSummarySources} from '../summary/sourceTrace';
const loadPdfOutline: typeof import('../../pdfOutline').loadPdfOutline = async (...args) => (await import('../../pdfOutline')).loadPdfOutline(...args);
const collectChapterSource: typeof import('../../chapterSummary').collectChapterSource = async (...args) => (await import('../../chapterSummary')).collectChapterSource(...args);
export function describeTaskError(message: string): string {
  if (/peer closed connection|incomplete chunked read/i.test(message)) return '模型连接提前中断，回答未完整接收。已完成分块已保留，请在任务中心重新执行。';
  if (/request burst|traffic growth|RequestBurstTooFast/i.test(message)) return '模型服务触发请求突增保护，需要等待冷却。已完成分块保留，请稍后重新执行，避免连续点击重试。';
  return message;
}

type BookGenerationState = 'idle' | 'running' | 'pausing' | 'paused' | 'cancelled';
type BookGenerationTask = {mode: 'running' | 'paused' | 'cancelled'; controller: AbortController};
type SummarySelection = {text: string; summary: ChapterSummary};
type ReturnedSummarySelection = {text: string; summaryKey: string};
function ensureBookGenerationActive(task?: BookGenerationTask) {
  if (!task) return;
  if (task.mode === 'cancelled' || task.controller.signal.aborted) {
    throw new DOMException('全书结构生成已取消', 'AbortError');
  }
  if (task.mode === 'paused') {
    const error = new Error('全书结构生成已暂停');
    error.name = 'BookGenerationPaused';
    throw error;
  }
}

type Options = {activeDocument: DocumentRecord | null; activeProfile: string; currentPage: number; screen: string; backgroundTasks: BackgroundTask[]; setBackgroundTasks: React.Dispatch<React.SetStateAction<BackgroundTask[]>>; setTaskCenterOpen: (value: boolean) => void; setError: (message: string) => void; notes: Note[]; flashcards: Flashcard[]; enterReader: (document?: DocumentRecord | null, page?: number) => void; goBack: () => void; refreshTasksNow: () => Promise<void>; cancelTask: (id: string) => Promise<void>};
type Dependencies = {loadOutline: typeof loadPdfOutline; collectSource: typeof collectChapterSource};
export function useOverview({activeDocument, activeProfile, currentPage, screen, backgroundTasks, setBackgroundTasks, setTaskCenterOpen, setError, notes, flashcards, enterReader, goBack, refreshTasksNow, cancelTask}: Options, dependencies: Dependencies = {loadOutline: loadPdfOutline, collectSource: collectChapterSource}) {
  const capture = useDocumentScope(activeDocument?.id);
  const outlineEpoch = useRef(0), traceEpoch = useRef(0);
  const importing = useRef<object | null>(null);
  const [chapters, setChapters] = useState<OutlineEntry[]>([]);
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [selectedChapterIndex, setSelectedChapterIndex] = useState(-1);
  const [chapterSummaries, setChapterSummaries] = useState<ChapterSummary[]>([]);
  const [summaryGaps, setSummaryGaps] = useState<SummaryGap[]>([]);
  const [chapterSummaryBusy, setChapterSummaryBusy] = useState('');
  const [chapterSummaryProgress, setChapterSummaryProgress] = useState('');
  const [chapterSummaryDraft, setChapterSummaryDraft] = useState('');
  const [chapterSummaryError, setChapterSummaryError] = useState('');
  const [structureImportStatus, setStructureImportStatus] = useState('');
  const [bookGenerationState, setBookGenerationState] = useState<BookGenerationState>('idle');
  const [generationScope, setGenerationScope] = useState<'book' | 'chapter' | null>(null);
  const [generationTargetKey, setGenerationTargetKey] = useState('');
  const [summarySelection, setSummarySelection] = useState<SummarySelection | null>(null);
  const [traceLocations, setTraceLocations] = useState<SourceTraceLocation[]>([]);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState('');
  const [sourceTrace, setSourceTrace] = useState<SourceTraceNavigation | null>(null);
  const [returnedSummarySelection, setReturnedSummarySelection] = useState<ReturnedSummarySelection | null>(null);
  const structureFileInput = useRef<HTMLInputElement>(null);
  const gapFileInput = useRef<HTMLInputElement>(null);
  const gapImportTarget = useRef<{documentId: string; gap: SummaryGap} | null>(null);
  const bookGenerationTask = useRef<BookGenerationTask | null>(null);

  useEffect(() => {
    importing.current = null; outlineEpoch.current++; traceEpoch.current++;
    setChapters([]); setChaptersLoading(false); setSelectedChapterIndex(-1); setChapterSummaries([]); setSummaryGaps([]);
    setChapterSummaryBusy(''); setChapterSummaryProgress(''); setChapterSummaryError(''); setStructureImportStatus('');
    setBookGenerationState('idle'); setGenerationScope(null); setGenerationTargetKey('');
    setSummarySelection(null); setTraceLocations([]); setTraceLoading(false); setTraceError(''); setSourceTrace(null); setReturnedSummarySelection(null);
    return () => {bookGenerationTask.current?.controller.abort(); bookGenerationTask.current = null;};
  }, [activeDocument?.id]);
  useAutoDismiss(chapterSummaryError, () => setChapterSummaryError(''));
  useAutoDismiss(traceError, () => setTraceError(''));
  useAutoDismiss(structureImportStatus, () => setStructureImportStatus(''), 5000);
  useEffect(() => {
    if (!activeDocument || bookGenerationTask.current || importing.current) return;
    const tasks = backgroundTasks.filter(task => task.document_id === activeDocument.id && task.task_type === 'structure-summary');
    const task = tasks.find(item => ['queued', 'running', 'cancelling'].includes(item.status)) || tasks[0];
    if (!task) {
      setChapterSummaryBusy(''); setGenerationScope(null); setBookGenerationState('idle'); setGenerationTargetKey(''); setChapterSummaryProgress('');
      return;
    }
    const options = (task.result as {summary_request?: {chapter_index: number | null; outline: OutlineEntry[]}}).summary_request;
    const scope = options?.chapter_index === null ? 'book' : 'chapter';
    const targetKey = scope === 'book' ? `${activeDocument.id}:__book__` : options?.chapter_index != null && options?.outline ? chapterKey(activeDocument.id, options.outline, options.chapter_index) : '';
    const running = ['queued', 'running', 'cancelling'].includes(task.status);
    setChapterSummaryBusy(running ? targetKey : '');
    setGenerationScope(running || task.status === 'paused' ? scope : null);
    setGenerationTargetKey(targetKey);
    setBookGenerationState(task.status === 'paused' ? 'paused' : running ? 'running' : 'idle');
    setChapterSummaryProgress(`${task.message} · ${task.progress}/${task.total || '?'}`);
    if (task.status === 'failed') setChapterSummaryError(describeTaskError(task.error || task.message));
    let alive = true;
    const epoch = outlineEpoch.current;
    Promise.all([listChapterSummaries(activeDocument.id), listSummaryGaps(activeDocument.id).catch(() => [])]).then(([items, gaps]) => { if (alive && epoch === outlineEpoch.current) { setChapterSummaries(items); setSummaryGaps(gaps); } }).catch(() => undefined);
    return () => { alive = false; };
  }, [backgroundTasks, activeDocument?.id]);

  useEffect(() => {
    setSummaryGaps([]);
    if (!activeDocument) return;
    let alive = true;
    listSummaryGaps(activeDocument.id).then(gaps => { if (alive) setSummaryGaps(gaps); }).catch(() => undefined);
    return () => { alive = false; };
  }, [activeDocument?.id]);

  useEffect(() => {
    if (screen !== 'overview' || !activeDocument) return;
    let alive = true;
    const epoch = ++outlineEpoch.current;
    const visit = capture();
    const valid = () => alive && visit() && epoch === outlineEpoch.current;
    setChaptersLoading(true);
    setChapters([]);
    setSelectedChapterIndex(-1);
    Promise.all([
      dependencies.loadOutline(activeDocument.id),
      getImportedOutline(activeDocument.id).catch(() => []),
    ])
      .then(([pdfItems, importedItems]) => {
        if (!valid()) return;
        const items: OutlineEntry[] = importedItems.length ? importedItems.map(item => ({title: item.title, page: item.page, depth: item.depth})) : pdfItems;
        setChapters(items);
        void reconcileOutline(activeDocument.id, items).then(result => {
          if (valid()) {setChapterSummaries(result.summaries); setSummaryGaps(result.gaps);}
        }).catch(reason => {if (valid()) setError(reason.message);});
        const readingChapter = items.reduce((matched, chapter, index) => chapter.page <= currentPage ? index : matched, -1);
        setSelectedChapterIndex(readingChapter >= 0 ? readingChapter : items.length ? 0 : -1);
      })
      .catch(reason => { if (valid()) setError(reason instanceof Error ? reason.message : '章节目录加载失败'); })
      .finally(() => { if (valid()) setChaptersLoading(false); });
    return () => { alive = false; };
  }, [activeDocument?.id, screen]);

  useEffect(() => {
    if (screen !== 'overview' || !returnedSummarySelection) return;
    const timer = window.setTimeout(() => document.querySelector<HTMLElement>('[data-summary-return="true"]')?.scrollIntoView({behavior: 'smooth', block: 'center'}), 80);
    return () => window.clearTimeout(timer);
  }, [returnedSummarySelection, screen, selectedChapterIndex]);

  const importGapSummary = async (file?: File) => {
    const target = gapImportTarget.current;
    if (!file || !target || target.documentId !== activeDocument?.id) return;
    const visit = capture(), epoch = outlineEpoch.current;
    const valid = () => visit() && epoch === outlineEpoch.current && gapImportTarget.current === target;
    try {
      const content = (await file.text()).trim();
      if (!content || content.length > 50000) throw new Error('请选择1至50000字的 Markdown 或 TXT 人工总结。');
      if (!valid()) throw new Error('教材已切换，请重新选择要补充的章节。');
      const index = chapters.findIndex((_, i) => chapterKey(target.documentId, chapters, i) === target.gap.chapter_key);
      await saveChapterSummary(target.documentId, {...target.gap, depth: Number.isInteger(index) ? chapters[index]?.depth || 0 : 0, content});
      const [summaries, gaps] = await Promise.all([listChapterSummaries(target.documentId), listSummaryGaps(target.documentId)]);
      if (valid()) {
        setChapterSummaries(summaries); setSummaryGaps(gaps);
        setStructureImportStatus(`已补充“${target.gap.title}”。可重新执行全书结构以更新上级汇总；本次未调用模型。`);
      }
    } catch (reason) {
      if (!valid()) return;
      setChapterSummaryError(reason instanceof Error ? reason.message : '补充总结失败');
    } finally {
      if (valid()) {if (gapFileInput.current) gapFileInput.current.value = ''; gapImportTarget.current = null;}
    }
  };

  const importLearningStructureFile = async (file?: File) => {
    if (!file || !activeDocument || importing.current) return;
    if (bookGenerationTask.current) {setChapterSummaryError('请先暂停原文准备，再导入目录。'); return;}
    const valid = capture();
    const token = {}; importing.current = token;
    outlineEpoch.current++; setChaptersLoading(false);
    setChapterSummaryError('');
    setStructureImportStatus('正在读取外部结构文件…');
    try {
      const text = await file.text();
      if (!valid()) return;
      const parsed = parseLearningStructureImport(text, activeDocument.id, chapters);
      const imported = await importLearningStructure(activeDocument.id, parsed.outline, parsed.summaries);
      if (!valid()) return;
      outlineEpoch.current++;
      const nextOutline: OutlineEntry[] = imported.outline.map(item => ({title: item.title, page: item.page, depth: item.depth}));
      setChapters(nextOutline);
      setChapterSummaries(imported.summaries);
      const gaps = await listSummaryGaps(activeDocument.id);
      if (!valid()) return;
      setSummaryGaps(gaps);
      setSelectedChapterIndex(index => index >= 0 && index < nextOutline.length ? index : nextOutline.length ? 0 : -1);
      setBookGenerationState('idle');
      setGenerationScope(null);
      setGenerationTargetKey('');
      setStructureImportStatus(
        `导入完成：识别 ${parsed.recognizedChapters} 个章节，载入 ${parsed.importedSummaries} 个章节总结；本次未调用 AI。`,
      );
    } catch (reason) {
      if (!valid()) return;
      setStructureImportStatus('');
      setChapterSummaryError(reason instanceof Error ? reason.message : '学习结构导入失败');
    } finally {
      if (importing.current === token) importing.current = null;
      if (valid() && structureFileInput.current) structureFileInput.current.value = '';
    }
  };

  const captureSummarySelection = (event: React.MouseEvent<HTMLElement>, summary: ChapterSummary) => {
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, ' ').trim() || '';
    if (!selection || selection.rangeCount === 0 || text.length < 2 || !event.currentTarget.contains(selection.anchorNode)) {
      setSummarySelection(null);
      return;
    }
    traceEpoch.current++; setTraceLoading(false);
    setTraceLocations([]);
    setTraceError('');
    setSummarySelection({text: text.slice(0, 500), summary});
  };
  const findSummarySources = async () => {
    if (!activeDocument || !summarySelection || traceLoading) return;
    const visit = capture();
    const epoch = ++traceEpoch.current;
    const valid = () => visit() && epoch === traceEpoch.current;
    setTraceLoading(true); setTraceError(''); setTraceLocations([]);
    try {
      const pages = await listOcrPages(activeDocument.id);
      if (!valid()) return;
      const locations = locateSummarySources(summarySelection.text, pages, summarySelection.summary.start_page, summarySelection.summary.end_page);
      setTraceLocations(locations);
      if (!locations.length) setTraceError('在已建立的原文索引中没有找到可靠来源。可尝试选择包含核心概念的完整句子。');
    } catch (reason) {
      if (!valid()) return;
      setTraceError(reason instanceof Error ? reason.message : '原文溯源失败');
    } finally { if (valid()) setTraceLoading(false); }
  };
  const openTraceLocation = (index: number) => {
    if (!activeDocument || !summarySelection || !traceLocations[index]) return;
    setSourceTrace({query: summarySelection.text, summaryKey: summarySelection.summary.chapter_key, locations: traceLocations, index});
    window.getSelection()?.removeAllRanges();
    setSummarySelection(null); setTraceLocations([]); setTraceError('');
    enterReader(activeDocument, traceLocations[index].page);
  };
  const returnToSelectedSummary = () => {
    if (!sourceTrace) return;
    const chapterIndex = chapters.findIndex((_, index) => chapterKey(activeDocument!.id, chapters, index) === sourceTrace.summaryKey);
    if (Number.isInteger(chapterIndex) && chapterIndex >= 0) setSelectedChapterIndex(chapterIndex);
    setReturnedSummarySelection({text: sourceTrace.query, summaryKey: sourceTrace.summaryKey});
    setSourceTrace(null);
    goBack();
  };
  const renderSummaryText = (value: string | undefined, summaryKey: string) => {
    const highlight = returnedSummarySelection?.summaryKey === summaryKey ? returnedSummarySelection.text : undefined;
    return <SummaryContent value={value} highlight={highlight}/>;
  };
  const chapterPlan = (index: number) => planChapter(chapters, index);
  const selectedChapter = selectedChapterIndex >= 0 ? chapters[selectedChapterIndex] : undefined;
  const selectedChapterKey = activeDocument && selectedChapter ? chapterKey(activeDocument.id, chapters, selectedChapterIndex) : '';
  const selectedPlan = selectedChapter ? chapterPlan(selectedChapterIndex) : undefined;
  const requestedChapterEndPage = selectedPlan?.endPage;
  const chapterChildren = selectedPlan?.childIndices.map(index => chapters[index]) || [];
  const chapterKind = chapterChildren.length ? '大章' : '小章';
  const selectedChapterSummary = chapterSummaries.find(item => item.chapter_key === selectedChapterKey);
  const selectedChapterGenerated = Boolean(selectedChapterSummary);
  const selectedChapterTask = generationScope === 'chapter' && generationTargetKey === selectedChapterKey;
  const selectedChapterTaskStopped = selectedChapterTask && (bookGenerationState === 'paused' || bookGenerationState === 'cancelled');
  const bookSummaryKey = activeDocument ? `${activeDocument.id}:__book__` : '';
  const bookSummary = chapterSummaries.find(item => item.chapter_key === bookSummaryKey);
  const nextChapterPage = selectedChapter ? chapters.slice(selectedChapterIndex + 1).find(chapter => chapter.page > selectedChapter.page)?.page : undefined;
  const chapterNotes = selectedChapter ? notes.filter(note => note.page_number && note.page_number >= selectedChapter.page && (!nextChapterPage || note.page_number < nextChapterPage)) : [];
  const chapterFlashcards = selectedChapter ? flashcards.filter(card => card.page_number && card.page_number >= selectedChapter.page && (!nextChapterPage || card.page_number < nextChapterPage)) : [];
  const currentSummaryTask = backgroundTasks.find(task => task.document_id === activeDocument?.id && task.task_type === 'structure-summary' && ['queued', 'running', 'cancelling'].includes(task.status)) || backgroundTasks.find(task => task.document_id === activeDocument?.id && task.task_type === 'structure-summary' && task.status === 'paused');
  const startSummaryTask = async (chapterIndex: number | null) => {
    if (!activeDocument || !activeProfile || !chapters.length || chapterSummaryBusy || bookGenerationTask.current || importing.current) return;
    const valid = capture();
    const task: BookGenerationTask = {mode: 'running', controller: new AbortController()};
    bookGenerationTask.current = task;
    setTaskCenterOpen(true);
    setChapterSummaryBusy(chapterIndex === null ? bookSummaryKey : selectedChapterKey);
    setGenerationScope(chapterIndex === null ? 'book' : 'chapter');
    setGenerationTargetKey(chapterIndex === null ? bookSummaryKey : selectedChapterKey);
    setBookGenerationState('running'); setChapterSummaryError(''); setChapterSummaryDraft('');
    try {
      const start = chapterIndex === null ? 1 : chapters[chapterIndex].page;
      const end = chapterIndex === null ? undefined : chapterPlan(chapterIndex).endPage;
      // Preserve browser OCR before handing model generation to the durable server queue.
      await dependencies.collectSource(activeDocument.id, start, end, progress => valid() && setChapterSummaryProgress(
        `准备原文（提交后台前）· PDF ${progress.page} · ${progress.completed}/${progress.total}${progress.phase === 'ocr' ? ' · OCR识别中' : ''}`,
      ), task.controller.signal);
      if (!valid()) return;
      ensureBookGenerationActive(task);
      const queued = await createSummaryTask(activeDocument.id, activeProfile, chapters.map(({title, page, depth}) => ({title, page, depth})), chapterIndex);
      setBackgroundTasks(items => [queued, ...items.filter(item => item.id !== queued.id)]);
      if (!valid()) return;
      setChapterSummaryProgress('已提交后台生成，可在任务中心查看进度。');
      setTaskCenterOpen(true);
    } catch (reason) {
      if (!valid()) return;
      setChapterSummaryError(reason instanceof Error ? reason.message : '总结任务提交失败');
      setChapterSummaryBusy(''); setBookGenerationState('idle');
    } finally {
      if (bookGenerationTask.current === task) bookGenerationTask.current = null;
    }
  };
  const generateChapterStructure = () => startSummaryTask(selectedChapterIndex);
  const generateBookStructure = () => startSummaryTask(null);
  const pauseBookStructure = async () => {
    if (currentSummaryTask) {
      try { await pauseSummaryTask(currentSummaryTask.id); await refreshTasksNow(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : '暂停失败'); }
    } else if (bookGenerationTask.current) {
      bookGenerationTask.current.controller.abort();
    }
  };
  const cancelBookStructure = async () => {
    if (currentSummaryTask) await cancelTask(currentSummaryTask.id);
    else bookGenerationTask.current?.controller.abort();
  };
  return {importGapSummary, importLearningStructureFile, chapters, setChapters, chaptersLoading, setChaptersLoading, selectedChapterIndex, setSelectedChapterIndex, chapterSummaries, setChapterSummaries, summaryGaps, setSummaryGaps, chapterSummaryBusy, setChapterSummaryBusy, chapterSummaryProgress, setChapterSummaryProgress, chapterSummaryDraft, setChapterSummaryDraft, chapterSummaryError, setChapterSummaryError, structureImportStatus, setStructureImportStatus, bookGenerationState, setBookGenerationState, generationScope, setGenerationScope, generationTargetKey, setGenerationTargetKey, summarySelection, setSummarySelection, traceLocations, setTraceLocations, traceLoading, setTraceLoading, traceError, setTraceError, sourceTrace, setSourceTrace, returnedSummarySelection, setReturnedSummarySelection, structureFileInput, gapFileInput, gapImportTarget, bookGenerationTask, captureSummarySelection, findSummarySources, openTraceLocation, returnToSelectedSummary, renderSummaryText, chapterPlan, selectedChapter, selectedChapterKey, selectedPlan, requestedChapterEndPage, chapterChildren, chapterKind, selectedChapterSummary, selectedChapterGenerated, selectedChapterTask, selectedChapterTaskStopped, bookSummaryKey, bookSummary, nextChapterPage, chapterNotes, chapterFlashcards, currentSummaryTask, startSummaryTask, generateChapterStructure, generateBookStructure, pauseBookStructure, cancelBookStructure};
}
