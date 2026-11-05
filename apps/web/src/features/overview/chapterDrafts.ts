import {useEffect, useState} from 'react';

export type DraftRect = {x: number; y: number; width: number; height: number};
export type DraftLinkInput = {anchor: number; page: number; label: string; rect?: DraftRect};
export type DraftLink = DraftLinkInput & {id: string};
export type DraftScope = {chapter_key: string; chapter_title: string; start_page: number; end_page?: number; depth: number};
export type ChapterDraft = Required<DraftScope> & {
  id: string; document_id: string; filename: string; format: 'pdf' | 'docx' | 'md' | 'txt'; links: DraftLink[];
};

const endpoint = (id: string) => `/api/documents/${id}/chapter-drafts`;
export const draftFile = (draft: ChapterDraft) => `${endpoint(draft.document_id)}/${draft.id}/file`;
async function result<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '导入稿请求失败。');
  return data as T;
}

export function useChapterDrafts(documentId?: string) {
  const [snapshot, setSnapshot] = useState<{id?: string; items: ChapterDraft[]}>({items: []});
  const [error, setError] = useState('');
  const [previewPages, setPreviewPages] = useState<Record<string, number>>({});
  const [selection, setSelection] = useState<Record<string, string>>({});
  useEffect(() => {
    setSnapshot({id: documentId, items: []});
    setError('');
    if (!documentId) return;
    const controller = new AbortController();
    fetch(endpoint(documentId), {signal: controller.signal})
      .then(result<{drafts: ChapterDraft[]}>)
      .then(({drafts}) => {
        if (!controller.signal.aborted) setSnapshot(current => current.id === documentId
          ? {id: documentId, items: [...drafts.filter(draft => !current.items.some(item => item.id === draft.id)), ...current.items]} : current);
      })
      .catch(reason => {if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取导入稿失败。');});
    return () => controller.abort();
  }, [documentId]);

  function record(draft: ChapterDraft) {
    setSnapshot(current => {
      if (current.id !== draft.document_id) return current;
      return {id: current.id, items: current.items.some(item => item.id === draft.id)
        ? current.items.map(item => item.id === draft.id ? draft : item) : [...current.items, draft]};
    });
    return draft;
  }

  async function changeLink(draft: ChapterDraft, method: 'POST' | 'PUT' | 'DELETE', id?: string, link?: DraftLinkInput) {
    const url = `${endpoint(draft.document_id)}/${draft.id}/links${id ? '/' + encodeURIComponent(id) : ''}`;
    return record((await result<{draft: ChapterDraft}>(await fetch(url, {
      method, ...(link ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(link)} : {}),
    }))).draft);
  }

  return {
    drafts: snapshot.id === documentId ? snapshot.items : [], error, selection,
    previewPages, setPreviewPage: (id: string, page: number) => setPreviewPages(previous => ({...previous, [id]: page})),
    select: (key: string, id: string) => setSelection(previous => ({...previous, [key]: id})),
    async upload(scope: DraftScope, file: File) {
      if (!documentId) throw new Error('请先打开教材。');
      if (file.size > 20 * 1024 * 1024) throw new Error('导入稿单份不超过 20 MB。');
      const form = new FormData();
      for (const [key, value] of Object.entries(scope)) if (value !== undefined) form.set(key, String(value));
      form.set('file', file);
      return record((await result<{draft: ChapterDraft}>(await fetch(endpoint(documentId), {method: 'POST', body: form}))).draft);
    },
    saveLink: (draft: ChapterDraft, link: DraftLinkInput, id?: string) => changeLink(draft, id ? 'PUT' : 'POST', id, link),
    deleteLink: (draft: ChapterDraft, id: string) => changeLink(draft, 'DELETE', id),
  };
}
export type ChapterDrafts = ReturnType<typeof useChapterDrafts>;
