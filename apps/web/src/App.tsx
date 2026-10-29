import {useDocumentLearningData} from './shared/useDocumentLearningData';
import {LibraryHome} from './features/library/LibraryHome';
import {PracticeWorkspace} from './features/practice/PracticeWorkspace';
import {FloatingQuestion} from './features/practice/FloatingQuestion';
import {locateSummarySources} from './features/summary/sourceTrace';
import {useConversation} from './features/assistant/useConversation';
import {useFlashcards} from './features/practice/useFlashcards';
import {useNotes} from './features/notes/useNotes';
import {reconcileOutline} from './api';
import {TaskCenter} from './features/tasks/TaskCenter';
const ModelSettings = lazy(() => import('./features/settings/ModelSettings').then(module => ({default: module.ModelSettings})));
import {chapterKey, chapterPlan as planChapter} from './chapters';
import React, {lazy, Suspense, useEffect, useRef, useState} from 'react';
import {
  ChapterSummary, createFolder, deleteDocument, deleteFolder, DocumentRecord, exportAllData, FolderRecord, listChapterSummaries, listDocuments, listFolders, listOcrPages, listProfiles, ModelProfile, moveDocument, renameDocument, renameFolder,
  saveChapterSummary, uploadDocument, } from './api';
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
import './pdf-reader.css';
import type {SourceTraceLocation, SourceTraceNavigation} from './PdfPages';
const PdfReader = lazy(() => import('./PdfReader').then(module => ({default: module.PdfReader})));
import './task-center.css';
import './styles/annotations.css';
import './resizable-panels.css';
import type {OutlineEntry} from './pdfOutline';
const loadPdfOutline: typeof import('./pdfOutline').loadPdfOutline = async (...args) => (await import('./pdfOutline')).loadPdfOutline(...args);
const collectChapterSource: typeof import('./chapterSummary').collectChapterSource = async (...args) => (await import('./chapterSummary')).collectChapterSource(...args);
import {createSummaryTask, pauseSummaryTask, listSummaryGaps, SummaryGap} from './api';
import {parseLearningStructureImport} from './summaryImport';
import {useAutoDismiss} from './useAutoDismiss';
import {AnswerContent, SummaryContent} from './StructuredContent';
import './reading-agent.css';
import './structured-content.css';

