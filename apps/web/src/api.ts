export type DocumentRecord = {
  id: string;
  title: string;
  byte_size: number;
  created_at: string;
  folder_id: string | null;
};

export type FolderRecord = {id: string; name: string; document_count: number; created_at: string};

export type ModelProfile = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  temperature: number;
  max_tokens: number;
  is_default: boolean;
};

export type EmbeddingModel = {
  id: string; name: string; engine: 'builtin' | 'fastembed'; model_name: string;
  dimension: number; size_gb: number; source: 'builtin' | 'download' | 'import';
  status: 'ready' | 'available'; description: string; local_path?: string | null;
};
export type EmbeddingModelCatalog = {active_id: string; models: EmbeddingModel[]; presets: EmbeddingModel[]; external_models_supported?: boolean; platform_note?: string};
export type SummaryGap = {chapter_key: string; title: string; start_page: number; end_page: number; reason: string};

export type BackgroundTask = {
  id: string; task_type: 'document-index' | 'structure-summary'; document_id: string | null; document_title?: string | null;
  title: string; status: 'queued' | 'running' | 'cancelling' | 'paused' | 'completed' | 'partial' | 'failed' | 'cancelled';
  progress: number; total: number; message: string; error: string; cancel_requested: boolean;
  result: {indexed_pages?: number; reused_pages?: number; blank_pages?: number; missing_chapters?: SummaryGap[]};
  created_at: string; updated_at: string;
};

export type ReadingPosition = {page_number: number; page_offset: number; zoom: number; updated_at?: string | null};
export type OcrPage = {page_number: number; text: string; updated_at?: string | null};
export type RagSource = {document_id?: string; document_title?: string; page_number: number; content: string; score: number; lexical_score?: number; semantic_score?: number; retrieval?: 'lexical' | 'semantic' | 'hybrid' | 'context'};
export type RagStatus = {indexed_pages: number; chunk_count: number; engine: string; document_count?: number; documents?: Array<{document_id: string; document_title: string; indexed_pages: number; chunk_count: number; engine: string}>};
export type WebSource = {title: string; url: string; snippet: string};
export type CitationCheck = {
  index: number; claim: string; pages: number[];
  origins?: Array<{document_id?: string; document_title: string; page_number: number}>;
  status: 'supported' | 'partial' | 'unsupported' | 'missing';
  reason: string; score: number; evidence: string;
};
export type CitationVerification = {
  method: 'ai' | 'local';
  counts: Record<CitationCheck['status'], number>;
  checks: CitationCheck[];
  warning: string;
};
export type ChapterSummary = {
  chapter_key: string; title: string; start_page: number; end_page: number;
  depth: number; content: string; updated_at?: string | null;
};
export type ImportedOutlineEntry = {title: string; page: number; depth: number; source?: string; updated_at?: string};
export type HighlightRect = {x: number; y: number; width: number; height: number};
export type Highlight = {
  id: string; document_id: string; page_number: number; text: string;
  rects: HighlightRect[]; color: 'yellow' | 'green' | 'blue' | 'pink' | 'black' | 'red'; comment: string; tags: string[]; created_at: string; updated_at?: string;
};
export type Note = {
  id: string; document_id: string; page_number: number | null; excerpt: string;
  content: string; title: string; tags: string[]; pinned: boolean; created_at: string; updated_at?: string;
};
export type ChatMessage = {
  id: string; document_id: string; role: 'user' | 'assistant'; content: string; created_at: string;
};
export type Flashcard = {
  id: string; document_id: string; page_number: number | null; question: string;
  answer: string; source_excerpt: string; created_at: string; review_count: number;
  mastered: number; last_reviewed_at: string | null;
};

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || body.error || `请求失败：${response.status}`);
  }
  return response.json();
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  return (await json<{documents: DocumentRecord[]}>(await fetch('/api/documents'))).documents;
}

export async function listFolders(): Promise<FolderRecord[]> {
  return (await json<{folders: FolderRecord[]}>(await fetch('/api/folders'))).folders;
}

export async function createFolder(name: string): Promise<FolderRecord> {
  return (await json<{folder: FolderRecord}>(await fetch('/api/folders', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name}),
  }))).folder;
}

export async function renameFolder(folderId: string, name: string): Promise<FolderRecord> {
  return (await json<{folder: FolderRecord}>(await fetch(`/api/folders/${folderId}`, {
    method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name}),
  }))).folder;
}

export async function deleteFolder(folderId: string): Promise<void> {
  const response = await fetch(`/api/folders/${folderId}`, {method: 'DELETE'});
  if (!response.ok) await json(response);
}

