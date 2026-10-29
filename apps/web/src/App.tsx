import {GuideLauncher} from './features/guide/GuideLauncher';
import {useWorkspaceNavigation} from './features/workspace/useWorkspaceNavigation';
import {AssistantDock} from './features/assistant/AssistantDock';
import {usePanelLayout} from './features/assistant/usePanelLayout';
import {pauseSummaryTask} from './api';
import {describeTaskError} from './features/overview/useOverview';
import {useOverview} from './features/overview/useOverview';
import {OverviewWorkspace} from './features/overview/OverviewWorkspace';
import {useDocumentLearningData} from './shared/useDocumentLearningData';
import {LibraryHome} from './features/library/LibraryHome';
import {FloatingQuestion} from './features/practice/FloatingQuestion';
import {useConversation} from './features/assistant/useConversation';
import {useFlashcards} from './features/practice/useFlashcards';
import {useNotes} from './features/notes/useNotes';
import {TaskCenter} from './features/tasks/TaskCenter';
const GuideEntry = lazy(() => import('./features/guide/GuideEntry').then(module => ({default: module.GuideEntry})));
const ModelSettings = lazy(() => import('./features/settings/ModelSettings').then(module => ({default: module.ModelSettings})));
import React, {lazy, Suspense, useEffect, useRef, useState} from 'react';
import {
  createFolder, deleteDocument, deleteFolder, DocumentRecord, exportAllData, FolderRecord, listDocuments, listFolders, listProfiles, ModelProfile, moveDocument, renameDocument, renameFolder,
  uploadDocument, } from './api';
import {downloadFullBackup, restoreFullBackup} from './api';
import {BackgroundTask, cancelBackgroundTask, clearFinishedBackgroundTasks, createIndexTasks, listBackgroundTasks, retryBackgroundTask} from './api';
import './styles/foundation.css';
import './styles/workspace.css';
import './styles/library.css';
import './styles/learning.css';
import './features/settings/EmbeddingSettings.css';
import './features/overview/StructureImport.css';
import './styles/editorial.css';
import './overview-scroll.css';
import './pdf-reader.css';
const PdfReader = lazy(() => import('./PdfReader').then(module => ({default: module.PdfReader})));
import './features/tasks/TaskCenter.css';
import './styles/annotations.css';
import './resizable-panels.css';
import {useAutoDismiss} from './useAutoDismiss';
import './reading-agent.css';
import './structured-content.css';