function describeTaskError(message: string): string {
  if (/peer closed connection|incomplete chunked read/i.test(message)) return '模型连接提前中断，回答未完整接收。已完成分块已保留，请在任务中心重新执行。';
  if (/request burst|traffic growth|RequestBurstTooFast/i.test(message)) return '模型服务触发请求突增保护，需要等待冷却。已完成分块保留，请稍后重新执行，避免连续点击重试。';
  return message;
}

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
  const [floatingCardOffset, setFloatingCardOffset] = useState({x: 0, y: 0});
  const cardDrag = useRef<{x: number; y: number; offsetX: number; offsetY: number} | null>(null);
  const [busy, setBusy] = useState(false);
  const [deepAnswer, setDeepAnswer] = useState(false);
  const askDocumentId = useRef(activeDocument?.id);
  askDocumentId.current = activeDocument?.id;
  const [backupBusy, setBackupBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [error, setError] = useState('');
  const {notes, setNotes, noteDraft, setNoteDraft, noteTitle, setNoteTitle, noteTags, setNoteTags, noteSearch, setNoteSearch, editingNote, setEditingNote, editingContent, setEditingContent, editingTitle, setEditingTitle, editingTags, setEditingTags, addNote, removeNote, createPageStickyNote, updatePageStickyNote, deletePageStickyNote, saveEditedNote, toggleNotePinned, exportNotes} = useNotes(activeDocument, currentPage, excerpt, setError);
  const {question, setQuestion, messages, setMessages, assistantMessages, agentEvents, ragProgress, indexingBookTitle,
    ragSources, ragStatus, webSources, citationVerification, verificationRunning, runAsk, ask, cancelAsk,
    clearConversation, saveLastExplanation} = useConversation({
      activeDocument, documents, activeProfile, profiles, excerpt, currentPage, chapterSummaries,
      master: panelMode === 'master', includeCurrentExcerpt, multiBookMode, selectedBookIds, useWebVerification,
      deepAnswer, busy, setBusy, setError, onNoteSaved: note => setNotes(items => [note, ...items]),
    });
  const practice = useFlashcards({
      activeDocument, activeProfile, currentPage, excerpt, busy, setBusy, setError,
    });
  const {flashcards, setFlashcards, setFloatingCardId, setRecognizedCardCount, makeFlashcardsFromExcerpt} = practice;
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

  useDocumentLearningData(activeDocument?.id, {
    reset: () => {setMessages([]); setNotes([]); setFlashcards([]); setChapterSummaries([]);},
    loaded: data => {setMessages(data.history); setNotes(data.notes); setFlashcards(data.flashcards); setChapterSummaries(data.summaries);},
    error: setError,
  });
  useEffect(() => {
    setFloatingCardOffset({x: 0, y: 0}); setIncludeCurrentExcerpt(true);
    setSummarySelection(null); setTraceLocations([]); setTraceError(''); setSourceTrace(null);
  }, [activeDocument?.id]);

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

  if (screen === 'home') return <div className="guided-shell">{header}<LibraryHome activeDocument={activeDocument} currentPage={currentPage} notesCount={notes.length}
    masteredCount={flashcards.filter(card => card.mastered).length} documents={documents} folders={folders}
    selectedFolderId={selectedFolderId} setSelectedFolderId={setSelectedFolderId} enterReader={() => enterReader()}
    onOverview={() => navigateTo('overview', {memoryBookOpen: false, assistantOpen: false})}
    onImport={() => fileInput.current?.click()} openBook={openBook} renameBook={renameBook} removeBook={removeBook}
    moveBookToFolder={moveBookToFolder} addFolder={addFolder} editFolder={editFolder} removeFolder={removeFolder}/>{settingsOpen && <Suspense fallback={<div role="status">正在加载模型设置…</div>}><ModelSettings profiles={profiles} onClose={() => setSettingsOpen(false)} onSaved={async () => {await load(); setSettingsOpen(false);}}/></Suspense>}</div>;

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
  </main>{summarySelection && <aside className="summary-trace-popover" aria-live="polite"><header><div><small>已选择总结文字</small><strong>{summarySelection.text}</strong></div><button aria-label="关闭原文溯源" onClick={() => {setSummarySelection(null); setTraceLocations([]); setTraceError('');}}>×</button></header>{!traceLocations.length && !traceError && <button className="trace-primary" disabled={traceLoading} onClick={() => void findSummarySources()}>{traceLoading ? '正在匹配原文…' : '原文溯源'}</button>}{traceError && <p className="trace-error">{traceError}</p>}{traceLocations.length > 0 && <><p>找到 {traceLocations.length} 处相关原文</p><div className="trace-location-list">{traceLocations.map((location, index) => <button key={`${location.page}-${index}`} onClick={() => openTraceLocation(index)}><strong>PDF 第 {location.page} 页</strong><span>{location.snippet}</span><b>跳转 →</b></button>)}</div></>}</aside>}{settingsOpen && <Suspense fallback={<div role="status">正在加载模型设置…</div>}><ModelSettings profiles={profiles} onClose={() => setSettingsOpen(false)} onSaved={async () => {await load(); setSettingsOpen(false);}}/></Suspense>}</div>;

  if (screen === 'memory') return <div className="guided-shell">{header}<main className="memory-page">{!memoryBookOpen ? <><header><p>LEARNING MEMORY</p><h1>学习记忆</h1><span>正文理解与习题复盘都保存在来源教材下面。</span></header><nav className="memory-category-nav"><button aria-current={memoryMode === 'body'} onClick={() => setMemoryMode('body')}>正文记忆</button><button aria-current={memoryMode === 'practice'} onClick={() => setMemoryMode('practice')}>习题学习记录</button></nav><section className="memory-book-list">{documents.map(document => <button key={document.id} onClick={() => openMemoryBook(document)}><span className="editorial-cover compact">PDF</span><span><strong>{document.title}</strong><small>{activeDocument?.id === document.id ? (memoryMode === 'body' ? `${notes.length} 条正文记忆` : `${flashcards.length} 条习题记录`) : '打开查看学习记录'}</small></span><b>打开 →</b></button>)}</section></> : activeDocument ? <><div className="memory-detail-head"><button onClick={goBack}>← 学习记忆</button><div><h1>{activeDocument.title}</h1><span>{memoryMode === 'body' ? '正文记忆' : '习题学习记录'}</span></div><button onClick={() => enterReader()}>继续学习 →</button></div><nav className="memory-category-nav"><button aria-current={memoryMode === 'body'} onClick={() => setMemoryMode('body')}>正文记忆</button><button aria-current={memoryMode === 'practice'} onClick={() => setMemoryMode('practice')}>习题学习记录</button></nav>{memoryMode === 'body' ? <section className="memory-list"><div className="section-heading"><h2>保存的解释与笔记</h2><span>{notes.length}</span></div>{notes.map(note => <article className="memory-card" key={note.id}><button onClick={() => {enterReader(activeDocument, note.page_number || 1); setAssistantOpen(true);}}>返回来源</button>{note.excerpt && <blockquote>{note.excerpt}</blockquote>}<p>{note.content}</p></article>)}{!notes.length && <div className="guided-empty">尚未收入正文记忆。</div>}</section> : <section className="memory-list"><div className="section-heading"><h2>习题学习记录</h2><span>{flashcards.length}</span></div>{flashcards.map(card => <article className="memory-card" key={card.id}><button onClick={() => enterReader(activeDocument, card.page_number || 1)}>回到原题</button><small>{card.mastered ? '已掌握' : '仍需复习'} · {card.review_count || 0} 次</small><strong>{card.question}</strong><p>{card.answer}</p></article>)}{!flashcards.length && <div className="guided-empty">尚未产生习题学习记录。</div>}</section>}</> : null}</main>{settingsOpen && <Suspense fallback={<div role="status">正在加载模型设置…</div>}><ModelSettings profiles={profiles} onClose={() => setSettingsOpen(false)} onSaved={async () => {await load(); setSettingsOpen(false);}}/></Suspense>}</div>;

  return <div className={`reader-shell ${assistantOpen ? 'assistant-dock-open' : ''}`} style={{'--assistant-width': `${assistantWidth}px`} as React.CSSProperties}>
    <main className="reader-panel">
      {activeDocument ? <Suspense fallback={<div className="empty" role="status">正在打开阅读器…</div>}><PdfReader document={activeDocument} targetPage={currentPage} targetPageRevision={readerPageRevision} restoreLastPosition={readerRestorePosition} sourceTrace={sourceTrace} onSourceTraceNavigate={index => setSourceTrace(trace => trace ? {...trace, index} : null)} onSourceTraceReturn={returnToSelectedSummary} onSourceTraceClose={() => setSourceTrace(null)} onBack={goBack} assistantOpen={assistantOpen} onAssistantToggle={() => setAssistantOpen(value => !value)} onExcerpt={text => {setExcerpt(text); setIncludeCurrentExcerpt(true); setPanelMode('chat'); setAssistantOpen(true);}} onRegionExcerpt={handleRegionQuestions} onAiAssist={startReadingAssist} notes={notes} onCreatePageNote={createPageStickyNote} onUpdatePageNote={updatePageStickyNote} onDeletePageNote={deletePageStickyNote} onPageChange={setCurrentPage}/></Suspense> : <div className="empty hero"><div className="paper-icon">＋</div><h1>把教材放回阅读中心</h1><p>导入 PDF 后，可以边读边摘录、提问和整理知识。</p><button onClick={() => fileInput.current?.click()}>选择 PDF</button></div>}
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
        {busy && <div className="agent-stop-bar"><span role="status">{agentEvents.at(-1)?.message || '正在准备原文与回答…'}</span><button onClick={cancelAsk}>取消问答</button></div>}
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
      </div> : <PracticeWorkspace practice={practice} canGenerate={Boolean(excerpt.trim() && activeProfile)} busy={busy} error={error}
        onOpenCard={id => {setFloatingCardId(id); setFloatingCardOffset({x: 0, y: 0});}}/>}
    </aside>}

    {screen === 'reader' && <FloatingQuestion practice={practice} floatingCardOffset={floatingCardOffset}
      beginFloatingCardDrag={beginFloatingCardDrag} requestReaderPage={requestReaderPage}/>}
    {settingsOpen && <Suspense fallback={<div role="status">正在加载模型设置…</div>}><ModelSettings profiles={profiles} onClose={() => setSettingsOpen(false)} onSaved={async () => {await load(); setSettingsOpen(false);}}/></Suspense>}
  </div>;
}