export async function moveDocument(documentId: string, folderId: string | null): Promise<DocumentRecord> {
  return (await json<{document: DocumentRecord}>(await fetch(`/api/documents/${documentId}/folder`, {
    method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({folder_id: folderId}),
  }))).document;
}

export async function uploadDocument(file: File): Promise<DocumentRecord> {
  const form = new FormData();
  form.append('file', file);
  return (await json<{document: DocumentRecord}>(await fetch('/api/documents', {
    method: 'POST', body: form,
  }))).document;
}

export async function renameDocument(documentId: string, title: string): Promise<DocumentRecord> {
  return (await json<{document: DocumentRecord}>(await fetch(`/api/documents/${documentId}`, {
    method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({title}),
  }))).document;
}

export async function deleteDocument(documentId: string): Promise<void> {
  const response = await fetch(`/api/documents/${documentId}`, {method: 'DELETE'});
  if (!response.ok) await json(response);
}

export async function getPosition(documentId: string): Promise<ReadingPosition> {
  return (await json<{position: ReadingPosition}>(await fetch(`/api/documents/${documentId}/position`))).position;
}

export async function savePosition(documentId: string, position: Omit<ReadingPosition, 'updated_at'>) {
  return json(await fetch(`/api/documents/${documentId}/position`, {
    method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(position), keepalive: true,
  }));
}

export async function listOcrPages(documentId: string): Promise<OcrPage[]> {
  return (await json<{pages: OcrPage[]}>(await fetch(`/api/documents/${documentId}/ocr-pages`))).pages;
}

export async function saveOcrPage(documentId: string, pageNumber: number, text: string): Promise<OcrPage> {
  return (await json<{page: OcrPage}>(await fetch(`/api/documents/${documentId}/ocr-pages/${pageNumber}`, {
    method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text}),
  }))).page;
}

export async function listChapterSummaries(documentId: string): Promise<ChapterSummary[]> {
  return (await json<{summaries: ChapterSummary[]}>(await fetch(`/api/documents/${documentId}/chapter-summaries`))).summaries;
}

export async function saveChapterSummary(
  documentId: string,
  summary: Omit<ChapterSummary, 'updated_at'>,
): Promise<ChapterSummary> {
  return (await json<{summary: ChapterSummary}>(await fetch(
    `/api/documents/${documentId}/chapter-summaries/${encodeURIComponent(summary.chapter_key)}`,
    {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(summary)},
  ))).summary;
}

export async function getImportedOutline(documentId: string): Promise<ImportedOutlineEntry[]> {
  return (await json<{outline: ImportedOutlineEntry[]}>(await fetch(
    `/api/documents/${documentId}/imported-outline`,
  ))).outline;
}

export async function importLearningStructure(
  documentId: string,
  outline: Array<Pick<ImportedOutlineEntry, 'title' | 'page' | 'depth'>>,
  summaries: Array<Omit<ChapterSummary, 'updated_at'>>,
): Promise<{outline: ImportedOutlineEntry[]; summaries: ChapterSummary[]}> {
  return json(await fetch(`/api/documents/${documentId}/learning-structure-import`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({outline, summaries}),
  }));
}

export async function listHighlights(documentId: string): Promise<Highlight[]> {
  return (await json<{highlights: Highlight[]}>(await fetch(`/api/documents/${documentId}/highlights`))).highlights;
}

export async function createHighlight(documentId: string, input: Omit<Highlight, 'id' | 'document_id' | 'created_at' | 'updated_at'>): Promise<Highlight> {
  return (await json<{highlight: Highlight}>(await fetch(`/api/documents/${documentId}/highlights`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input),
  }))).highlight;
}

export async function updateHighlight(documentId: string, highlightId: string, input: Pick<Highlight, 'color' | 'comment' | 'tags'>): Promise<Highlight> {
  return (await json<{highlight: Highlight}>(await fetch(`/api/documents/${documentId}/highlights/${highlightId}`, {
    method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input),
  }))).highlight;
}

export async function deleteHighlight(documentId: string, highlightId: string): Promise<void> {
  const response = await fetch(`/api/documents/${documentId}/highlights/${highlightId}`, {method: 'DELETE'});
  if (!response.ok) await json(response);
}

export async function listNotes(documentId: string): Promise<Note[]> {
  return (await json<{notes: Note[]}>(await fetch(`/api/documents/${documentId}/notes`))).notes;
}

export async function createNote(documentId: string, input: Pick<Note, 'page_number' | 'excerpt' | 'content' | 'title' | 'tags' | 'pinned'>): Promise<Note> {
  return (await json<{note: Note}>(await fetch(`/api/documents/${documentId}/notes`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input),
  }))).note;
}

export async function deleteNote(documentId: string, noteId: string): Promise<void> {
  const response = await fetch(`/api/documents/${documentId}/notes/${noteId}`, {method: 'DELETE'});
  if (!response.ok) await json(response);
}