export function App() {
  const [guideOpen, setGuideOpen] = useState(false);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<'all' | 'unfiled' | string>('all');
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const {screen, navigationStack, assistantOpen, setAssistantOpen, memoryBookOpen, memoryMode, setMemoryMode, activeDocument, setActiveDocument, currentPage, setCurrentPage, readerPageRevision, readerRestorePosition, navigateTo, goBack, openBook, enterReader, requestReaderPage, openMemory, openMemoryBook} = useWorkspaceNavigation(documents);
  const [activeProfile, setActiveProfile] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [includeCurrentExcerpt, setIncludeCurrentExcerpt] = useState(true);
  const [multiBookMode, setMultiBookMode] = useState(false);
  const [selectedBookIds, setSelectedBookIds] = useState<string[]>([]);
  const [useWebVerification, setUseWebVerification] = useState(true);
  const [panelMode, setPanelMode] = useState<'chat' | 'master' | 'notes' | 'cards'>('chat');
  const [floatingCardOffset, setFloatingCardOffset] = useState({x: 0, y: 0});
  const cardDrag = useRef<{x: number; y: number; offsetX: number; offsetY: number} | null>(null);
  const [busy, setBusy] = useState(false);
  const [deepAnswer, setDeepAnswer] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [error, setError] = useState('');
  const noteController = useNotes(activeDocument, currentPage, excerpt, setError);
  const {notes, setNotes, createPageStickyNote, updatePageStickyNote, deletePageStickyNote} = noteController;
  const practice = useFlashcards({
      activeDocument, activeProfile, currentPage, excerpt, busy, setBusy, setError,
    });
  const {flashcards, setFlashcards, setFloatingCardId, setRecognizedCardCount, makeFlashcardsFromExcerpt} = practice;
  const overview = useOverview({activeDocument, activeProfile, currentPage, screen, backgroundTasks, setBackgroundTasks, setTaskCenterOpen, setError, notes, flashcards,
    enterReader: (...args) => enterReader(...args), goBack: () => goBack(), refreshTasksNow: () => refreshTasksNow(), cancelTask: id => cancelTask(id)});
  const {chapterSummaries, setChapterSummaries, chapterSummaryProgress, sourceTrace, setSourceTrace, bookGenerationTask, returnToSelectedSummary, cancelBookStructure} = overview;
  const conversation = useConversation({
      activeDocument, documents, activeProfile, profiles, excerpt, currentPage, chapterSummaries,
      master: panelMode === 'master', includeCurrentExcerpt, multiBookMode, selectedBookIds, useWebVerification,
      deepAnswer, busy, setBusy, setError, onNoteSaved: note => setNotes(items => [note, ...items]),
    });
  const {setQuestion, setMessages} = conversation;
  const layout = usePanelLayout();
  const {assistantWidth, resizePanelByKeyboard, beginPanelResize} = layout;
  const fileInput = useRef<HTMLInputElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  useAutoDismiss(error, () => setError(''));


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
    if (activeDocument) setSelectedBookIds(items => items.length ? items : [activeDocument.id]);
  }, [activeDocument?.id]);

  useDocumentLearningData(activeDocument?.id, {
    reset: () => {setMessages([]); setNotes([]); setFlashcards([]); setChapterSummaries([]);},
    loaded: data => {setMessages(data.history); setNotes(data.notes); setFlashcards(data.flashcards); setChapterSummaries(data.summaries);},
    error: setError,
  });
  useEffect(() => {
    setFloatingCardOffset({x: 0, y: 0}); setIncludeCurrentExcerpt(true);
  }, [activeDocument?.id]);

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
  const mark = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 20.5V5.5C7 3 11.5 1.5 14 3.5C15.5 4.7 14.8 7.5 14.4 9M3.5 20.5C8 17.3 12 18 18 21"/><path d="M6 13.8C11 10 13.5 18.2 19 13.5"/><circle cx="21" cy="11.5" r="1.5"/></svg>;
  const header = <><header className="guided-header"><div className="guided-leading"><button className="guided-back" aria-label="返回前一个页面" disabled={!navigationStack.length} onClick={goBack}>← 返回</button><button className="guided-brand" onClick={() => navigateTo('home', {memoryBookOpen: false, assistantOpen: false})}><span>{mark}</span><strong>读步天下</strong></button></div><nav aria-label="学习空间"><button aria-current={screen === 'home' || screen === 'overview' ? 'page' : undefined} onClick={() => navigateTo('home', {memoryBookOpen: false, assistantOpen: false})}>学习空间</button><button aria-current={screen === 'memory' ? 'page' : undefined} onClick={openMemory}>学习记忆</button></nav><div className="guided-actions"><button className="guide-open" onClick={() => setGuideOpen(true)}>使用指南</button><details className="global-more"><summary aria-label="更多设置">···</summary><div><button onClick={() => setSettingsOpen(true)}>模型配置</button><button disabled={backupBusy} onClick={() => void exportBackup()}>{backupBusy ? '处理中…' : '完整备份'}</button><button disabled={backupBusy} onClick={() => backupInput.current?.click()}>恢复备份</button><button onClick={() => void exportJsonBackup()}>导出数据 JSON</button></div></details><button className="import-button" onClick={() => fileInput.current?.click()}>＋ 导入教材</button></div><input ref={fileInput} hidden type="file" accept="application/pdf" onChange={event => importPdf(event.target.files?.[0])}/><input ref={backupInput} hidden type="file" accept="application/zip,.zip" onChange={event => void restoreBackup(event.target.files?.[0])}/></header>{taskCenterUi}</>;

  const guideUi = guideOpen && <Suspense fallback={<div className="guide-loading" role="status">正在打开使用指南…</div>}><GuideEntry onClose={() => setGuideOpen(false)}/></Suspense>;
  const settingsUi = settingsOpen && <Suspense fallback={<div role="status">正在加载模型设置…</div>}><ModelSettings profiles={profiles} onClose={() => setSettingsOpen(false)} onSaved={async () => {await load(); setSettingsOpen(false);}}/></Suspense>;
  if (screen === 'home') return <div className="guided-shell">{guideUi}{header}<GuideLauncher onOpen={() => setGuideOpen(true)}/><LibraryHome activeDocument={activeDocument} currentPage={currentPage} notesCount={notes.length}
    masteredCount={flashcards.filter(card => card.mastered).length} documents={documents} folders={folders}
    selectedFolderId={selectedFolderId} setSelectedFolderId={setSelectedFolderId} enterReader={() => enterReader()}
    onOverview={() => navigateTo('overview', {memoryBookOpen: false, assistantOpen: false})}
    onImport={() => fileInput.current?.click()} openBook={openBook} renameBook={renameBook} removeBook={removeBook}
    moveBookToFolder={moveBookToFolder} addFolder={addFolder} editFolder={editFolder} removeFolder={removeFolder}/>{settingsOpen && <Suspense fallback={<div role="status">正在加载模型设置…</div>}><ModelSettings profiles={profiles} onClose={() => setSettingsOpen(false)} onSaved={async () => {await load(); setSettingsOpen(false);}}/></Suspense>}</div>;

  if (screen === 'overview' && activeDocument) return <OverviewWorkspace model={overview} activeDocument={activeDocument} activeProfile={activeProfile} currentPage={currentPage} notes={notes} flashcards={flashcards} goBack={goBack} enterReader={enterReader} openMemory={openMemory} header={<>{header}{guideUi}</>} settings={settingsUi}/>;

  if (screen === 'memory') return <div className="guided-shell">{guideUi}{header}<main className="memory-page">{!memoryBookOpen ? <><header><p>LEARNING MEMORY</p><h1>学习记忆</h1><span>正文理解与习题复盘都保存在来源教材下面。</span></header><nav className="memory-category-nav"><button aria-current={memoryMode === 'body'} onClick={() => setMemoryMode('body')}>正文记忆</button><button aria-current={memoryMode === 'practice'} onClick={() => setMemoryMode('practice')}>习题学习记录</button></nav><section className="memory-book-list">{documents.map(document => <button key={document.id} onClick={() => openMemoryBook(document)}><span className="editorial-cover compact">PDF</span><span><strong>{document.title}</strong><small>{activeDocument?.id === document.id ? (memoryMode === 'body' ? `${notes.length} 条正文记忆` : `${flashcards.length} 条习题记录`) : '打开查看学习记录'}</small></span><b>打开 →</b></button>)}</section></> : activeDocument ? <><div className="memory-detail-head"><button onClick={goBack}>← 学习记忆</button><div><h1>{activeDocument.title}</h1><span>{memoryMode === 'body' ? '正文记忆' : '习题学习记录'}</span></div><button onClick={() => enterReader()}>继续学习 →</button></div><nav className="memory-category-nav"><button aria-current={memoryMode === 'body'} onClick={() => setMemoryMode('body')}>正文记忆</button><button aria-current={memoryMode === 'practice'} onClick={() => setMemoryMode('practice')}>习题学习记录</button></nav>{memoryMode === 'body' ? <section className="memory-list"><div className="section-heading"><h2>保存的解释与笔记</h2><span>{notes.length}</span></div>{notes.map(note => <article className="memory-card" key={note.id}><button onClick={() => {enterReader(activeDocument, note.page_number || 1); setAssistantOpen(true);}}>返回来源</button>{note.excerpt && <blockquote>{note.excerpt}</blockquote>}<p>{note.content}</p></article>)}{!notes.length && <div className="guided-empty">尚未收入正文记忆。</div>}</section> : <section className="memory-list"><div className="section-heading"><h2>习题学习记录</h2><span>{flashcards.length}</span></div>{flashcards.map(card => <article className="memory-card" key={card.id}><button onClick={() => enterReader(activeDocument, card.page_number || 1)}>回到原题</button><small>{card.mastered ? '已掌握' : '仍需复习'} · {card.review_count || 0} 次</small><strong>{card.question}</strong><p>{card.answer}</p></article>)}{!flashcards.length && <div className="guided-empty">尚未产生习题学习记录。</div>}</section>}</> : null}</main>{settingsOpen && <Suspense fallback={<div role="status">正在加载模型设置…</div>}><ModelSettings profiles={profiles} onClose={() => setSettingsOpen(false)} onSaved={async () => {await load(); setSettingsOpen(false);}}/></Suspense>}</div>;

  return <div className={`reader-shell ${assistantOpen ? 'assistant-dock-open' : ''}`} style={{'--assistant-width': `${assistantWidth}px`} as React.CSSProperties}>
    {guideUi}<main className="reader-panel">
      {activeDocument ? <Suspense fallback={<div className="empty" role="status">正在打开阅读器…</div>}><PdfReader onOpenGuide={() => setGuideOpen(true)} document={activeDocument} targetPage={currentPage} targetPageRevision={readerPageRevision} restoreLastPosition={readerRestorePosition} sourceTrace={sourceTrace} onSourceTraceNavigate={index => setSourceTrace(trace => trace ? {...trace, index} : null)} onSourceTraceReturn={returnToSelectedSummary} onSourceTraceClose={() => setSourceTrace(null)} onBack={goBack} assistantOpen={assistantOpen} onAssistantToggle={() => setAssistantOpen(value => !value)} onExcerpt={text => {setExcerpt(text); setIncludeCurrentExcerpt(true); setPanelMode('chat'); setAssistantOpen(true);}} onRegionExcerpt={handleRegionQuestions} onAiAssist={startReadingAssist} notes={notes} onCreatePageNote={createPageStickyNote} onUpdatePageNote={updatePageStickyNote} onDeletePageNote={deletePageStickyNote} onPageChange={setCurrentPage}/></Suspense> : <div className="empty hero"><div className="paper-icon">＋</div><h1>把教材放回阅读中心</h1><p>导入 PDF 后，可以边读边摘录、提问和整理知识。</p><button onClick={() => fileInput.current?.click()}>选择 PDF</button></div>}
    </main>

    {assistantOpen && <div className="panel-resizer main-panel-resizer" role="separator" aria-label="调整 PDF 与 AI 助读区域宽度" aria-orientation="vertical" aria-valuemin={340} aria-valuemax={760} aria-valuenow={Math.round(assistantWidth)} tabIndex={0} onPointerDown={event => beginPanelResize(event, 'assistant')} onKeyDown={event => {if (event.key === 'ArrowLeft') {event.preventDefault(); resizePanelByKeyboard('assistant', 16);} if (event.key === 'ArrowRight') {event.preventDefault(); resizePanelByKeyboard('assistant', -16);}}}><span/></div>}

    {assistantOpen && <AssistantDock conversation={conversation} notesController={noteController} practice={practice} layout={layout} config={{requestReaderPage, activeDocument, documents, profiles, activeProfile, setActiveProfile, panelMode, setPanelMode, setSettingsOpen, setAssistantOpen, includeCurrentExcerpt, setIncludeCurrentExcerpt, excerpt, setExcerpt, currentPage, multiBookMode, setMultiBookMode, selectedBookIds, setSelectedBookIds, useWebVerification, setUseWebVerification, deepAnswer, setDeepAnswer, busy, error, enterReader, setFloatingCardOffset, setFloatingCardId}}/>}

    {screen === 'reader' && <FloatingQuestion practice={practice} floatingCardOffset={floatingCardOffset}
      beginFloatingCardDrag={beginFloatingCardDrag} requestReaderPage={requestReaderPage}/>}
    {settingsOpen && <Suspense fallback={<div role="status">正在加载模型设置…</div>}><ModelSettings profiles={profiles} onClose={() => setSettingsOpen(false)} onSaved={async () => {await load(); setSettingsOpen(false);}}/></Suspense>}
  </div>;
}
