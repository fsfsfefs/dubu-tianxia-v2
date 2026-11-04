import {useState} from 'react';
import type {Flashcard} from '../../api';

type Props = {
  card: Flashcard;
  onSave: (id: string, question: string, answer: string, explanation: string) => Promise<void>;
  onCancel: () => void;
};

export function FlashcardEditor({card, onSave, onCancel}: Props) {
  const [question, setQuestion] = useState(card.question);
  const [answer, setAnswer] = useState(card.answer);
  const [explanation, setExplanation] = useState(card.explanation || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return <form className="flashcard-editor" aria-label="编辑答题卡片" onSubmit={async event => {
    event.preventDefault();
    if (saving || !question.trim() || !answer.trim()) return;
    setSaving(true);
    setError('');
    try {await onSave(card.id, question, answer, explanation);}
    catch (reason) {setError(reason instanceof Error ? reason.message : '卡片保存失败');}
    finally {setSaving(false);}
  }}>
    <label>题目<textarea rows={4} value={question} maxLength={12000} disabled={saving} onChange={event => setQuestion(event.target.value)}/></label>
    <label>答案<textarea rows={2} value={answer} maxLength={4000} disabled={saving} onChange={event => setAnswer(event.target.value)}/></label>
    <label>解释（选填）<textarea rows={5} value={explanation} maxLength={12000} disabled={saving} onChange={event => setExplanation(event.target.value)}/></label>
    {error && <p role="alert" className="error">{error}</p>}
    <div><button type="button" disabled={saving} onClick={onCancel}>取消</button><button type="submit" disabled={saving || !question.trim() || !answer.trim()}>{saving ? '保存中…' : '保存修改'}</button></div>
  </form>;
}