export async function updateNote(documentId: string, noteId: string, input: Pick<Note, 'content' | 'title' | 'tags' | 'pinned'>): Promise<Note> {
  return (await json<{note: Note}>(await fetch(`/api/documents/${documentId}/notes/${noteId}`, {
    method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input),
  }))).note;
}

export async function listChatMessages(documentId: string): Promise<ChatMessage[]> {
  return (await json<{messages: ChatMessage[]}>(await fetch(`/api/documents/${documentId}/chat`))).messages;
}

export async function clearChatMessages(documentId: string): Promise<void> {
  const response = await fetch(`/api/documents/${documentId}/chat`, {method: 'DELETE'});
  if (!response.ok) await json(response);
}

export async function listFlashcards(documentId: string): Promise<Flashcard[]> {
  return (await json<{flashcards: Flashcard[]}>(await fetch(`/api/documents/${documentId}/flashcards`))).flashcards;
}

export async function generateFlashcards(documentId: string, input: {profile_id: string; page_number: number; excerpt: string; count?: number | null}): Promise<Flashcard[]> {
  return (await json<{flashcards: Flashcard[]}>(await fetch(`/api/documents/${documentId}/flashcards/generate`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input),
  }))).flashcards;
}

export async function createFlashcard(documentId: string, input: {page_number: number; source_excerpt: string; question: string; answer: string}): Promise<Flashcard> {
  return (await json<{flashcard: Flashcard}>(await fetch(`/api/documents/${documentId}/flashcards`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input),
  }))).flashcard;
}

export async function updateFlashcard(documentId: string, cardId: string, question: string, answer: string): Promise<Flashcard> {
  return (await json<{flashcard: Flashcard}>(await fetch(`/api/documents/${documentId}/flashcards/${cardId}`, {
    method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({question, answer}),
  }))).flashcard;
}

export async function reviewFlashcard(documentId: string, cardId: string, mastered: boolean): Promise<Flashcard> {
  return (await json<{flashcard: Flashcard}>(await fetch(`/api/documents/${documentId}/flashcards/${cardId}/review`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({mastered}),
  }))).flashcard;
}

export async function deleteFlashcard(documentId: string, cardId: string): Promise<void> {
  const response = await fetch(`/api/documents/${documentId}/flashcards/${cardId}`, {method: 'DELETE'});
  if (!response.ok) await json(response);
}

export async function listProfiles(): Promise<ModelProfile[]> {
  return (await json<{profiles: ModelProfile[]}>(await fetch('/api/model-profiles'))).profiles;
}

export async function listEmbeddingModels(): Promise<EmbeddingModelCatalog> {
  return json<EmbeddingModelCatalog>(await fetch('/api/embedding-models'));
}

export async function downloadEmbeddingModel(modelName: string): Promise<EmbeddingModel> {
  return (await json<{model: EmbeddingModel}>(await fetch('/api/embedding-models/download', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({model_name: modelName}),
  }))).model;
}

export async function importEmbeddingModel(file: File, name: string, modelName: string): Promise<EmbeddingModel> {
  const form = new FormData();
  form.append('file', file); form.append('name', name); form.append('model_name', modelName);
  return (await json<{model: EmbeddingModel}>(await fetch('/api/embedding-models/import', {method: 'POST', body: form}))).model;
}

export async function selectEmbeddingModel(modelId: string): Promise<{model: EmbeddingModel; reindexed_chunks: number}> {
  return json(await fetch('/api/embedding-models/active', {
    method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({model_id: modelId}),
  }));
}

export async function saveProfile(input: Omit<ModelProfile, 'id'> & {id?: string; api_key?: string}) {
  return json(await fetch('/api/model-profiles', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input),
  }));
}

export async function deleteProfile(profileId: string): Promise<void> {
  const response = await fetch(`/api/model-profiles/${profileId}`, {method: 'DELETE'});
  if (!response.ok) await json(response);
}

export async function testProfileDraft(input: Pick<ModelProfile, 'endpoint' | 'model' | 'temperature' | 'max_tokens'> & {id?: string; api_key?: string}): Promise<{ok: boolean; response: string}> {
  return json(await fetch('/api/model-profiles/test', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input),
  }));
}

export async function testProfile(profileId: string): Promise<{ok: boolean; response: string}> {
  return json(await fetch(`/api/model-profiles/${profileId}/test`, {method: 'POST'}));
}

export type RestoreReport = {
  ok: boolean; created_at: string; counts: Record<string, number>; safety_backup: string;
  credentials_restored: boolean; message: string;
};

