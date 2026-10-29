import {useEffect, useRef} from 'react';
import {listChatMessages, listNotes, listFlashcards, listChapterSummaries,
  type ChatMessage, type Note, type Flashcard, type ChapterSummary} from '../api';
import {useDocumentScope} from './useDocumentScope';

type LearningData = {history: ChatMessage[]; notes: Note[]; flashcards: Flashcard[]; summaries: ChapterSummary[]};
type Handlers = {reset: () => void; loaded: (data: LearningData) => void; error: (message: string) => void};

/** Loading belongs to a book visit; a slow older response cannot replace the current view. */
export function useDocumentLearningData(documentId: string | undefined, handlers: Handlers) {
  const current = useRef(handlers);
  current.current = handlers;
  const capture = useDocumentScope(documentId);
  useEffect(() => {
    const valid = capture();
    current.current.reset();
    if (!documentId) return;
    Promise.all([listChatMessages(documentId), listNotes(documentId), listFlashcards(documentId), listChapterSummaries(documentId).catch(() => [])])
      .then(([history, notes, flashcards, summaries]) => {if (valid()) current.current.loaded({history, notes, flashcards, summaries});})
      .catch(error => {if (valid()) current.current.error(error instanceof Error ? error.message : '学习数据加载失败');});
  }, [documentId]);
}
