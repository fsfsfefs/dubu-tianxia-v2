import {useNotes} from './features/notes/useNotes';
import {reconcileOutline} from './api';
import {TaskCenter} from './features/tasks/TaskCenter';
import {ModelSettings} from './features/settings/ModelSettings';
import {chapterKey, chapterPlan as planChapter} from './chapters';
import React, {useEffect, useRef, useState} from 'react';
import {
  ChapterSummary, ChatMessage, CitationVerification, clearChatMessages, createFlashcard, createFolder, createNote, deleteDocument, deleteFlashcard,
  deleteFolder, DocumentRecord, exportAllData, Flashcard, FolderRecord, generateFlashcards, listChatMessages,
  listChapterSummaries, listDocuments, listFlashcards, listFolders, listNotes, listOcrPages, listProfiles, ModelProfile, moveDocument, Note, OcrPage, renameDocument, renameFolder,
  RagSource, RagStatus, reviewFlashcard, saveChapterSummary, streamAnswer, updateFlashcard, uploadDocument, WebSource,
  } from './api';
import {getImportedOutline, importLearningStructure} from './api';
import {downloadFullBackup, restoreFullBackup} from './api';
import {BackgroundTask, cancelBackgroundTask, clearFinishedBackgroundTasks, createIndexTasks, listBackgroundTasks, retryBackgroundTask} from './api';
import './styles/foundation.css';
import './styles/workspace.css';
import './styles/library.css';
import './styles/learning.css';
import './embedding-settings.css';
import './structure-import.css';
import './styles/editorial.css';
import './overview-scroll.css';
import {PdfReader, SourceTraceLocation, SourceTraceNavigation} from './PdfReader';
import './task-center.css';
import './styles/annotations.css';
import './resizable-panels.css';
import {loadPdfOutline, OutlineEntry} from './pdfOutline';
import {collectChapterSource} from './chapterSummary';
import {createSummaryTask, pauseSummaryTask, listSummaryGaps, SummaryGap} from './api';
import {ensureFullDocumentIndex, RagIndexProgress} from './ragIndex';
import {parseLearningStructureImport} from './summaryImport';
import {useAutoDismiss} from './useAutoDismiss';
import {AnswerContent, SummaryContent} from './StructuredContent';
import {AgentProgress} from './api';
import './reading-agent.css';
import './structured-content.css';

function describeTaskError(message: string): string {
  if (/peer closed connection|incomplete chunked read/i.test(message)) return '模型连接提前中断，回答未完整接收。已完成分块已保留，请在任务中心重新执行。';
  if (/request burst|traffic growth|RequestBurstTooFast/i.test(message)) return '模型服务触发请求突增保护，需要等待冷却。已完成分块保留，请稍后重新执行，避免连续点击重试。';
  return message;
}

type Message = Pick<ChatMessage, 'role' | 'content'>;
type Screen = 'home' | 'overview' | 'reader' | 'memory';
type BookGenerationState = 'idle' | 'running' | 'pausing' | 'paused' | 'cancelled';
type BookGenerationTask = {mode: 'running' | 'paused' | 'cancelled'; controller: AbortController};
type SummarySelection = {text: string; summary: ChapterSummary};
type ReturnedSummarySelection = {text: string; summaryKey: string};
type NavigationEntry = {
  screen: Screen;
  documentId: string | null;
  currentPage: number;
  memoryBookOpen: boolean;
  memoryMode: 'body' | 'practice';
  assistantOpen: boolean;
};

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

function normalizeTraceText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s，。！？；：、“”‘’（）()【】\[\]《》<>…·—_\-]/g, '');
}

function traceTerms(value: string): string[] {
  const normalized = normalizeTraceText(value);
  const terms = new Set<string>();
  for (const word of value.toLocaleLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) || []) terms.add(word);
  for (const run of normalized.match(/[\u3400-\u9fff]{2,}/g) || []) {
    if (run.length <= 8) terms.add(run);
    for (const size of [6, 5, 4, 3]) {
      if (run.length < size) continue;
      const step = size >= 5 ? 2 : 3;
      for (let index = 0; index <= run.length - size; index += step) terms.add(run.slice(index, index + size));
    }
  }
  return [...terms].sort((left, right) => right.length - left.length).slice(0, 48);
}

