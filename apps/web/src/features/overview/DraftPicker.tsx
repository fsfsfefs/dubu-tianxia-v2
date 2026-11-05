import {lazy, Suspense, useRef, useState, type ReactNode} from 'react';
import {draftFile, type ChapterDrafts, type DraftScope} from './chapterDrafts';

const DraftPreview = lazy(() => import('./DraftPreview'));

export function DraftPicker({model, chapterKey, scope, onJump, children}: {
  model: ChapterDrafts; chapterKey: string; scope?: DraftScope;
  onJump: (page: number, label: string) => void; children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const options = model.drafts.filter(item => item.chapter_key === chapterKey);
  const draft = options.find(item => item.id === model.selection[chapterKey]);
  return <>
    {(scope || options.length > 0 || model.error) && <div className="chapter-draft-controls">
      {options.length > 0 && <label>查看版本 <select aria-label="查看总结版本" value={draft?.id || ''} onChange={event => model.select(chapterKey, event.target.value)}>
        <option value="">原有总结</option>
        {options.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {item.filename}</option>)}
      </select></label>}
      {scope && <><button type="button" disabled={busy} onClick={() => picker.current?.click()}>{busy ? '正在导入…' : '导入其他生成'}</button>
        <input type="file" hidden ref={picker} accept=".pdf,.docx,.md,.txt" onChange={async event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (!file) return;
          setBusy(true); setError('');
          try {const uploaded = await model.upload(scope, file); model.select(chapterKey, uploaded.id);}
          catch (reason) {setError(reason instanceof Error ? reason.message : '导入失败。');}
          finally {setBusy(false);}
        }}/></>}
      {(error || model.error) && <span role="alert">{error || model.error}</span>}
    </div>}
    {draft ? <section className="chapter-draft" aria-label="导入稿预览">
      <header><strong>{draft.filename}</strong><a href={draftFile(draft)} download={draft.filename}>下载原文件</a></header>
      <Suspense fallback={<p role="status">正在加载导入稿预览…</p>}><DraftPreview key={draft.id} draft={draft} page={model.previewPages[draft.id] || 1} setPage={page => model.setPreviewPage(draft.id, page)} onJump={onJump} onAdd={link => model.addLink(draft, link)}/></Suspense>
    </section> : children}
  </>;
}
