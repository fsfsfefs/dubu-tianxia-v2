import {useEffect, useRef, useState} from 'react';
import type {Dispatch, SetStateAction} from 'react';
import {createFlashcard, deleteFlashcard, generateFlashcards, reviewFlashcard, updateFlashcard,
  type DocumentRecord, type Flashcard} from '../../api';
import {useDocumentScope} from '../../shared/useDocumentScope';

type Options = {
  activeDocument: DocumentRecord | null; activeProfile: string; currentPage: number; excerpt: string;
  busy: boolean; setBusy: Dispatch<SetStateAction<boolean>>; setError: (message: string) => void;
};
export function useFlashcards({activeDocument, activeProfile, currentPage, excerpt, busy, setBusy, setError}: Options) {
  const [flashcards, setFlashcards] = useState<Flashcard[]>([]);
  const [manualQuestion, setManualQuestion] = useState('');
  const [manualAnswer, setManualAnswer] = useState('');
  const [floatingCardId, setFloatingCardId] = useState<string | null>(null);
  const [recognizedCardCount, setRecognizedCardCount] = useState(0);
  const capture = useDocumentScope(activeDocument?.id);
  const generation = useRef<object | null>(null);
  useEffect(() => {
    setFlashcards([]); setFloatingCardId(null); setRecognizedCardCount(0); setManualQuestion(''); setManualAnswer('');
    generation.current = null; setBusy(false);
  }, [activeDocument?.id]);

  const makeFlashcardsFromExcerpt = async (sourceText: string, page: number) => {
    if (!activeDocument || !activeProfile || !sourceText.trim() || busy || generation.current) return;
    const valid = capture(); const token = {}; generation.current = token;
    setBusy(true); setError('');
    try {
      const created = await generateFlashcards(activeDocument.id, {profile_id: activeProfile, page_number: page, excerpt: sourceText.trim()});
      if (!valid()) return;
      setFlashcards(items => [...created, ...items]); setRecognizedCardCount(created.length);
      if (created[0]) setFloatingCardId(created[0].id);
    } catch (error) {if (valid()) setError(error instanceof Error ? error.message : '卡片生成失败');}
    finally {if (valid() && generation.current === token) {generation.current = null; setBusy(false);}}
  };
  const removeFlashcard = async (id: string) => {
    if (!activeDocument) return;
    const valid = capture();
    try {await deleteFlashcard(activeDocument.id, id); if (valid()) {setFlashcards(items => items.filter(item => item.id !== id)); setFloatingCardId(current => current === id ? null : current);}}
    catch (error) {if (valid()) setError(error instanceof Error ? error.message : '删除失败');}
  };
  const addManualCard = async () => {
    if (!activeDocument || !manualQuestion.trim() || !manualAnswer.trim()) return;
    const valid = capture();
    try {
      const card = await createFlashcard(activeDocument.id, {page_number: currentPage, source_excerpt: excerpt.trim(), question: manualQuestion.trim(), answer: manualAnswer.trim()});
      if (valid()) {setFlashcards(items => [card, ...items]); setManualQuestion(''); setManualAnswer('');}
    } catch (error) {if (valid()) setError(error instanceof Error ? error.message : '卡片保存失败');}
  };
  const markCard = async (card: Flashcard, mastered: boolean) => {
    if (!activeDocument) return;
    const valid = capture();
    try {const updated = await reviewFlashcard(activeDocument.id, card.id, mastered); if (valid()) setFlashcards(items => items.map(item => item.id === card.id ? updated : item));}
    catch (error) {if (valid()) setError(error instanceof Error ? error.message : '复习状态保存失败');}
  };
  const editCard = async (card: Flashcard) => {
    if (!activeDocument) return;
    const question = window.prompt('修改问题', card.question)?.trim(); if (!question) return;
    const answer = window.prompt('修改答案', card.answer)?.trim(); if (!answer) return;
    const valid = capture();
    try {const updated = await updateFlashcard(activeDocument.id, card.id, question, answer); if (valid()) setFlashcards(items => items.map(item => item.id === card.id ? updated : item));}
    catch (error) {if (valid()) setError(error instanceof Error ? error.message : '卡片更新失败');}
  };
  return {flashcards, setFlashcards, manualQuestion, setManualQuestion, manualAnswer, setManualAnswer,
    floatingCardId, setFloatingCardId, recognizedCardCount, setRecognizedCardCount, makeFlashcardsFromExcerpt,
    makeFlashcards: () => makeFlashcardsFromExcerpt(excerpt, currentPage), removeFlashcard, addManualCard, markCard, editCard};
}