function traceSnippet(source: string, terms: string[]): string {
  const text = source.replace(/\s+/g, ' ').trim();
  const lower = text.toLocaleLowerCase();
  const term = terms.find(item => normalizeTraceText(text).includes(normalizeTraceText(item)));
  let index = term ? lower.indexOf(term.toLocaleLowerCase()) : 0;
  if (term && index < 0) {
    const compactIndex = normalizeTraceText(text).indexOf(normalizeTraceText(term));
    let compactOffset = 0;
    index = 0;
    while (index < text.length && compactOffset < compactIndex) {
      compactOffset += normalizeTraceText(text[index]).length;
      index += 1;
    }
  }
  const start = Math.max(0, index - 42);
  const end = Math.min(text.length, index + Math.max(term?.length || 0, 100));
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function locateSummarySources(selection: string, pages: OcrPage[], startPage: number, endPage: number): SourceTraceLocation[] {
  const compactSelection = normalizeTraceText(selection);
  const terms = traceTerms(selection);
  const candidates = pages.filter(page => page.page_number >= startPage && page.page_number <= endPage).map(page => {
    const compactPage = normalizeTraceText(page.text);
    const exact = compactSelection.length >= 4 && compactPage.includes(compactSelection);
    const matchedTerms = terms.filter(term => compactPage.includes(normalizeTraceText(term)));
    const score = (exact ? 10000 + compactSelection.length * 20 : 0) + matchedTerms.reduce((total, term) => total + term.length * term.length, 0);
    return {page: page.page_number, snippet: traceSnippet(page.text, matchedTerms), score, exact};
  }).filter(item => item.score > 0);
  const exactMatches = candidates.filter(item => item.exact);
  if (exactMatches.length) return exactMatches.map(({page, snippet, score}) => ({page, snippet, score})).sort((a, b) => a.page - b.page);
  const maximum = Math.max(0, ...candidates.map(item => item.score));
  return candidates.filter(item => item.score >= Math.max(18, maximum * .52)).sort((a, b) => b.score - a.score || a.page - b.page).slice(0, 12).map(({page, snippet, score}) => ({page, snippet, score}));
}

function clampPanelSize(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function storedPanelSize(key: string, fallback: number): number {
  const value = Number(window.localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function storedPanelCollapsed(key: string): boolean {
  return window.localStorage.getItem(key) === 'true';
}

export function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [navigationStack, setNavigationStack] = useState<NavigationEntry[]>([]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [memoryBookOpen, setMemoryBookOpen] = useState(false);
  const [memoryMode, setMemoryMode] = useState<'body' | 'practice'>('body');
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<'all' | 'unfiled' | string>('all');
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [activeDocument, setActiveDocument] = useState<DocumentRecord | null>(null);
  const [activeProfile, setActiveProfile] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [includeCurrentExcerpt, setIncludeCurrentExcerpt] = useState(true);
  const [multiBookMode, setMultiBookMode] = useState(false);
  const [selectedBookIds, setSelectedBookIds] = useState<string[]>([]);
  const [useWebVerification, setUseWebVerification] = useState(true);
  const [indexingBookTitle, setIndexingBookTitle] = useState('');
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [assistantMessages, setAssistantMessages] = useState<Message[]>([]);
  const [flashcards, setFlashcards] = useState<Flashcard[]>([]);
  const [panelMode, setPanelMode] = useState<'chat' | 'master' | 'notes' | 'cards'>('chat');
  const [currentPage, setCurrentPage] = useState(1);
  const [readerPageRevision, setReaderPageRevision] = useState(0);
  const [readerRestorePosition, setReaderRestorePosition] = useState(true);
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
  const [floatingCardId, setFloatingCardId] = useState<string | null>(null);
  const [floatingCardOffset, setFloatingCardOffset] = useState({x: 0, y: 0});
  const [recognizedCardCount, setRecognizedCardCount] = useState(0);
  const cardDrag = useRef<{x: number; y: number; offsetX: number; offsetY: number} | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualQuestion, setManualQuestion] = useState('');
  const [manualAnswer, setManualAnswer] = useState('');
  const [deepAnswer, setDeepAnswer] = useState(false);
  const [agentEvents, setAgentEvents] = useState<AgentProgress[]>([]);
  const askController = useRef<AbortController | null>(null);
  const askDocumentId = useRef(activeDocument?.id);
  askDocumentId.current = activeDocument?.id;
  useEffect(() => {
    setAgentEvents([]);
    return () => { askController.current?.abort(); };
  }, [activeDocument?.id]);
  const [backupBusy, setBackupBusy] = useState(false);
  const [ragProgress, setRagProgress] = useState<RagIndexProgress | null>(null);
  const [ragSources, setRagSources] = useState<RagSource[]>([]);
  const [ragStatus, setRagStatus] = useState<RagStatus | null>(null);
  const [webSources, setWebSources] = useState<WebSource[]>([]);
  const [citationVerification, setCitationVerification] = useState<CitationVerification | null>(null);
  const [verificationRunning, setVerificationRunning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [error, setError] = useState('');
  const {notes, setNotes, noteDraft, setNoteDraft, noteTitle, setNoteTitle, noteTags, setNoteTags, noteSearch, setNoteSearch, editingNote, setEditingNote, editingContent, setEditingContent, editingTitle, setEditingTitle, editingTags, setEditingTags, addNote, removeNote, createPageStickyNote, updatePageStickyNote, deletePageStickyNote, saveEditedNote, toggleNotePinned, exportNotes} = useNotes(activeDocument, currentPage, excerpt, setError);
  const [assistantWidth, setAssistantWidth] = useState(() => storedPanelSize('reader-layout-assistant-width', 430));
  const [excerptHeight, setExcerptHeight] = useState(() => storedPanelSize('reader-layout-excerpt-height', 150));
  const [composerHeight, setComposerHeight] = useState(() => storedPanelSize('reader-layout-composer-height', 92));
  const [assistantSetupCollapsed, setAssistantSetupCollapsed] = useState(() => storedPanelCollapsed('reader-layout-setup-collapsed'));
  const [questionContextCollapsed, setQuestionContextCollapsed] = useState(() => storedPanelCollapsed('reader-layout-context-collapsed'));
  const [excerptPanelCollapsed, setExcerptPanelCollapsed] = useState(() => storedPanelCollapsed('reader-layout-excerpt-collapsed'));
  const fileInput = useRef<HTMLInputElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const structureFileInput = useRef<HTMLInputElement>(null);
  const gapFileInput = useRef<HTMLInputElement>(null);
  const gapImportTarget = useRef<{documentId: string; gap: SummaryGap} | null>(null);
  const bookGenerationTask = useRef<BookGenerationTask | null>(null);

  useAutoDismiss(error, () => setError(''));
  useAutoDismiss(chapterSummaryError, () => setChapterSummaryError(''));
  useAutoDismiss(traceError, () => setTraceError(''));
  useAutoDismiss(structureImportStatus, () => setStructureImportStatus(''), 5000);
  useAutoDismiss(citationVerification?.warning, () => {
    setCitationVerification(current => current ? {...current, warning: ''} : current);
  });

  useEffect(() => { window.localStorage.setItem('reader-layout-assistant-width', String(assistantWidth)); }, [assistantWidth]);
  useEffect(() => { window.localStorage.setItem('reader-layout-excerpt-height', String(excerptHeight)); }, [excerptHeight]);
  useEffect(() => { window.localStorage.setItem('reader-layout-composer-height', String(composerHeight)); }, [composerHeight]);
  useEffect(() => { window.localStorage.setItem('reader-layout-setup-collapsed', String(assistantSetupCollapsed)); }, [assistantSetupCollapsed]);
  useEffect(() => { window.localStorage.setItem('reader-layout-context-collapsed', String(questionContextCollapsed)); }, [questionContextCollapsed]);
  useEffect(() => { window.localStorage.setItem('reader-layout-excerpt-collapsed', String(excerptPanelCollapsed)); }, [excerptPanelCollapsed]);

  const resizePanelByKeyboard = (panel: 'assistant' | 'excerpt' | 'composer', amount: number) => {
    if (panel === 'assistant') setAssistantWidth(value => clampPanelSize(value + amount, 340, Math.min(760, Math.max(340, window.innerWidth - 520))));
    if (panel === 'excerpt') setExcerptHeight(value => clampPanelSize(value + amount, 112, 360));
    if (panel === 'composer') setComposerHeight(value => clampPanelSize(value + amount, 76, 260));
  };

  const beginPanelResize = (event: React.PointerEvent<HTMLDivElement>, panel: 'assistant' | 'excerpt' | 'composer') => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = panel === 'assistant' ? assistantWidth : panel === 'excerpt' ? excerptHeight : composerHeight;
    document.body.classList.add('panel-resizing', panel === 'assistant' ? 'panel-resizing-horizontal' : 'panel-resizing-vertical');
    const onMove = (moveEvent: PointerEvent) => {
      if (panel === 'assistant') {
        const maximum = Math.min(760, Math.max(340, window.innerWidth - 520));
        setAssistantWidth(clampPanelSize(startSize + startX - moveEvent.clientX, 340, maximum));
      } else if (panel === 'excerpt') {
        setExcerptHeight(clampPanelSize(startSize + moveEvent.clientY - startY, 112, 360));
      } else {
        setComposerHeight(clampPanelSize(startSize + startY - moveEvent.clientY, 76, 260));
      }
    };
    const onEnd = () => {
      document.body.classList.remove('panel-resizing', 'panel-resizing-horizontal', 'panel-resizing-vertical');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  };

  const load = async () => {
    const [nextDocuments, nextProfiles, nextFolders] = await Promise.all([
      listDocuments(),
      listProfiles(),
      listFolders().catch(() => [] as FolderRecord[]),
    ]);
    setDocuments(nextDocuments);
    setProfiles(nextProfiles);
    setFolders(nextFolders);
    setActiveDocument(current => current || nextDocuments[0] || null);
    setActiveProfile(current => current || nextProfiles.find(item => item.is_default)?.id || nextProfiles[0]?.id || '');
  };

  useEffect(() => { load().catch(error => setError(error.message)); }, []);

  useEffect(() => {
    let alive = true;
    const refresh = () => listBackgroundTasks().then(tasks => {
      if (alive) setBackgroundTasks(tasks);
    }).catch(() => undefined);
    void refresh();
    const timer = window.setInterval(refresh, 1800);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!activeDocument || bookGenerationTask.current) return;
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
    Promise.all([listChapterSummaries(activeDocument.id), listSummaryGaps(activeDocument.id).catch(() => [])]).then(([items, gaps]) => { if (alive) { setChapterSummaries(items); setSummaryGaps(gaps); } }).catch(() => undefined);
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
    if (activeDocument) setSelectedBookIds(items => items.length ? items : [activeDocument.id]);
  }, [activeDocument?.id]);

  useEffect(() => {
    setAssistantMessages([]);
    setFloatingCardId(null);
    setFloatingCardOffset({x: 0, y: 0});
    setRecognizedCardCount(0);
    setIncludeCurrentExcerpt(true);
    setRagProgress(null); setRagSources([]); setRagStatus(null); setWebSources([]); setCitationVerification(null); setVerificationRunning(false);
    setSummarySelection(null); setTraceLocations([]); setTraceError(''); setSourceTrace(null);
    if (!activeDocument) { setMessages([]); setNotes([]); setFlashcards([]); setChapterSummaries([]); return; }
    Promise.all([listChatMessages(activeDocument.id), listNotes(activeDocument.id), listFlashcards(activeDocument.id), listChapterSummaries(activeDocument.id).catch(() => [])])
      .then(([history, savedNotes, savedCards, savedSummaries]) => { setMessages(history); setNotes(savedNotes); setFlashcards(savedCards); setChapterSummaries(savedSummaries); })
      .catch(reason => setError(reason instanceof Error ? reason.message : '学习数据加载失败'));
  }, [activeDocument]);

  useEffect(() => {
    if (screen !== 'overview' || !activeDocument) return;
    let alive = true;
    setChaptersLoading(true);
    setChapters([]);
    setSelectedChapterIndex(-1);
    Promise.all([
      loadPdfOutline(activeDocument.id),
      getImportedOutline(activeDocument.id).catch(() => []),
    ])
      .then(([pdfItems, importedItems]) => {
        if (!alive) return;
        const items: OutlineEntry[] = importedItems.length ? importedItems.map(item => ({title: item.title, page: item.page, depth: item.depth})) : pdfItems;
        setChapters(items);
        void reconcileOutline(activeDocument.id, items).then(result => {
          if (alive) {setChapterSummaries(result.summaries); setSummaryGaps(result.gaps);}
        }).catch(reason => {if (alive) setError(reason.message);});
        const readingChapter = items.reduce((matched, chapter, index) => chapter.page <= currentPage ? index : matched, -1);
        setSelectedChapterIndex(readingChapter >= 0 ? readingChapter : items.length ? 0 : -1);
      })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : '章节目录加载失败'); })
      .finally(() => { if (alive) setChaptersLoading(false); });
    return () => { alive = false; };
  }, [activeDocument, screen]);

  useEffect(() => {
    if (screen !== 'overview' || !returnedSummarySelection) return;
    const timer = window.setTimeout(() => document.querySelector<HTMLElement>('[data-summary-return="true"]')?.scrollIntoView({behavior: 'smooth', block: 'center'}), 80);
    return () => window.clearTimeout(timer);
  }, [returnedSummarySelection, screen, selectedChapterIndex]);

  const importPdf = async (file?: File) => {
    if (!file) return;
    setError('');
    try {
      let document = await uploadDocument(file);
      if (selectedFolderId !== 'all' && selectedFolderId !== 'unfiled') {
        document = await moveDocument(document.id, selectedFolderId);
      }
      await load();
      setActiveDocument(document);
    } catch (error) {
      setError(error instanceof Error ? error.message : '导入失败');
    }
  };

  const importGapSummary = async (file?: File) => {
    const target = gapImportTarget.current;
    if (!file || !target || target.documentId !== activeDocument?.id) return;
    try {
      const content = (await file.text()).trim();
      if (!content || content.length > 50000) throw new Error('请选择1至50000字的 Markdown 或 TXT 人工总结。');
      if (askDocumentId.current !== target.documentId) throw new Error('教材已切换，请重新选择要补充的章节。');
      const index = chapters.findIndex((_, i) => chapterKey(target.documentId, chapters, i) === target.gap.chapter_key);
      await saveChapterSummary(target.documentId, {...target.gap, depth: Number.isInteger(index) ? chapters[index]?.depth || 0 : 0, content});
      const [summaries, gaps] = await Promise.all([listChapterSummaries(target.documentId), listSummaryGaps(target.documentId)]);
      if (askDocumentId.current === target.documentId) {
        setChapterSummaries(summaries); setSummaryGaps(gaps);
        setStructureImportStatus(`已补充“${target.gap.title}”。可重新执行全书结构以更新上级汇总；本次未调用模型。`);
      }
    } catch (reason) {
      setChapterSummaryError(reason instanceof Error ? reason.message : '补充总结失败');
    } finally {
      if (gapFileInput.current) gapFileInput.current.value = '';
      gapImportTarget.current = null;
    }
  };

  const importLearningStructureFile = async (file?: File) => {
    if (!file || !activeDocument) return;
    setChapterSummaryError('');
    setStructureImportStatus('正在读取外部结构文件…');
    try {
      const text = await file.text();
      const parsed = parseLearningStructureImport(text, activeDocument.id, chapters);
      const imported = await importLearningStructure(activeDocument.id, parsed.outline, parsed.summaries);
      const nextOutline: OutlineEntry[] = imported.outline.map(item => ({title: item.title, page: item.page, depth: item.depth}));
      setChapters(nextOutline);
      setChapterSummaries(imported.summaries);
      setSummaryGaps(await listSummaryGaps(activeDocument.id));
      setSelectedChapterIndex(index => index >= 0 && index < nextOutline.length ? index : nextOutline.length ? 0 : -1);
      setBookGenerationState('idle');
      setGenerationScope(null);
      setGenerationTargetKey('');
      setStructureImportStatus(
        `导入完成：识别 ${parsed.recognizedChapters} 个章节，载入 ${parsed.importedSummaries} 个章节总结；本次未调用 AI。`,
      );
    } catch (reason) {
      setStructureImportStatus('');
      setChapterSummaryError(reason instanceof Error ? reason.message : '学习结构导入失败');
    } finally {
      if (structureFileInput.current) structureFileInput.current.value = '';
    }
  };

  const addFolder = async () => {
    const name = window.prompt('文件夹名称');
    if (!name?.trim()) return;
    try {
      const folder = await createFolder(name.trim());
      await load(); setSelectedFolderId(folder.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '创建文件夹失败'); }
  };

  const editFolder = async (folder: FolderRecord) => {
    const name = window.prompt('重命名文件夹', folder.name);
    if (!name?.trim() || name.trim() === folder.name) return;
    try { await renameFolder(folder.id, name.trim()); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '重命名文件夹失败'); }
  };

  const removeFolder = async (folder: FolderRecord) => {
    if (!window.confirm(`删除文件夹“${folder.name}”？其中的教材会回到“未分类”，不会被删除。`)) return;
    try {
      await deleteFolder(folder.id);
      if (selectedFolderId === folder.id) setSelectedFolderId('all');
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '删除文件夹失败'); }
  };

  const moveBookToFolder = async (document: DocumentRecord, folderId: string) => {
    try {
      const updated = await moveDocument(document.id, folderId || null);
      setDocuments(items => items.map(item => item.id === updated.id ? updated : item));
      setFolders(await listFolders());
      if (activeDocument?.id === updated.id) setActiveDocument(updated);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '移动教材失败'); }
  };

  const wholePdfQuestionContext = async () => {
    if (!activeDocument) throw new Error('请先打开一本教材。');
    const book = chapterSummaries.find(item => item.chapter_key === `${activeDocument.id}:__book__`);
    if (book?.content.trim()) return `【全书知识结构】\n${book.content}`.slice(0, 12000);
    return '';
  };

  const runAsk = async (prompt: string) => {
    if (!prompt.trim() || !activeProfile || busy) return;
    if (includeCurrentExcerpt && !excerpt.trim()) { setError('请选择或粘贴当前页原文，或者切换到“全书＋联网”模式。'); return; }
    const user = {role: 'user' as const, content: prompt.trim()};
    const master = panelMode === 'master';
    const conversation = master ? messages : assistantMessages;
    const update = master ? setMessages : setAssistantMessages;
    update(items => [...items, user, {role: 'assistant', content: ''}]);
    setQuestion('');
    setBusy(true);
    setError('');
    const controller = new AbortController();
    askController.current = controller;
    setAgentEvents([]);
    setRagSources([]); setRagStatus(null); setWebSources([]); setRagProgress(null); setCitationVerification(null); setVerificationRunning(false);
    try {
      const ragDocumentIds = multiBookMode ? selectedBookIds : activeDocument ? [activeDocument.id] : [];
      if (!includeCurrentExcerpt) {
        if (!ragDocumentIds.length) throw new Error('请至少选择一本教材。');
        for (const documentId of ragDocumentIds) {
          const document = documents.find(item => item.id === documentId);
          setIndexingBookTitle(document?.title || '教材');
          await ensureFullDocumentIndex(documentId, setRagProgress, controller.signal);
        }
        setIndexingBookTitle('');
      }
      const questionContext = includeCurrentExcerpt ? excerpt.trim() : await wholePdfQuestionContext();
      await streamAnswer({
        document_id: activeDocument?.id,
        document_ids: !includeCurrentExcerpt ? ragDocumentIds : undefined,
        profile_id: activeProfile,
        excerpt: questionContext,
        question: user.content,
        history: conversation.slice(-12),
        page_number: includeCurrentExcerpt ? currentPage : undefined,
        use_web: !includeCurrentExcerpt && useWebVerification,
        use_rag: !includeCurrentExcerpt,
        use_agent: !includeCurrentExcerpt && deepAnswer,
        verify_citations: !includeCurrentExcerpt,
        persist_history: master,
        max_tokens: includeCurrentExcerpt || deepAnswer ? undefined : Math.max(profiles.find(profile => profile.id === activeProfile)?.max_tokens || 2048, 8192),
      }, delta => update(items => {
        if (controller.signal.aborted || !items.length) return items;
        const next = [...items];
        next[next.length - 1] = {...next[next.length - 1], content: next[next.length - 1].content + delta};
        return next;
      }), controller.signal, (sources, status) => {setRagSources(sources); setRagStatus(status);}, (verification, running) => {
        setVerificationRunning(running);
        if (verification) setCitationVerification(verification);
      }, sources => setWebSources(sources), progress => setAgentEvents(items => [...items.slice(-19), progress]));
    } catch (error) {
      if (askDocumentId.current !== activeDocument?.id) return;
      if (controller.signal.aborted) {
        setAgentEvents(items => [...items, {stage: 'cancelled', message: '已取消本次问答，已停止后续调用；已显示的文字尚未完成核验。', model_calls: items.at(-1)?.model_calls || 0, max_model_calls: 4}]);
      } else {
        setError(error instanceof Error ? error.message : '模型请求失败');
        setAgentEvents(items => items.length ? [...items, {...items[items.length - 1], stage: 'error', message: '本次深度问答未完成，可重新发送问题重试。'}] : items);
      }
    } finally {
      askController.current = null;
      setVerificationRunning(false);
      setIndexingBookTitle('');
      setBusy(false);
    }
  };

  const ask = async () => runAsk(question);

  const startReadingAssist = (text: string, action: 'explain' | 'summary' | 'questions' | 'connect') => {
    const prompts = {
      explain: '请解释选中原文中的核心概念、关键术语和隐含逻辑，并给出一个易懂例子。',
      summary: '请将选中原文提炼为层次清晰的关键要点，并指出最值得记忆的结论。',
      questions: '请基于选中原文生成 3 个由浅入深的理解检查问题，并在每题后给出简要答案。',
      connect: `请结合整本教材，说明下面这段内容与其他章节的联系、前置知识和后续应用：${text.slice(0, 1600)}`,
    };
    setExcerpt(text);
    setIncludeCurrentExcerpt(action !== 'connect');
    setMultiBookMode(false);
    setPanelMode('chat');
    setQuestion(prompts[action]);
    setAssistantOpen(true);
  };

  const saveLastExplanation = async () => {
    if (!activeDocument) return;
    const conversation = panelMode === 'master' ? messages : assistantMessages;
    const answer = [...conversation].reverse().find(item => item.role === 'assistant' && item.content.trim());
    if (!answer) return;
    try {
      const note = await createNote(activeDocument.id, {page_number: currentPage, excerpt: excerpt.trim(), content: answer.content, title: 'AI 阅读辅助', tags: ['AI', '阅读辅助'], pinned: false});
      setNotes(items => [note, ...items]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '解释保存失败'); }
  };

  const clearConversation = async () => {
    const master = panelMode === 'master';
    const conversation = master ? messages : assistantMessages;
    if (!activeDocument || !conversation.length) return;
    if (!master) { setAssistantMessages([]); return; }
    if (!window.confirm('确定清空当前教材的 Master 对话记录吗？')) return;
    try { await clearChatMessages(activeDocument.id); setMessages([]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '清空失败'); }
  };

  const makeFlashcardsFromExcerpt = async (sourceText: string, page: number) => {
    if (!activeDocument || !activeProfile || !sourceText.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const created = await generateFlashcards(activeDocument.id, {profile_id: activeProfile, page_number: page, excerpt: sourceText.trim()});
      setFlashcards(items => [...created, ...items]);
      setRecognizedCardCount(created.length);
      if (created[0]) setFloatingCardId(created[0].id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '卡片生成失败'); }
    finally { setBusy(false); }
  };

  const makeFlashcards = async () => makeFlashcardsFromExcerpt(excerpt, currentPage);

  const handleRegionQuestions = (text: string, page: number) => {
    setExcerpt(text);
    setIncludeCurrentExcerpt(true);
    setMultiBookMode(false);
    setPanelMode('cards');
    setAssistantOpen(true);
    setRecognizedCardCount(0);
    if (!activeProfile) {
      setError('请先配置并选择用于识别题目的模型。');
      return;
    }
    void makeFlashcardsFromExcerpt(text, page);
  };

  const removeFlashcard = async (cardId: string) => {
    if (!activeDocument) return;
    try {
      await deleteFlashcard(activeDocument.id, cardId);
      setFlashcards(items => items.filter(item => item.id !== cardId));
      if (floatingCardId === cardId) setFloatingCardId(null);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : '删除失败'); }
  };

  const addManualCard = async () => {
    if (!activeDocument || !manualQuestion.trim() || !manualAnswer.trim()) return;
    try {
      const card = await createFlashcard(activeDocument.id, {page_number: currentPage, source_excerpt: excerpt.trim(), question: manualQuestion.trim(), answer: manualAnswer.trim()});
      setFlashcards(items => [card, ...items]); setManualQuestion(''); setManualAnswer('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '卡片保存失败'); }
  };

  const markCard = async (card: Flashcard, mastered: boolean) => {
    if (!activeDocument) return;
    try {
      const updated = await reviewFlashcard(activeDocument.id, card.id, mastered);
      setFlashcards(items => items.map(item => item.id === card.id ? updated : item));
    } catch (reason) { setError(reason instanceof Error ? reason.message : '复习状态保存失败'); }
  };

  const editCard = async (card: Flashcard) => {
    if (!activeDocument) return;
    const question = window.prompt('修改问题', card.question)?.trim();
    if (!question) return;
    const answer = window.prompt('修改答案', card.answer)?.trim();
    if (!answer) return;
    try {
      const updated = await updateFlashcard(activeDocument.id, card.id, question, answer);
      setFlashcards(items => items.map(item => item.id === card.id ? updated : item));
    } catch (reason) { setError(reason instanceof Error ? reason.message : '卡片更新失败'); }
  };


  const beginFloatingCardDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = {x: event.clientX, y: event.clientY, offsetX: floatingCardOffset.x, offsetY: floatingCardOffset.y};
    cardDrag.current = start;
    const onMove = (moveEvent: PointerEvent) => {
      const drag = cardDrag.current;
      if (!drag) return;
      const width = Math.min(390, window.innerWidth - 32);
      const initialLeft = window.innerWidth - width - 24;
      const left = Math.min(window.innerWidth - width - 8, Math.max(8, initialLeft + drag.offsetX + moveEvent.clientX - drag.x));
      const top = Math.min(window.innerHeight - 140, Math.max(58, 96 + drag.offsetY + moveEvent.clientY - drag.y));
      setFloatingCardOffset({x: left - initialLeft, y: top - 96});
    };
    const onEnd = () => {
      cardDrag.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
  };
  const renameBook = async (document: DocumentRecord) => {
    const title = window.prompt('新的文档名称', document.title)?.trim();
    if (!title) return;
    try {
      const updated = await renameDocument(document.id, title);
      setDocuments(items => items.map(item => item.id === updated.id ? updated : item));
      setActiveDocument(current => current?.id === updated.id ? updated : current);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '重命名失败'); }
  };

  const removeBook = async (document: DocumentRecord) => {
    if (!window.confirm(`确定删除《${document.title}》及其笔记、对话、高亮和卡片吗？`)) return;
    try {
      await deleteDocument(document.id);
      const remaining = documents.filter(item => item.id !== document.id);
      setDocuments(remaining); if (activeDocument?.id === document.id) setActiveDocument(remaining[0] || null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '删除失败'); }
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportBackup = async () => {
    if (backupBusy) return;
    setBackupBusy(true); setError('');
    try {
      const backup = await downloadFullBackup();
      downloadBlob(backup.blob, backup.filename);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '完整备份导出失败'); }
    finally { setBackupBusy(false); }
  };

  const exportJsonBackup = async () => {
    try {
      const data = await exportAllData();
      downloadBlob(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}), `reader-next-data-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '数据导出失败'); }
  };

  const restoreBackup = async (file?: File) => {
    if (!file || backupBusy) return;
    if (!window.confirm('恢复会替换当前教材、笔记、高亮、索引和本地向量模型。系统会先保存一份恢复前快照，是否继续？')) {
      if (backupInput.current) backupInput.current.value = '';
      return;
    }
    setBackupBusy(true); setError('');
    try {
      const report = await restoreFullBackup(file);
      window.alert(`恢复完成。${report.message}\n已恢复 ${report.counts.documents || 0} 本教材、${report.counts.notes || 0} 条笔记、${report.counts.highlights || 0} 条高亮。\n恢复前快照：${report.safety_backup}`);
      window.location.reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '完整备份恢复失败'); }
    finally { setBackupBusy(false); if (backupInput.current) backupInput.current.value = ''; }
  };

  const rememberCurrentPage = () => setNavigationStack(items => [...items, {
    screen,
    documentId: activeDocument?.id || null,
    currentPage,
    memoryBookOpen,
    memoryMode,
    assistantOpen,
  }].slice(-50));
  const navigateTo = (
    nextScreen: Screen,
    options: {document?: DocumentRecord; page?: number; memoryBookOpen?: boolean; assistantOpen?: boolean} = {},
  ) => {
    const nextDocument = options.document || activeDocument;
    const nextPage = options.page || currentPage;
    const nextMemoryBookOpen = options.memoryBookOpen ?? memoryBookOpen;
    const nextAssistantOpen = options.assistantOpen ?? (nextScreen === 'reader' ? assistantOpen : false);
    if (nextScreen === screen && nextDocument?.id === activeDocument?.id && nextPage === currentPage
      && nextMemoryBookOpen === memoryBookOpen && nextAssistantOpen === assistantOpen) return;
    rememberCurrentPage();
    if (options.document) setActiveDocument(options.document);
    if (options.page) setCurrentPage(options.page);
    setMemoryBookOpen(nextMemoryBookOpen);
    setAssistantOpen(nextAssistantOpen);
    setScreen(nextScreen);
  };
  const goBack = () => {
    const previous = navigationStack[navigationStack.length - 1];
    if (!previous) return;
    setNavigationStack(items => items.slice(0, -1));
    const previousDocument = previous.documentId ? documents.find(item => item.id === previous.documentId) : null;
    setActiveDocument(previousDocument || documents[0] || null);
    setCurrentPage(previous.currentPage);
    setMemoryBookOpen(previous.memoryBookOpen);
    setMemoryMode(previous.memoryMode);
    setAssistantOpen(previous.assistantOpen);
    setScreen(previous.screen);
  };
  const openBook = (document: DocumentRecord) => navigateTo('overview', {document, memoryBookOpen: false, assistantOpen: false});
  const enterReader = (document = activeDocument, page?: number) => {
    if (!document) return;
    if (screen === 'reader' && activeDocument?.id === document.id && page) {
      setReaderRestorePosition(false);
      setCurrentPage(page);
      setReaderPageRevision(value => value + 1);
      return;
    }
    setReaderRestorePosition(page === undefined);
    navigateTo('reader', {document, page, assistantOpen});
  };
  const requestReaderPage = (page: number) => {
    setReaderRestorePosition(false);
    setCurrentPage(page);
    setReaderPageRevision(value => value + 1);
  };
  const captureSummarySelection = (event: React.MouseEvent<HTMLElement>, summary: ChapterSummary) => {
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, ' ').trim() || '';
    if (!selection || selection.rangeCount === 0 || text.length < 2 || !event.currentTarget.contains(selection.anchorNode)) {
      setSummarySelection(null);
      return;
    }
    setTraceLocations([]);
    setTraceError('');
    setSummarySelection({text: text.slice(0, 500), summary});
  };
  const findSummarySources = async () => {
    if (!activeDocument || !summarySelection || traceLoading) return;
    setTraceLoading(true); setTraceError(''); setTraceLocations([]);
    try {
      const pages = await listOcrPages(activeDocument.id);
      const locations = locateSummarySources(summarySelection.text, pages, summarySelection.summary.start_page, summarySelection.summary.end_page);
      setTraceLocations(locations);
      if (!locations.length) setTraceError('在已建立的原文索引中没有找到可靠来源。可尝试选择包含核心概念的完整句子。');
    } catch (reason) {
      setTraceError(reason instanceof Error ? reason.message : '原文溯源失败');
    } finally { setTraceLoading(false); }
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
    const chapterIndex = Number(sourceTrace.summaryKey.slice(sourceTrace.summaryKey.lastIndexOf(':') + 1));
    if (Number.isInteger(chapterIndex) && chapterIndex >= 0) setSelectedChapterIndex(chapterIndex);
    setReturnedSummarySelection({text: sourceTrace.query, summaryKey: sourceTrace.summaryKey});
    setSourceTrace(null);
    goBack();
  };
  const renderSummaryText = (value: string | undefined, summaryKey: string) => {
    const highlight = returnedSummarySelection?.summaryKey === summaryKey ? returnedSummarySelection.text : undefined;
    return <SummaryContent value={value} highlight={highlight}/>;
  };
  const openMemory = () => navigateTo('memory', {memoryBookOpen: false, assistantOpen: false});
  const openMemoryBook = (document: DocumentRecord) => navigateTo('memory', {document, memoryBookOpen: true, assistantOpen: false});
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
  const floatingCardIndex = floatingCardId ? flashcards.findIndex(card => card.id === floatingCardId) : -1;
  const floatingCard = floatingCardIndex >= 0 ? flashcards[floatingCardIndex] : null;
  const floatingCardTotal = flashcards.length;
  const currentSummaryTask = backgroundTasks.find(task => task.document_id === activeDocument?.id && task.task_type === 'structure-summary' && ['queued', 'running', 'cancelling'].includes(task.status)) || backgroundTasks.find(task => task.document_id === activeDocument?.id && task.task_type === 'structure-summary' && task.status === 'paused');
  const startSummaryTask = async (chapterIndex: number | null) => {
    if (!activeDocument || !activeProfile || !chapters.length || chapterSummaryBusy) return;
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
      await collectChapterSource(activeDocument.id, start, end, progress => setChapterSummaryProgress(
        `准备原文（提交后台前）· PDF ${progress.page} · ${progress.completed}/${progress.total}${progress.phase === 'ocr' ? ' · OCR识别中' : ''}`,
      ), task.controller.signal);
      ensureBookGenerationActive(task);
      const queued = await createSummaryTask(activeDocument.id, activeProfile, chapters.map(({title, page, depth}) => ({title, page, depth})), chapterIndex);
      setBackgroundTasks(items => [queued, ...items.filter(item => item.id !== queued.id)]);
      setChapterSummaryProgress('已提交后台生成，可在任务中心查看进度。');
      setTaskCenterOpen(true);
    } catch (reason) {
      setChapterSummaryError(reason instanceof Error ? reason.message : '总结任务提交失败');
      setChapterSummaryBusy(''); setBookGenerationState('idle');
    } finally {
      bookGenerationTask.current = null;
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
  const visibleDocuments = documents.filter(document => selectedFolderId === 'all'
    || selectedFolderId === 'unfiled' && !document.folder_id
    || document.folder_id === selectedFolderId);
  const unfiledCount = documents.filter(document => !document.folder_id).length;
  const refreshTasksNow = async () => setBackgroundTasks(await listBackgroundTasks());
  const queueIndexes = async (documentIds: string[]) => {
    if (!documentIds.length) return;
    try {
      await createIndexTasks(documentIds);
      await refreshTasksNow();
      setTaskCenterOpen(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '后台索引任务创建失败'); }
  };
  const cancelTask = async (taskId: string) => {
    try { await cancelBackgroundTask(taskId); await refreshTasksNow(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '取消任务失败'); }
  };
  const retryTask = async (taskId: string) => {
    try { await retryBackgroundTask(taskId); await refreshTasksNow(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '重新执行任务失败'); }
  };
  const clearFinishedTasks = async () => {
    try { await clearFinishedBackgroundTasks(); await refreshTasksNow(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '清理任务记录失败'); }
  };
  const activeTaskCount = backgroundTasks.filter(task => ['queued', 'running', 'cancelling'].includes(task.status)).length;
  const taskCenterUi = <TaskCenter taskCenterOpen={taskCenterOpen} activeTaskCount={activeTaskCount}
    activeDocument={activeDocument} documents={documents} backgroundTasks={backgroundTasks}
    preparing={Boolean(bookGenerationTask.current)} chapterSummaryProgress={chapterSummaryProgress}
    onToggle={() => setTaskCenterOpen(value => !value)} onClose={() => setTaskCenterOpen(false)}
    onCancelPrepare={() => void cancelBookStructure()} onIndex={ids => void queueIndexes(ids)} onClear={() => void clearFinishedTasks()}
    onPause={id => void pauseSummaryTask(id).then(refreshTasksNow).catch(reason => setError(reason.message))}
    onCancel={id => void cancelTask(id)} onRetry={id => void retryTask(id)} onView={document => navigateTo('overview', {document})}
    describeTaskError={describeTaskError}/>;
  const normalizedNoteSearch = noteSearch.trim().toLocaleLowerCase();
  const visibleNotes = normalizedNoteSearch ? notes.filter(note =>
    [note.title, note.content, note.excerpt, ...(note.tags || [])].join(' ').toLocaleLowerCase().includes(normalizedNoteSearch),
  ) : notes;

  const mark = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 20.5V5.5C7 3 11.5 1.5 14 3.5C15.5 4.7 14.8 7.5 14.4 9M3.5 20.5C8 17.3 12 18 18 21"/><path d="M6 13.8C11 10 13.5 18.2 19 13.5"/><circle cx="21" cy="11.5" r="1.5"/></svg>;
  const header = <><header className="guided-header"><div className="guided-leading"><button className="guided-back" aria-label="返回前一个页面" disabled={!navigationStack.length} onClick={goBack}>← 返回</button><button className="guided-brand" onClick={() => navigateTo('home', {memoryBookOpen: false, assistantOpen: false})}><span>{mark}</span><strong>读步天下</strong></button></div><nav aria-label="学习空间"><button aria-current={screen === 'home' || screen === 'overview' ? 'page' : undefined} onClick={() => navigateTo('home', {memoryBookOpen: false, assistantOpen: false})}>学习空间</button><button aria-current={screen === 'memory' ? 'page' : undefined} onClick={openMemory}>学习记忆</button></nav><div className="guided-actions"><details className="global-more"><summary aria-label="更多设置">···</summary><div><button onClick={() => setSettingsOpen(true)}>模型配置</button><button disabled={backupBusy} onClick={() => void exportBackup()}>{backupBusy ? '处理中…' : '完整备份'}</button><button disabled={backupBusy} onClick={() => backupInput.current?.click()}>恢复备份</button><button onClick={() => void exportJsonBackup()}>导出数据 JSON</button></div></details><button className="import-button" onClick={() => fileInput.current?.click()}>＋ 导入教材</button></div><input ref={fileInput} hidden type="file" accept="application/pdf" onChange={event => importPdf(event.target.files?.[0])}/><input ref={backupInput} hidden type="file" accept="application/zip,.zip" onChange={event => void restoreBackup(event.target.files?.[0])}/></header>{taskCenterUi}</>;

  if (screen === 'home') return <div className="guided-shell">{header}<main className="guided-home original-home">
    {activeDocument && <section className="continue-reading"><p className="continue-eyebrow">CONTINUE　继续学习</p><div className="continue-row"><div className="editorial-cover">408<br/><small>读步天下</small></div><div><p>{activeDocument.title}</p><h1>继续阅读教材</h1><span>PDF {currentPage} · {notes.length} 条学习记忆 · {flashcards.filter(card => card.mastered).length} 项已掌握</span></div><div className="continue-actions"><button className="primary-action" onClick={() => enterReader()}>继续学习 →</button><button onClick={() => navigateTo('overview', {memoryBookOpen: false, assistantOpen: false})}>查看全书结构</button></div></div></section>}
    <section className="library-home">
      <div className="section-heading"><div><p>LIBRARY　你的教材</p></div><span>{documents.length} 本教材 · {folders.length} 个文件夹 · 本地保存</span></div>
      <div className="folder-toolbar">
        <nav aria-label="教材文件夹"><button aria-current={selectedFolderId === 'all'} onClick={() => setSelectedFolderId('all')}><span>全部教材</span><small>{documents.length}</small></button>{folders.map(folder => <span className="folder-tab" key={folder.id}><button aria-current={selectedFolderId === folder.id} onClick={() => setSelectedFolderId(folder.id)}><span>▱ {folder.name}</span><small>{folder.document_count}</small></button><details><summary aria-label={`${folder.name} 文件夹设置`}>···</summary><div><button onClick={() => void editFolder(folder)}>重命名</button><button className="danger-text" onClick={() => void removeFolder(folder)}>删除文件夹</button></div></details></span>)}<button aria-current={selectedFolderId === 'unfiled'} onClick={() => setSelectedFolderId('unfiled')}><span>未分类</span><small>{unfiledCount}</small></button></nav>
        <button className="new-folder" onClick={() => void addFolder()}>＋ 新建文件夹</button>
      </div>
      <div className="book-list-original">{visibleDocuments.map(document => <article className="library-book" key={document.id}><span className="editorial-cover compact">PDF</span><span className="book-identity"><strong>{document.title}</strong><small>{(document.byte_size / 1024 / 1024).toFixed(1)} MB · {activeDocument?.id === document.id ? `上次读到 PDF ${currentPage}` : folders.find(folder => folder.id === document.folder_id)?.name || '未分类'}</small></span><button className="book-open" aria-label={`打开教材 ${document.title}`} onClick={() => openBook(document)}>打开 →</button><details className="book-more"><summary aria-label={`${document.title} 更多操作`}>···</summary><div><button onClick={() => openBook(document)}>查看全书结构</button><button onClick={() => void renameBook(document)}>重命名</button><label className="move-book-label">移动到<select value={document.folder_id || ''} onChange={event => void moveBookToFolder(document, event.target.value)}><option value="">未分类</option>{folders.map(folder => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select></label><button className="danger-text" onClick={() => void removeBook(document)}>删除教材</button></div></details></article>)}</div>
      {!documents.length && <div className="guided-empty"><p>还没有教材。</p><button className="primary-action" onClick={() => fileInput.current?.click()}>选择 PDF</button></div>}
      {documents.length > 0 && !visibleDocuments.length && <div className="guided-empty folder-empty"><p>这个文件夹还没有教材。</p><span>可以从教材的“···”菜单移动，或在当前文件夹中导入 PDF。</span><button className="primary-action" onClick={() => fileInput.current?.click()}>导入到此文件夹</button></div>}
    </section><p className="local-note">文件夹和教材仅保存在这台电脑上</p>
  </main>{settingsOpen && <ModelSettings profiles={profiles} onClose={() => setSettingsOpen(false)} onSaved={async () => {await load(); setSettingsOpen(false);}}/>}</div>;

  if (screen === 'overview' && activeDocument) return <div className="guided-shell">{header}<main className="book-overview">
    <button className="back-link" onClick={goBack}>← 学习空间</button>
    <header><div><p>BOOK OVERVIEW　教材总览</p><h1>{activeDocument.title}</h1><span>上次读到 PDF {currentPage}</span></div><div className="overview-header-actions"><button disabled={!activeProfile || Boolean(chapterSummaryBusy)} onClick={() => void generateBookStructure()}>{generationScope === 'book' && (bookGenerationState === 'paused' || bookGenerationState === 'cancelled') ? '继续生成全书结构' : bookSummary ? '重新生成全书结构' : '生成全书结构'}</button><button className="primary-action" onClick={() => enterReader()}>继续 PDF {currentPage} →</button></div></header>
    {chapterSummaryError && <div className="chapter-summary-error" role="alert">总结任务：{describeTaskError(chapterSummaryError)}</div>}
    {summaryGaps.length > 0 && <aside className="summary-gap-notice" role="status"><strong>总结尚未完整覆盖教材：{summaryGaps.length}处待补充</strong><p>以下内容本次未生成，可点击对应按钮导入人工总结补齐。已保存内容保留。</p><ul>{summaryGaps.map(gap => <li key={gap.chapter_key}>{gap.title} · PDF {gap.start_page}-{gap.end_page} · 待补充 <button onClick={() => {gapImportTarget.current = {documentId: activeDocument.id, gap}; gapFileInput.current?.click();}}>导入本章人工总结</button></li>)}</ul><input ref={gapFileInput} hidden type="file" accept=".md,.txt,text/plain,text/markdown" onChange={event => void importGapSummary(event.target.files?.[0])}/></aside>}
    <section className="structure-import-bar"><div><strong>外部学习结构</strong><small>支持 JSON、Markdown、TXT；章节标题可附“PDF 11-17”，系统会自动识别小章节并保存总结。</small>{structureImportStatus && <span>{structureImportStatus}</span>}</div><button onClick={() => structureFileInput.current?.click()}>导入结构 / 总结</button><input ref={structureFileInput} hidden type="file" accept=".json,.md,.txt,application/json,text/markdown,text/plain" onChange={event => void importLearningStructureFile(event.target.files?.[0])}/></section>
    {(bookSummary || chapterSummaryBusy === bookSummaryKey || generationScope === 'book' && (bookGenerationState === 'paused' || bookGenerationState === 'cancelled')) && <section className="book-summary-panel"><header><div><small>BOOK KNOWLEDGE MAP</small><h2>全书知识结构</h2></div><div className="book-task-actions">{bookSummary && <span>PDF {bookSummary.start_page}-{bookSummary.end_page}</span>}{generationScope === 'book' && bookGenerationState === 'running' && <><button onClick={pauseBookStructure}>暂停</button><button className="danger" onClick={cancelBookStructure}>取消</button></>}{generationScope === 'book' && bookGenerationState === 'pausing' && <><span>安全暂停中</span><button className="danger" onClick={cancelBookStructure}>立即取消</button></>}{generationScope === 'book' && bookGenerationState === 'paused' && <><button onClick={() => void generateBookStructure()}>继续生成</button><button className="danger" onClick={cancelBookStructure}>取消任务</button></>}{generationScope === 'book' && bookGenerationState === 'cancelled' && <button onClick={() => void generateBookStructure()}>继续生成</button>}</div></header>{chapterSummaryBusy === bookSummaryKey || generationScope === 'book' && (bookGenerationState === 'paused' || bookGenerationState === 'cancelled') ? <><span className="chapter-summary-progress">{chapterSummaryProgress}</span>{chapterSummaryDraft && <div className="chapter-summary-content generating"><SummaryContent value={chapterSummaryDraft}/></div>}</> : <div className="chapter-summary-content trace-selectable" onMouseUp={event => bookSummary && captureSummarySelection(event, bookSummary)}>{renderSummaryText(bookSummary?.content, bookSummaryKey)}</div>}</section>}
    <div className="overview-grid"><aside className="chapter-rail"><p>章节</p>{chaptersLoading && <span className="chapter-status">正在读取 PDF 书签…</span>}{chapters.map((chapter, index) => <button key={`${chapter.title}-${chapter.page}-${index}`} className="chapter-entry" aria-current={index === selectedChapterIndex ? 'true' : undefined} style={{paddingLeft: `${8 + Math.min(chapter.depth, 4) * 13}px`}} onClick={() => {setSelectedChapterIndex(index); setChapterSummaryError('');}}><span>{chapter.title}</span><small>PDF {chapter.page}{summaryGaps.some(gap => gap.chapter_key === chapterKey(activeDocument.id, chapters, index)) && <em className="chapter-gap-badge">待补充</em>}</small></button>)}{!chaptersLoading && !chapters.length && <span className="chapter-status">这本教材没有可用的书签目录</span>}<div className="chapter-learning"><p>学习记录</p><button onClick={openMemory}>保存的解释<small>{notes.length} 条</small></button><button onClick={openMemory}>练习与复盘<small>{flashcards.length} 项</small></button></div></aside>
      <section className="chapter-detail">
        <div className="chapter-heading"><h2>{selectedChapter?.title || '当前学习结构'}</h2>{selectedChapterGenerated && <p>{chapterKind} · PDF {selectedChapterSummary?.start_page}-{selectedChapterSummary?.end_page}</p>}</div>
        {selectedChapter && !selectedChapterGenerated ? <div className="chapter-structure-empty">
          <p>{chapterKind === '大章' ? `将先生成 ${chapterChildren.length} 个直属子章的总结，再汇总为本大章知识结构。` : `将根据 PDF ${selectedChapter.page}${requestedChapterEndPage ? `-${requestedChapterEndPage}` : ' 至文末'} 的原文生成本小章总结。`}</p>
          {chapterSummaryBusy === selectedChapterKey || selectedChapterTaskStopped ? <>
            <div className="chapter-task-actions">
              <span className="chapter-summary-progress">{chapterSummaryProgress}</span>
              {selectedChapterTask && bookGenerationState === 'running' && <><button onClick={pauseBookStructure}>暂停</button><button className="danger" onClick={cancelBookStructure}>取消</button></>}
              {selectedChapterTask && bookGenerationState === 'pausing' && <><span>安全暂停中</span><button className="danger" onClick={cancelBookStructure}>立即取消</button></>}
              {selectedChapterTask && bookGenerationState === 'paused' && <><button onClick={() => void generateChapterStructure()}>继续生成</button><button className="danger" onClick={cancelBookStructure}>取消任务</button></>}
              {selectedChapterTask && bookGenerationState === 'cancelled' && <button onClick={() => void generateChapterStructure()}>继续生成</button>}
            </div>
            {chapterSummaryDraft && <div className="chapter-summary-content generating"><SummaryContent value={chapterSummaryDraft}/></div>}
          </> : <button disabled={!activeProfile} onClick={() => void generateChapterStructure()}>生成学习结构</button>}

        </div> : <>
          <article className="chapter-summary"><header><div><small>{chapterKind}知识结构</small><span>PDF {selectedChapterSummary?.start_page}-{selectedChapterSummary?.end_page}</span></div><div className="chapter-task-actions">{selectedChapterTaskStopped ? <><button onClick={() => void generateChapterStructure()}>继续生成</button>{bookGenerationState === 'paused' && <button className="danger" onClick={cancelBookStructure}>取消任务</button>}</> : <button disabled={Boolean(chapterSummaryBusy)} onClick={() => void generateChapterStructure()}>重新生成</button>}</div></header>{selectedChapterTaskStopped && <span className="chapter-summary-progress">{chapterSummaryProgress}</span>}<div className="chapter-summary-content trace-selectable" onMouseUp={event => selectedChapterSummary && captureSummarySelection(event, selectedChapterSummary)}>{renderSummaryText(selectedChapterSummary?.content, selectedChapterKey)}</div></article>
          <details className="overview-section" open><summary><div><h3>原文阅读与定位</h3><p>本章从 PDF {selectedChapter?.page || currentPage} 开始</p></div><button onClick={event => {event.preventDefault(); enterReader(activeDocument, selectedChapter?.page || currentPage);}}>进入教材 ↗</button></summary><article><span>01</span><div><strong>目录、搜索与原文定位</strong><p>在原始 PDF 中翻页、搜索、框选、选择文字并回到来源。</p></div></article></details>
          <details className="overview-section" open><summary><div><h3>理解与记忆</h3><p>{chapterNotes.length} 条正文记忆 · {chapterFlashcards.length} 条练习记录</p></div></summary><article><span>02</span><div><strong>解释 Assistant / 学习 Master</strong><p>围绕当前章节原文临时提问，重要解释收入学习记忆；练习卡记录掌握状态。</p></div></article></details>
        </>}
      </section>
    </div>
  </main>{summarySelection && <aside className="summary-trace-popover" aria-live="polite"><header><div><small>已选择总结文字</small><strong>{summarySelection.text}</strong></div><button aria-label="关闭原文溯源" onClick={() => {setSummarySelection(null); setTraceLocations([]); setTraceError('');}}>×</button></header>{!traceLocations.length && !traceError && <button className="trace-primary" disabled={traceLoading} onClick={() => void findSummarySources()}>{traceLoading ? '正在匹配原文…' : '原文溯源'}</button>}{traceError && <p className="trace-error">{traceError}</p>}{traceLocations.length > 0 && <><p>找到 {traceLocations.length} 处相关原文</p><div className="trace-location-list">{traceLocations.map((location, index) => <button key={`${location.page}-${index}`} onClick={() => openTraceLocation(index)}><strong>PDF 第 {location.page} 页</strong><span>{location.snippet}</span><b>跳转 →</b></button>)}</div></>}</aside>}{settingsOpen && <ModelSettings profiles={profiles} onClose={() => setSettingsOpen(false)} onSaved={async () => {await load(); setSettingsOpen(false);}}/>}</div>;

  if (screen === 'memory') return <div className="guided-shell">{header}<main className="memory-page">{!memoryBookOpen ? <><header><p>LEARNING MEMORY</p><h1>学习记忆</h1><span>正文理解与习题复盘都保存在来源教材下面。</span></header><nav className="memory-category-nav"><button aria-current={memoryMode === 'body'} onClick={() => setMemoryMode('body')}>正文记忆</button><button aria-current={memoryMode === 'practice'} onClick={() => setMemoryMode('practice')}>习题学习记录</button></nav><section className="memory-book-list">{documents.map(document => <button key={document.id} onClick={() => openMemoryBook(document)}><span className="editorial-cover compact">PDF</span><span><strong>{document.title}</strong><small>{activeDocument?.id === document.id ? (memoryMode === 'body' ? `${notes.length} 条正文记忆` : `${flashcards.length} 条习题记录`) : '打开查看学习记录'}</small></span><b>打开 →</b></button>)}</section></> : activeDocument ? <><div className="memory-detail-head"><button onClick={goBack}>← 学习记忆</button><div><h1>{activeDocument.title}</h1><span>{memoryMode === 'body' ? '正文记忆' : '习题学习记录'}</span></div><button onClick={() => enterReader()}>继续学习 →</button></div><nav className="memory-category-nav"><button aria-current={memoryMode === 'body'} onClick={() => setMemoryMode('body')}>正文记忆</button><button aria-current={memoryMode === 'practice'} onClick={() => setMemoryMode('practice')}>习题学习记录</button></nav>{memoryMode === 'body' ? <section className="memory-list"><div className="section-heading"><h2>保存的解释与笔记</h2><span>{notes.length}</span></div>{notes.map(note => <article className="memory-card" key={note.id}><button onClick={() => {enterReader(activeDocument, note.page_number || 1); setAssistantOpen(true);}}>返回来源</button>{note.excerpt && <blockquote>{note.excerpt}</blockquote>}<p>{note.content}</p></article>)}{!notes.length && <div className="guided-empty">尚未收入正文记忆。</div>}</section> : <section className="memory-list"><div className="section-heading"><h2>习题学习记录</h2><span>{flashcards.length}</span></div>{flashcards.map(card => <article className="memory-card" key={card.id}><button onClick={() => enterReader(activeDocument, card.page_number || 1)}>回到原题</button><small>{card.mastered ? '已掌握' : '仍需复习'} · {card.review_count || 0} 次</small><strong>{card.question}</strong><p>{card.answer}</p></article>)}{!flashcards.length && <div className="guided-empty">尚未产生习题学习记录。</div>}</section>}</> : null}</main>{settingsOpen && <ModelSettings profiles={profiles} onClose={() => setSettingsOpen(false)} onSaved={async () => {await load(); setSettingsOpen(false);}}/>}</div>;

  return <div className={`reader-shell ${assistantOpen ? 'assistant-dock-open' : ''}`} style={{'--assistant-width': `${assistantWidth}px`} as React.CSSProperties}>
    <main className="reader-panel">
      {activeDocument ? <PdfReader document={activeDocument} targetPage={currentPage} targetPageRevision={readerPageRevision} restoreLastPosition={readerRestorePosition} sourceTrace={sourceTrace} onSourceTraceNavigate={index => setSourceTrace(trace => trace ? {...trace, index} : null)} onSourceTraceReturn={returnToSelectedSummary} onSourceTraceClose={() => setSourceTrace(null)} onBack={goBack} assistantOpen={assistantOpen} onAssistantToggle={() => setAssistantOpen(value => !value)} onExcerpt={text => {setExcerpt(text); setIncludeCurrentExcerpt(true); setPanelMode('chat'); setAssistantOpen(true);}} onRegionExcerpt={handleRegionQuestions} onAiAssist={startReadingAssist} notes={notes} onCreatePageNote={createPageStickyNote} onUpdatePageNote={updatePageStickyNote} onDeletePageNote={deletePageStickyNote} onPageChange={setCurrentPage}/> : <div className="empty hero"><div className="paper-icon">＋</div><h1>把教材放回阅读中心</h1><p>导入 PDF 后，可以边读边摘录、提问和整理知识。</p><button onClick={() => fileInput.current?.click()}>选择 PDF</button></div>}
    </main>

    {assistantOpen && <div className="panel-resizer main-panel-resizer" role="separator" aria-label="调整 PDF 与 AI 助读区域宽度" aria-orientation="vertical" aria-valuemin={340} aria-valuemax={760} aria-valuenow={Math.round(assistantWidth)} tabIndex={0} onPointerDown={event => beginPanelResize(event, 'assistant')} onKeyDown={event => {if (event.key === 'ArrowLeft') {event.preventDefault(); resizePanelByKeyboard('assistant', 16);} if (event.key === 'ArrowRight') {event.preventDefault(); resizePanelByKeyboard('assistant', -16);}}}><span/></div>}

    {assistantOpen && <aside className="assistant-panel original-assistant" aria-label="AI 助读栏" tabIndex={0}>
      <div className={`assistant-head ${assistantSetupCollapsed ? 'is-collapsed' : ''}`}>
        <div className="assistant-title-row"><div><small>{panelMode === 'master' ? '长期学习' : '解释'}</small><h2>{panelMode === 'chat' ? '解释 Assistant' : panelMode === 'master' ? '学习 Master' : panelMode === 'cards' ? '做题与卡片' : '阅读笔记'}</h2></div><button className="assistant-fold-control" type="button" aria-expanded={!assistantSetupCollapsed} aria-controls="assistant-setup-content" onClick={() => setAssistantSetupCollapsed(value => !value)}>{assistantSetupCollapsed ? '展开模式与模型 ▾' : '收起模式与模型 ▴'}</button></div><button className="assistant-close" onClick={() => setAssistantOpen(false)}>收起</button>
        {!assistantSetupCollapsed && <div className="assistant-head-content" id="assistant-setup-content"><div className="panel-tabs"><button className={panelMode === 'chat' ? 'active' : ''} onClick={() => setPanelMode('chat')}>解释 Assistant</button><button className={panelMode === 'master' ? 'active' : ''} onClick={() => setPanelMode('master')}>学习 Master</button><button className={panelMode === 'cards' ? 'active' : ''} onClick={() => setPanelMode('cards')}>练习</button><button className={panelMode === 'notes' ? 'active' : ''} onClick={() => setPanelMode('notes')}>笔记 <span>{notes.length}</span></button></div>
        <div className="assistant-model-row">{panelMode !== 'notes' && <select value={activeProfile} onChange={event => setActiveProfile(event.target.value)}><option value="">选择模型</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select>}<button className="model-settings-link model-settings-inline" onClick={() => setSettingsOpen(true)}>模型配置</button></div></div>}
      </div>
      {panelMode === 'chat' || panelMode === 'master' ? <>
        <section className={`assistant-fold-panel context-fold-panel ${questionContextCollapsed ? 'is-collapsed' : ''}`}><button className="assistant-fold-toggle" type="button" aria-expanded={!questionContextCollapsed} aria-controls="assistant-context-content" onClick={() => setQuestionContextCollapsed(value => !value)}><span>提问范围</span><small>{includeCurrentExcerpt ? '当前原文' : multiBookMode ? `多书联系 · ${selectedBookIds.length} 本` : '单书全文'}</small><b>{questionContextCollapsed ? '▾' : '▴'}</b></button>{!questionContextCollapsed && <div id="assistant-context-content" className="assistant-fold-content"><div className="question-context-mode three-mode"><button aria-pressed={includeCurrentExcerpt} onClick={() => {setIncludeCurrentExcerpt(true); setMultiBookMode(false);}}>当前原文</button><button aria-pressed={!includeCurrentExcerpt && !multiBookMode} onClick={() => {setIncludeCurrentExcerpt(false); setMultiBookMode(false);}}>单书全文</button><button aria-pressed={!includeCurrentExcerpt && multiBookMode} onClick={() => {setIncludeCurrentExcerpt(false); setMultiBookMode(true); if (activeDocument) setSelectedBookIds(items => items.includes(activeDocument.id) ? items : [...items, activeDocument.id]);}}>多书联系</button><p>{includeCurrentExcerpt ? '只依据当前选择或粘贴的原文回答，并标注当前页码。' : multiBookMode ? '跨书检索观点，比较一致、互补与分歧，并标注每本书的原出处。' : '从当前教材全文召回相关原文和页码后回答。'}</p></div>
        {!includeCurrentExcerpt && <section className="multi-book-controls"><header><strong>{multiBookMode ? '选择参与联系的书' : '问答范围'}</strong><label><input type="checkbox" checked={useWebVerification} onChange={event => setUseWebVerification(event.target.checked)}/> 联网查证</label></header>{multiBookMode ? <div className="multi-book-list">{documents.map(document => <label key={document.id} className={selectedBookIds.includes(document.id) ? 'selected' : ''}><input type="checkbox" checked={selectedBookIds.includes(document.id)} onChange={event => setSelectedBookIds(items => event.target.checked ? [...new Set([...items, document.id])] : items.filter(id => id !== document.id))}/><span>{document.title}</span></label>)}</div> : <p>{activeDocument?.title || '尚未选择教材'}</p>}<small>{useWebVerification ? '会使用网络专业资料补充并验证，网络来源将单独列出。' : '仅依据所选教材，不访问网络检索。'}</small></section>}</div>}</section>
        <section className={`excerpt assistant-fold-panel excerpt-fold-panel ${excerptPanelCollapsed ? 'is-collapsed' : 'resizable-excerpt'} ${includeCurrentExcerpt ? '' : 'context-disabled'}`} style={excerptPanelCollapsed ? undefined : {height: `${excerptHeight}px`}}><button className="assistant-fold-toggle" type="button" aria-expanded={!excerptPanelCollapsed} aria-controls="assistant-excerpt-content" onClick={() => setExcerptPanelCollapsed(value => !value)}><span>教材摘录</span><small>{includeCurrentExcerpt ? excerpt.trim() ? '已加入提问' : '等待选择原文' : '本次不加入'}</small><b>{excerptPanelCollapsed ? '▾' : '▴'}</b></button>{!excerptPanelCollapsed && <textarea id="assistant-excerpt-content" disabled={!includeCurrentExcerpt} value={excerpt} onChange={event => setExcerpt(event.target.value)} placeholder="在 PDF 中选择文字，或在这里粘贴原文……"/>}</section>{!excerptPanelCollapsed && <div className="panel-resizer assistant-section-resizer" role="separator" aria-label="调整教材摘录区域高度" aria-orientation="horizontal" aria-valuemin={112} aria-valuemax={360} aria-valuenow={Math.round(excerptHeight)} tabIndex={0} onPointerDown={event => beginPanelResize(event, 'excerpt')} onKeyDown={event => {if (event.key === 'ArrowUp') {event.preventDefault(); resizePanelByKeyboard('excerpt', -12);} if (event.key === 'ArrowDown') {event.preventDefault(); resizePanelByKeyboard('excerpt', 12);}}}><span/></div>}
        <div className="conversation-tools"><span>{includeCurrentExcerpt ? `第 ${currentPage} 页 · 当前原文模式` : multiBookMode ? `${selectedBookIds.length} 本教材 · 多书联系` : '整本教材 · 全文 RAG 模式'} · {panelMode === 'master' ? 'Master（长期保留）' : 'Assistant（本次阅读）'}</span><span><button disabled={!includeCurrentExcerpt || !excerpt.trim() || busy} onClick={() => void runAsk('请基于当前教材摘录生成阅读导读：说明为什么要学、核心脉络，以及与前后知识的关系。')}>导读</button><button disabled={!includeCurrentExcerpt || !excerpt.trim() || busy} onClick={() => void runAsk('请对当前教材摘录做行间教学，补全作者省略的中间逻辑和推导步骤。')}>行间教学</button><button disabled={!(panelMode === 'master' ? messages : assistantMessages).some(item => item.role === 'assistant' && item.content.trim())} onClick={() => void saveLastExplanation()}>保存解释</button><button disabled={!(panelMode === 'master' ? messages : assistantMessages).length || busy} onClick={clearConversation}>清空</button></span></div>
        {!includeCurrentExcerpt && <div className="agent-mode-bar" role="group" aria-label="问答深度"><button disabled={busy} aria-pressed={!deepAnswer} onClick={() => setDeepAnswer(false)}>普通问答</button><button disabled={busy} aria-pressed={deepAnswer} onClick={() => setDeepAnswer(true)}>深度问答</button><small>{deepAnswer ? '补充检索与引用核验 · 最多 4 次模型调用 · 可取消' : '单轮检索，快速回答'}</small></div>}
        {busy && <div className="agent-stop-bar"><span role="status">{agentEvents.at(-1)?.message || '正在准备原文与回答…'}</span><button onClick={() => askController.current?.abort()}>取消问答</button></div>}
        <div className="conversation">
          {agentEvents.length > 0 && <details className="agent-progress-panel"><summary>{agentEvents.at(-1)?.stage === 'done' ? '深度问答已完成' : agentEvents.at(-1)?.stage === 'cancelled' ? '问答已取消' : agentEvents.at(-1)?.stage === 'error' ? '深度问答未完成' : '深度问答进度'} · 调用 {agentEvents.at(-1)?.model_calls}/{agentEvents.at(-1)?.max_model_calls}</summary><ol>{agentEvents.map((event, index) => <li key={index}>{event.message}</li>)}</ol></details>}
          {ragProgress && !includeCurrentExcerpt && ragProgress.phase !== 'done' && <div className="rag-progress"><strong>{ragProgress.phase === 'ocr' ? `${indexingBookTitle} · OCR 第 ${ragProgress.page} 页` : `${indexingBookTitle} · 正在建立全文索引`}</strong><span>{ragProgress.completed} / {ragProgress.total} 页</span><progress value={ragProgress.completed} max={ragProgress.total}/></div>}
          {ragStatus && !includeCurrentExcerpt && <div className="rag-sources"><header><strong>{ragStatus.document_count && ragStatus.document_count > 1 ? `${ragStatus.document_count} 本书的检索依据` : '本次检索依据'}</strong><span>{ragStatus.indexed_pages} 页 · {ragStatus.chunk_count} 个片段 · 本地混合检索</span></header>{ragSources.length ? <div>{ragSources.map((source, index) => <button key={`${source.document_id || ''}-${source.page_number}-${index}`} onClick={() => {const target = documents.find(item => item.id === source.document_id) || activeDocument; if (target) enterReader(target, source.page_number);}}><strong>{source.document_title || activeDocument?.title || '当前教材'} · PDF 第 {source.page_number} 页 · {source.retrieval === 'context' ? '相关页上下文' : source.retrieval === 'hybrid' ? '关键词＋语义' : source.retrieval === 'semantic' ? '语义召回' : '关键词召回'}</strong><span>{source.content.slice(0, 110)}{source.content.length > 110 ? '…' : ''}</span></button>)}</div> : <p>全文索引未找到直接相关片段，回答会明确说明证据不足。</p>}</div>}
          {webSources.length > 0 && !includeCurrentExcerpt && <div className="web-sources"><header><strong>联网核验来源</strong><span>{webSources.length} 条</span></header><div>{webSources.map((source, index) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer"><strong>网络 {index + 1} · {source.title}</strong><span>{source.snippet || source.url}</span></a>)}</div></div>}
          {!(panelMode === 'master' ? messages : assistantMessages).length && <div className="assistant-welcome"><span>✦</span><p>{includeCurrentExcerpt ? (panelMode === 'master' ? 'Master 会长期保留本教材的学习对话。' : '选择一段原文后，可以追问概念、推导和相近知识。') : '直接询问整本教材；系统会检索相关原文、标注 PDF 页码，并用联网资料补充解释。'}</p></div>}
          {(panelMode === 'master' ? messages : assistantMessages).map((message, index) => <article className={`message ${message.role}`} key={index}>
            <header className="message-heading"><span>{message.role === 'assistant' ? '✦' : '问'}</span><div><strong>{message.role === 'assistant' ? 'AI 助读' : '你的问题'}</strong><small>{message.role === 'assistant' ? '结论与依据' : includeCurrentExcerpt ? '当前原文' : multiBookMode ? '多书联系' : '单书全文'}</small></div></header>
            <div className="message-body">{message.content ? (message.role === 'assistant' ? <AnswerContent value={message.content}/> : <p>{message.content}</p>) : busy ? <div className="answer-loading" role="status"><i/><i/><i/><span>正在组织结论与依据…</span></div> : null}</div>
          </article>)}
          {verificationRunning && <div className="citation-verification pending"><strong>AI 正在核验引用…</strong><span>逐条比对回答、PDF 页码与召回原文</span></div>}
          {citationVerification && <details className="citation-verification" open>
            <summary><span><strong>AI 引用核验</strong><small>{citationVerification.method === 'ai' ? '模型审计＋本地校验' : '本地证据校验'}</small></span><b>{citationVerification.counts.supported} 条支持 · {citationVerification.counts.partial} 条部分支持 · {citationVerification.counts.unsupported + citationVerification.counts.missing} 条需复核</b></summary>
            {citationVerification.warning && <p className="verification-warning">{citationVerification.warning}</p>}
            <div className="citation-checks">{citationVerification.checks.map(check => <article className={`citation-check ${check.status}`} key={check.index}>
              <header><span>{check.status === 'supported' ? '✓ 原文支持' : check.status === 'partial' ? '△ 部分支持' : check.status === 'missing' ? '○ 缺少页码' : '× 未验证'}</span><small>结论 {check.index}</small></header>
              <p>{check.claim}</p><footer><span>{check.reason}</span><nav>{check.origins?.length ? check.origins.map((origin, originIndex) => <button key={`${origin.document_id || ''}-${origin.page_number}-${originIndex}`} onClick={() => {const target = documents.find(item => item.id === origin.document_id) || activeDocument; if (target) enterReader(target, origin.page_number);}}>{origin.document_title} · PDF {origin.page_number}</button>) : check.pages.map(page => <button key={page} onClick={() => requestReaderPage(page)}>PDF {page}</button>)}</nav></footer>
            </article>)}</div>
          </details>}
        </div>
        {error && <div className="error">{error}</div>}
        <div className="panel-resizer assistant-section-resizer composer-resizer" role="separator" aria-label="调整提问输入区域高度" aria-orientation="horizontal" aria-valuemin={76} aria-valuemax={260} aria-valuenow={Math.round(composerHeight)} tabIndex={0} onPointerDown={event => beginPanelResize(event, 'composer')} onKeyDown={event => {if (event.key === 'ArrowUp') {event.preventDefault(); resizePanelByKeyboard('composer', 12);} if (event.key === 'ArrowDown') {event.preventDefault(); resizePanelByKeyboard('composer', -12);}}}><span/></div>
        <div className="composer resizable-composer" style={{height: `${composerHeight}px`}}><textarea value={question} onChange={event => setQuestion(event.target.value)} onKeyDown={event => {if (event.key === 'Enter' && !event.shiftKey) {event.preventDefault(); ask();}}} placeholder={includeCurrentExcerpt ? '针对当前原文提问…' : multiBookMode ? '比较多本书对同一问题的观点、联系与差异…' : '针对整本教材提问，系统会自动检索原文…'}/><button disabled={!question.trim() || !activeProfile || busy || (!includeCurrentExcerpt && multiBookMode && !selectedBookIds.length)} onClick={ask}>{busy && !includeCurrentExcerpt ? (ragProgress?.phase === 'done' ? '回答中…' : '建索引…') : '发送'}</button></div>
      </> : panelMode === 'notes' ? <div className="notes-workspace enhanced-notes">
        <div className="note-editor">
          <div className="note-meta"><span>第 {currentPage} 页{excerpt && ' · 附带当前摘录'}</span><button className="text-button" disabled={!notes.length} onClick={exportNotes}>导出 Markdown</button></div>
          <input className="note-title-input" value={noteTitle} onChange={event => setNoteTitle(event.target.value)} placeholder="笔记标题（可选）"/>
          <textarea value={noteDraft} onChange={event => setNoteDraft(event.target.value)} placeholder="写下概念、疑问或自己的理解…"/>
          <div className="note-compose-footer"><input value={noteTags} onChange={event => setNoteTags(event.target.value)} placeholder="标签，用逗号分隔"/><button disabled={!activeDocument || !noteDraft.trim()} onClick={addNote}>保存笔记</button></div>
        </div>
        <div className="note-filter"><input value={noteSearch} onChange={event => setNoteSearch(event.target.value)} placeholder="搜索标题、正文、摘录或标签…"/><span>{visibleNotes.length} / {notes.length}</span></div>
        <div className="notes-list">{visibleNotes.map(note => <article className={`note-card ${note.pinned ? 'pinned' : ''}`} key={note.id}><div><span>{note.pinned && '★ '}{note.page_number ? `第 ${note.page_number} 页` : '未标页码'}</span><span className="card-actions"><button onClick={() => void toggleNotePinned(note)}>{note.pinned ? '取消置顶' : '置顶'}</button><button onClick={() => {setEditingNote(note.id); setEditingContent(note.content); setEditingTitle(note.title || ''); setEditingTags((note.tags || []).join(', '));}}>编辑</button><button onClick={() => removeNote(note.id)}>删除</button></span></div>{note.title && <h3>{note.title}</h3>}{note.excerpt && <blockquote>{note.excerpt}</blockquote>}{editingNote === note.id ? <div className="inline-editor"><input value={editingTitle} onChange={event => setEditingTitle(event.target.value)} placeholder="标题"/><textarea value={editingContent} onChange={event => setEditingContent(event.target.value)}/><input value={editingTags} onChange={event => setEditingTags(event.target.value)} placeholder="标签，用逗号分隔"/><span><button onClick={() => setEditingNote(null)}>取消</button><button onClick={() => saveEditedNote(note.id)}>保存</button></span></div> : <p>{note.content}</p>}{!!note.tags?.length && <div className="annotation-tags">{note.tags.map(tag => <span key={tag}>#{tag}</span>)}</div>}<time>{note.updated_at || note.created_at}</time></article>)}{!visibleNotes.length && <div className="assistant-welcome"><span>✎</span><p>{notes.length ? '没有匹配的笔记。' : '阅读时把关键原文引用过来，再写下自己的理解。'}</p></div>}</div>
        {error && <div className="error">{error}</div>}
      </div> : <div className="cards-workspace">
        <div className="card-generator question-recognizer">
          <div><strong>框选自动识题</strong><p>在 PDF 中启用“框选”，圈住题目区域后会自动识别其中全部问题并生成答案，不限制题目个数。</p></div>
          {recognizedCardCount > 0 && <span>本次识别 {recognizedCardCount} 题</span>}
          <button disabled={!excerpt.trim() || !activeProfile || busy} onClick={makeFlashcards}>{busy ? '正在识别全部问题…' : '重新识别当前框选'}</button>
        </div>
        <details className="manual-card compact-manual"><summary>手动补充卡片</summary><div><input value={manualQuestion} onChange={event => setManualQuestion(event.target.value)} placeholder="手工卡片问题"/><textarea value={manualAnswer} onChange={event => setManualAnswer(event.target.value)} placeholder="答案"/><button disabled={!manualQuestion.trim() || !manualAnswer.trim()} onClick={() => void addManualCard()}>添加卡片</button></div></details>
        <div className="flashcard-list">
          {flashcards.map(card => <article className={`flashcard ${card.mastered ? 'mastered' : ''}`} key={card.id} onClick={() => {setFloatingCardId(card.id); setFloatingCardOffset({x: 0, y: 0});}}>
            <div className="flashcard-meta"><span>{card.page_number ? `第 ${card.page_number} 页` : '知识卡片'} · 复习 {card.review_count || 0} 次</span><span><button onClick={event => {event.stopPropagation(); void editCard(card);}}>编辑</button><button onClick={event => {event.stopPropagation(); void removeFlashcard(card.id);}}>删除</button></span></div>
            <strong>{card.question}</strong>
            <small>{card.mastered ? '✓ 已掌握 · 点击打开题目' : '点击在右侧悬浮窗中查看问题与答案'}</small>
          </article>)}
          {!flashcards.length && <div className="assistant-welcome"><span>◇</span><p>点击阅读器顶部“框选”，圈住一道或多道题目，系统会自动识别全部问题并生成答案。</p></div>}
        </div>
        {error && <div className="error">{error}</div>}
      </div>}
    </aside>}

    {screen === 'reader' && floatingCard && <section className="floating-question-card" style={{transform: `translate3d(${floatingCardOffset.x}px, ${floatingCardOffset.y}px, 0)`}} aria-label="题目悬浮窗">
      <header onPointerDown={beginFloatingCardDrag}>
        <div><small>题目 {floatingCardIndex + 1} / {floatingCardTotal}</small><strong>问答卡片</strong></div>
        <nav onPointerDown={event => event.stopPropagation()}><button aria-label="上一题" disabled={floatingCardIndex <= 0} onClick={() => setFloatingCardId(flashcards[floatingCardIndex - 1]?.id || null)}>←</button><button aria-label="下一题" disabled={floatingCardIndex >= floatingCardTotal - 1} onClick={() => setFloatingCardId(flashcards[floatingCardIndex + 1]?.id || null)}>→</button><button aria-label="关闭题目悬浮窗" onClick={() => setFloatingCardId(null)}>×</button></nav>
      </header>
      <div className="floating-card-body"><span>{floatingCard.page_number ? `PDF 第 ${floatingCard.page_number} 页` : '知识卡片'} · 复习 {floatingCard.review_count || 0} 次</span><h3>{floatingCard.question}</h3><section><small>参考答案</small><p>{floatingCard.answer}</p></section></div>
      <footer><button onClick={() => void markCard(floatingCard, false)}>还需复习</button><button className={floatingCard.mastered ? 'active' : ''} onClick={() => void markCard(floatingCard, true)}>已掌握</button>{floatingCard.page_number && <button onClick={() => requestReaderPage(floatingCard.page_number!)}>回到原题</button>}</footer>
    </section>}
    {settingsOpen && <ModelSettings profiles={profiles} onClose={() => setSettingsOpen(false)} onSaved={async () => {await load(); setSettingsOpen(false);}}/>}
  </div>;
}
