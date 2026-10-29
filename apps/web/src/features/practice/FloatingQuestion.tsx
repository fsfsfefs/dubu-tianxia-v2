import type {PointerEventHandler} from 'react';
import type {useFlashcards} from './useFlashcards';
type Props = {practice: ReturnType<typeof useFlashcards>; floatingCardOffset: {x: number; y: number}; beginFloatingCardDrag: PointerEventHandler<HTMLElement>; requestReaderPage: (page: number) => void};
export function FloatingQuestion({practice, floatingCardOffset, beginFloatingCardDrag, requestReaderPage}: Props) {
  const {flashcards, floatingCardId, setFloatingCardId, markCard} = practice;
  const floatingCardIndex = flashcards.findIndex(item => item.id === floatingCardId);
  const floatingCard = flashcards[floatingCardIndex];
  const floatingCardTotal = flashcards.length;
  if (!floatingCard) return null;
  return <section className="floating-question-card" style={{transform: `translate3d(${floatingCardOffset.x}px, ${floatingCardOffset.y}px, 0)`}} aria-label="题目悬浮窗">
      <header onPointerDown={beginFloatingCardDrag}>
        <div><small>题目 {floatingCardIndex + 1} / {floatingCardTotal}</small><strong>问答卡片</strong></div>
        <nav onPointerDown={event => event.stopPropagation()}><button aria-label="上一题" disabled={floatingCardIndex <= 0} onClick={() => setFloatingCardId(flashcards[floatingCardIndex - 1]?.id || null)}>←</button><button aria-label="下一题" disabled={floatingCardIndex >= floatingCardTotal - 1} onClick={() => setFloatingCardId(flashcards[floatingCardIndex + 1]?.id || null)}>→</button><button aria-label="关闭题目悬浮窗" onClick={() => setFloatingCardId(null)}>×</button></nav>
      </header>
      <div className="floating-card-body"><span>{floatingCard.page_number ? `PDF 第 ${floatingCard.page_number} 页` : '知识卡片'} · 复习 {floatingCard.review_count || 0} 次</span><h3>{floatingCard.question}</h3><section><small>参考答案</small><p>{floatingCard.answer}</p></section></div>
      <footer><button onClick={() => void markCard(floatingCard, false)}>还需复习</button><button className={floatingCard.mastered ? 'active' : ''} onClick={() => void markCard(floatingCard, true)}>已掌握</button>{floatingCard.page_number && <button onClick={() => requestReaderPage(floatingCard.page_number!)}>回到原题</button>}</footer>
    </section>;
}