export async function downloadFullBackup(): Promise<{blob: Blob; filename: string}> {
  const response = await fetch('/api/backup/full');
  if (!response.ok) await json(response);
  const disposition = response.headers.get('Content-Disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  return {blob: await response.blob(), filename: encoded ? decodeURIComponent(encoded) : plain || 'reader-next-full-backup.zip'};
}

export async function restoreFullBackup(file: File): Promise<RestoreReport> {
  const body = new FormData(); body.append('file', file);
  return json(await fetch('/api/backup/restore', {method: 'POST', body}));
}


export async function exportAllData(): Promise<unknown> {
  return json(await fetch('/api/export'));
}

export type AgentProgress = {stage: string; message: string; model_calls: number; max_model_calls: number};

export async function streamAnswer(
  input: {document_id?: string; document_ids?: string[]; profile_id: string; excerpt: string; question: string; history?: {role: string; content: string}[]; page_number?: number; max_tokens?: number; use_web?: boolean; use_rag?: boolean; use_agent?: boolean; persist_history?: boolean; verify_citations?: boolean},
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  onSources?: (sources: RagSource[], status: RagStatus) => void,
  onVerification?: (verification: CitationVerification | null, running: boolean) => void,
  onWebSources?: (sources: WebSource[]) => void,
  onAgentProgress?: (progress: AgentProgress) => void,
) {
  const response = await fetch('/api/chat/stream', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input), signal,
  });
  if (!response.ok || !response.body) throw new Error((await response.json()).detail || '请求失败');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  try {
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const event of events) {
      const line = event.split('\n').find(value => value.startsWith('data:'));
      if (!line) continue;
      const payload = JSON.parse(line.slice(5).trim());
      if (payload.type === 'delta') onDelta(payload.text);
      if (payload.type === 'agent_progress') onAgentProgress?.(payload);
      if (payload.type === 'complete') completed = true;
      if (payload.type === 'sources') onSources?.(payload.sources || [], payload.status);
      if (payload.type === 'web_sources') onWebSources?.(payload.sources || []);
      if (payload.type === 'verification_started') onVerification?.(null, true);
      if (payload.type === 'citation_verification') onVerification?.(payload.verification, false);
      if (payload.type === 'error') throw new Error(payload.error);
    }
  }
  if (!completed) throw new Error('连接已中断，回答尚未完成，请重试。');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}


export async function listBackgroundTasks(): Promise<BackgroundTask[]> {
  return (await json<{tasks: BackgroundTask[]}>(await fetch('/api/tasks'))).tasks;
}

export async function listSummaryGaps(documentId: string): Promise<SummaryGap[]> {
  return (await json<{gaps: SummaryGap[]}>(await fetch(`/api/documents/${documentId}/summary-gaps`))).gaps;
}

export async function createSummaryTask(documentId: string, profileId: string, outline: {title: string; page: number; depth: number}[], chapterIndex: number | null): Promise<BackgroundTask> {
  const response = await fetch('/api/tasks/summary', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({document_id: documentId, profile_id: profileId, outline, chapter_index: chapterIndex}),
  });
  if (response.status === 404) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail === 'Not Found' ? '后端尚未加载总结任务接口，请停止旧后端并重新启动，再刷新页面重试。' : body.detail || '教材或模型配置不存在，请刷新后重试。');
  }
  return (await json<{task: BackgroundTask}>(response)).task;
}

export async function pauseSummaryTask(taskId: string): Promise<BackgroundTask> {
  return (await json<{task: BackgroundTask}>(await fetch(`/api/tasks/${taskId}/pause`, {method: 'POST'}))).task;
}

export async function createIndexTasks(documentIds: string[]): Promise<BackgroundTask[]> {
  return (await json<{tasks: BackgroundTask[]}>(await fetch('/api/tasks/index', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({document_ids: documentIds}),
  }))).tasks;
}

export async function cancelBackgroundTask(taskId: string): Promise<BackgroundTask> {
  return (await json<{task: BackgroundTask}>(await fetch(`/api/tasks/${taskId}/cancel`, {method: 'POST'}))).task;
}

export async function retryBackgroundTask(taskId: string): Promise<BackgroundTask> {
  return (await json<{task: BackgroundTask}>(await fetch(`/api/tasks/${taskId}/retry`, {method: 'POST'}))).task;
}

export async function clearFinishedBackgroundTasks(): Promise<number> {
  return (await json<{deleted: number}>(await fetch('/api/tasks/finished', {method: 'DELETE'}))).deleted;
}




export async function reconcileOutline(documentId: string, outline: Array<{title: string; page: number; depth: number}>) {
  return json<{summaries: ChapterSummary[]; gaps: SummaryGap[]}>(await fetch(`/api/documents/${documentId}/outline/reconcile`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({outline}),
  }));
}
