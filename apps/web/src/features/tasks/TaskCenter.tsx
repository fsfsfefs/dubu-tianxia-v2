import {BackgroundTask, DocumentRecord} from '../../api';
type Props = {
  taskCenterOpen: boolean; activeTaskCount: number; activeDocument: DocumentRecord | null; documents: DocumentRecord[];
  backgroundTasks: BackgroundTask[]; preparing: boolean; chapterSummaryProgress: string;
  onToggle: () => void; onClose: () => void; onCancelPrepare: () => void;
  onIndex: (ids: string[]) => void; onClear: () => void; onPause: (id: string) => void;
  onCancel: (id: string) => void; onRetry: (id: string) => void; onView: (doc: DocumentRecord) => void;
  describeTaskError: (message: string) => string;
};
export function TaskCenter({taskCenterOpen, activeTaskCount, activeDocument, documents, backgroundTasks, preparing, chapterSummaryProgress, onToggle, onClose, onCancelPrepare, onIndex, onClear, onPause, onCancel, onRetry, onView, describeTaskError}: Props) {
  const taskStatusLabel = (status: BackgroundTask['status']) => ({
    queued: '排队中', running: '运行中', cancelling: '取消中', paused: '已暂停',
    completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消',
  })[status];
  return <>
    <button className="task-center-trigger" aria-expanded={taskCenterOpen} onClick={() => onToggle()}>任务中心{activeTaskCount > 0 && <b>{activeTaskCount}</b>}</button>
    {taskCenterOpen && <aside className="task-center" aria-label="后台任务中心"><header><div><small>BACKGROUND TASKS</small><h2>任务中心</h2></div><button aria-label="关闭任务中心" onClick={() => onClose()}>×</button></header>
      <div className="task-center-actions"><button disabled={!activeDocument} onClick={() => activeDocument && void onIndex([activeDocument.id])}>索引当前教材</button><button disabled={!documents.length} onClick={() => void onIndex(documents.map(item => item.id))}>索引全部教材</button><button disabled={!backgroundTasks.some(task => ['completed', 'partial', 'failed', 'cancelled'].includes(task.status))} onClick={() => void onClear()}>清除已结束</button></div>
      <div className="task-list">{preparing && <article className="task-card"><header><strong>准备总结原文</strong><span>尚未提交后台</span></header><p>{chapterSummaryProgress}</p><button onClick={onCancelPrepare}>取消准备</button></article>}{backgroundTasks.map(task => {
        const percent = task.total > 0 ? Math.min(100, Math.round(task.progress / task.total * 100)) : 0;
        const active = ['queued', 'running', 'cancelling'].includes(task.status);
        return <article className={`task-card ${task.status}`} key={task.id}><header><div><strong>{task.title}</strong><small>{task.document_title || '本地教材'}</small></div><span>{taskStatusLabel(task.status)}</span></header><progress max="100" value={percent}/><div className="task-progress"><span>{task.message || '等待处理'}</span><b>{task.total ? `${task.progress}/${task.total}` : `${percent}%`}</b></div>{task.error && <p>{describeTaskError(task.error)}</p>}{Boolean(task.result.missing_chapters?.length) && <details className="task-gaps"><summary>待补充清单（本次任务 {task.result.missing_chapters!.length} 处）</summary><ul>{task.result.missing_chapters!.map(gap => <li key={gap.chapter_key}><strong>{gap.title}</strong><span>PDF {gap.start_page}-{gap.end_page} · 内容审核未通过，待人工补充</span></li>)}</ul></details>}<footer><time>{task.updated_at}</time>{task.task_type === 'structure-summary' && task.document_id && <button onClick={() => {const document = documents.find(item => item.id === task.document_id); if (document) onView(document);}}>查看教材</button>}{active && task.task_type === 'structure-summary' && task.status !== 'cancelling' && <button onClick={() => onPause(task.id)}>暂停</button>}{active && task.status !== 'cancelling' && <button onClick={() => void onCancel(task.id)}>取消</button>}{['paused', 'partial', 'failed', 'cancelled'].includes(task.status) && <button onClick={() => void onRetry(task.id)}>重新执行</button>}</footer></article>;
      })}{!backgroundTasks.length && <div className="task-empty"><span>◎</span><p>还没有后台任务。</p><small>导入 PDF 后会自动建立文字层与混合 RAG 索引。</small></div>}</div>
    </aside>}
  </>;
}
