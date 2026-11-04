import type {PointerEventHandler} from 'react';
import type {useFlashcards} from './useFlashcards';
import {formatCardQuestion} from './formatCardQuestion';
import {FlashcardEditor} from './FlashcardEditor';
type Props = {practice: ReturnType<typeof useFlashcards>; floatingCardOffset: {x: number; y: number}; beginFloatingCardDrag: PointerEventHandler<HTMLElement>; requestReaderPage: (page: number) => void};
export function FloatingQuestion({practice, floatingCardOffset, beginFloatingCardDrag, requestReaderPage}: Props) {
  const {flashcards, floatingCardId, setFloatingCardId, markCard, editingCardId, setEditingCardId, editCard, saveCard} = practice;
  const floatingCardIndex = flashcards.findIndex(item => item.id === floatingCardId);
  const floatingCard = flashcards[floatingCardIndex];
  const floatingCardTotal = flashcards.length;
  if (!floatingCard) return null;
  const editing = editingCardId === floatingCard.id;
  return <section className="floating-question-card" style={{transform: `translate3d(${floatingCardOffset.x}px, ${floatingCardOffset.y}px, 0)`}} aria-label="题目悬浮窗">
      <header onPointerDown={beginFloatingCardDrag}>
        <div><small>题目 {floatingCardIndex + 1} / {floatingCardTotal}</small><strong>问答卡片</strong></div>
        <nav onPointerDown={event => event.stopPropagation()}><button aria-label="上一题" disabled={editing || floatingCardIndex <= 0} onClick={() => setFloatingCardId(flashcards[floatingCardIndex - 1]?.id || null)}>←</button><button aria-label="下一题" disabled={editing || floatingCardIndex >= floatingCardTotal - 1} onClick={() => setFloatingCardId(flashcards[floatingCardIndex + 1]?.id || null)}>→</button><button aria-label="关闭题目悬浮窗" disabled={editing} onClick={() => setFloatingCardId(null)}>×</button></nav>
      </header>
      <div className="floating-card-body" key={`${floatingCard.id}:${editing}`}>
        {editing ? <FlashcardEditor card={floatingCard} onSave={saveCard} onCancel={() => setEditingCardId(null)}/> : <>
          <span>{floatingCard.page_number ? `PDF 第 ${floatingCard.page_number} 页` : '知识卡片'} · 复习 {floatingCard.review_count || 0} 次</span>
          <h3 className="card-source-text">{formatCardQuestion(floatingCard.question)}</h3>
          <section><small>参考答案</small><p className="card-source-text">{floatingCard.answer}</p></section>
          {floatingCard.explanation && <section><small>解释</small><p className="card-source-text">{floatingCard.explanation}</p></section>}
        </>}
      </div>
      {!editing && <footer><button onClick={() => editCard(floatingCard)}>编辑卡片</button><button onClick={() => void markCard(floatingCard, false)}>还需复习</button><button className={floatingCard.mastered ? 'active' : ''} onClick={() => void markCard(floatingCard, true)}>已掌握</button>{floatingCard.page_number && <button onClick={() => requestReaderPage(floatingCard.page_number!)}>回到原题</button>}</footer>}
    </section>;
}
