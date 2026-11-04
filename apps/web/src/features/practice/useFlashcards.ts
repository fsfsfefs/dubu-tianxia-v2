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
  const [manualExplanation, setManualExplanation] = useState('');
  const [floatingCardId, setFloatingCardId] = useState<string | null>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [recognizedCardCount, setRecognizedCardCount] = useState(0);
  const capture = useDocumentScope(activeDocument?.id);
  const generation = useRef<object | null>(null);
  const editing = useRef(editingCardId);
  editing.current = editingCardId;
  useEffect(() => {
    setFlashcards([]); setFloatingCardId(null); setRecognizedCardCount(0); setManualQuestion(''); setManualAnswer('');
    setEditingCardId(null); setManualExplanation('');
    generation.current = null; setBusy(false);
  }, [activeDocument?.id]);
  useEffect(() => {
    if (editingCardId && editingCardId !== floatingCardId) setEditingCardId(null);
  }, [editingCardId, floatingCardId]);

  const makeFlashcardsFromExcerpt = async (sourceText: string, page: number) => {
    if (!activeDocument || !activeProfile || !sourceText.trim() || busy || generation.current) return;
    const valid = capture(); const token = {}; generation.current = token;
    setBusy(true); setError('');
    try {
      const created = await generateFlashcards(activeDocument.id, {profile_id: activeProfile, page_number: page, excerpt: sourceText.trim()});
      if (!valid()) return;
      setFlashcards(items => [...created, ...items]); setRecognizedCardCount(created.length);
      if (created[0] && !editing.current) setFloatingCardId(created[0].id);
    } catch (error) {if (valid()) setError(error instanceof Error ? error.message : '卡片生成失败');}
    finally {if (valid() && generation.current === token) {generation.current = null; setBusy(false);}}
  };
  const removeFlashcard = async (id: string) => {
    if (!activeDocument) return;
    const valid = capture();
    try {await deleteFlashcard(activeDocument.id, id); if (valid()) {setFlashcards(items => items.filter(item => item.id !== id)); setFloatingCardId(current => current === id ? null : current); setEditingCardId(current => current === id ? null : current);}}
    catch (error) {if (valid()) setError(error instanceof Error ? error.message : '删除失败');}
  };
  const addManualCard = async () => {
    if (!activeDocument || !manualQuestion.trim() || !manualAnswer.trim()) return;
    const valid = capture();
    try {
      const card = await createFlashcard(activeDocument.id, {page_number: currentPage, source_excerpt: excerpt.trim(), question: manualQuestion.trim(), answer: manualAnswer.trim(), explanation: manualExplanation.trim()});
      if (valid()) {setFlashcards(items => [card, ...items]); setManualQuestion(''); setManualAnswer(''); setManualExplanation('');}
    } catch (error) {if (valid()) setError(error instanceof Error ? error.message : '卡片保存失败');}
  };
  const markCard = async (card: Flashcard, mastered: boolean) => {
    if (!activeDocument) return;
    const valid = capture();
    try {
      const updated = await reviewFlashcard(activeDocument.id, card.id, mastered);
      if (valid()) setFlashcards(items => items.map(item => item.id === card.id && updated.review_count >= item.review_count
        ? {...item, review_count: updated.review_count, mastered: updated.mastered, last_reviewed_at: updated.last_reviewed_at} : item));
    }
    catch (error) {if (valid()) setError(error instanceof Error ? error.message : '复习状态保存失败');}
  };
  const editCard = (card: Flashcard) => {
    setFloatingCardId(card.id);
    setEditingCardId(card.id);
  };
  const saveCard = async (id: string, question: string, answer: string, explanation: string) => {
    if (!activeDocument) return;
    const valid = capture();
    const updated = await updateFlashcard(activeDocument.id, id, question.trim(), answer.trim(), explanation.trim());
    if (!valid()) return;
    setFlashcards(items => items.map(item => item.id === id
      ? {...item, question: updated.question, answer: updated.answer, explanation: updated.explanation} : item));
    setEditingCardId(current => current === id ? null : current);
  };
  return {flashcards, setFlashcards, manualQuestion, setManualQuestion, manualAnswer, setManualAnswer, manualExplanation, setManualExplanation,
    floatingCardId, setFloatingCardId, recognizedCardCount, setRecognizedCardCount, makeFlashcardsFromExcerpt,
    makeFlashcards: () => makeFlashcardsFromExcerpt(excerpt, currentPage), removeFlashcard, addManualCard, markCard, editCard, editingCardId, setEditingCardId, saveCard};
}
