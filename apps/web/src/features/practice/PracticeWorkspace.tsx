import type {useFlashcards} from './useFlashcards';
type Props = {practice: ReturnType<typeof useFlashcards>; canGenerate: boolean; busy: boolean; error: string; onOpenCard: (id: string) => void};
export function PracticeWorkspace({practice, canGenerate, busy, error, onOpenCard}: Props) {
  const {flashcards, recognizedCardCount, makeFlashcards, manualQuestion, setManualQuestion, manualAnswer, setManualAnswer,
    addManualCard, editCard, removeFlashcard} = practice;
  return <div className="cards-workspace">
        <div className="card-generator question-recognizer">
          <div><strong>框选自动识题</strong><p>在 PDF 中启用“框选”，圈住题目区域后会自动识别其中全部问题并生成答案，不限制题目个数。</p></div>
          {recognizedCardCount > 0 && <span>本次识别 {recognizedCardCount} 题</span>}
          <button disabled={!canGenerate || busy} onClick={makeFlashcards}>{busy ? '正在识别全部问题…' : '重新识别当前框选'}</button>
        </div>
        <details className="manual-card compact-manual"><summary>手动补充卡片</summary><div><input value={manualQuestion} onChange={event => setManualQuestion(event.target.value)} placeholder="手工卡片问题"/><textarea value={manualAnswer} onChange={event => setManualAnswer(event.target.value)} placeholder="答案"/><button disabled={!manualQuestion.trim() || !manualAnswer.trim()} onClick={() => void addManualCard()}>添加卡片</button></div></details>
        <div className="flashcard-list">
          {flashcards.map(card => <article className={`flashcard ${card.mastered ? 'mastered' : ''}`} key={card.id} onClick={() => {onOpenCard(card.id);}}>
            <div className="flashcard-meta"><span>{card.page_number ? `第 ${card.page_number} 页` : '知识卡片'} · 复习 {card.review_count || 0} 次</span><span><button onClick={event => {event.stopPropagation(); void editCard(card);}}>编辑</button><button onClick={event => {event.stopPropagation(); void removeFlashcard(card.id);}}>删除</button></span></div>
            <strong>{card.question}</strong>
            <small>{card.mastered ? '✓ 已掌握 · 点击打开题目' : '点击在右侧悬浮窗中查看问题与答案'}</small>
          </article>)}
          {!flashcards.length && <div className="assistant-welcome"><span>◇</span><p>点击阅读器顶部“框选”，圈住一道或多道题目，系统会自动识别全部问题并生成答案。</p></div>}
        </div>
        {error && <div className="error">{error}</div>}
      </div>;
}
