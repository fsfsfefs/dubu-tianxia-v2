import {useEffect, useMemo, useState} from 'react';
import type {Highlight} from '../../api';
import {useAnnotations, type ReaderInkTools} from '../reader/useAnnotations';
import type {ChapterDraft} from './chapterDrafts';

export async function inkResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json();
    throw new Error(typeof body.detail === 'string' ? body.detail : '总结标注保存失败。');
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function useDraftInk(draft: ChapterDraft, sharedTools?: ReaderInkTools) {
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const endpoint = `/api/documents/${draft.document_id}/chapter-drafts/${draft.id}/ink`;
  const storage = useMemo(() => ({
    async create(_documentId: string, input: Omit<Highlight, 'id' | 'document_id' | 'created_at' | 'updated_at'>) {
      return (await inkResponse<{highlight: Highlight}>(await fetch(endpoint, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input),
      }))).highlight;
    },
    async remove(_documentId: string, id: string) {
      await inkResponse<void>(await fetch(`${endpoint}/${id}`, {method: 'DELETE'}));
    },
  }), [endpoint]);
  const annotations = useAnnotations({id: draft.id}, highlights, setHighlights, setError, storage);
  useEffect(() => {
    if (draft.format !== 'pdf') return;
    const controller = new AbortController();
    void fetch(endpoint, {signal: controller.signal}).then(inkResponse<{highlights: Highlight[]}>)
      .then(data => {if (!controller.signal.aborted) {setHighlights(data.highlights); setLoaded(true);}})
      .catch(reason => {if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '总结标注读取失败。');});
    return () => controller.abort();
  }, [endpoint, draft.format]);
  return {id: draft.id, annotations, highlights, error, loaded, tools: sharedTools ?? annotations};
}
