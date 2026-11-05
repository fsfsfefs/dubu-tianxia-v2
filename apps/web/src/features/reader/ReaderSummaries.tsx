import {useLayoutEffect, useRef, useState} from 'react';
import type {ChapterSummary} from '../../api';
import {DraftPicker} from '../overview/DraftPicker';
import type {ChapterDrafts} from '../overview/chapterDrafts';
import type {ReaderInkTools} from './useAnnotations';
import {SummaryContent} from '../../StructuredContent';

type Props = {active: boolean; page: number; summaries: ChapterSummary[]; draftModel?: ChapterDrafts; inkTools?: ReaderInkTools; onJump: (page: number) => void; onClose: () => void; onPages: () => void; onOutline: () => void};
function historical(key: string) {return !key.endsWith(':__book__') && !key.includes(':ch-');}
export function ReaderSummaries({active, page, summaries, draftModel, inkTools, onJump, onClose, onPages, onOutline}: Props) {
  const [selectedKey, setSelectedKey] = useState('');
  const [toolsCollapsed, setToolsCollapsed] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const returnOffset = useRef(0);
  const chapters = new Map(summaries.map(item => [item.chapter_key, item]));
  for (const draft of draftModel?.drafts ?? []) {
    if (!chapters.has(draft.chapter_key)) chapters.set(draft.chapter_key, {
      chapter_key: draft.chapter_key, title: draft.chapter_title, start_page: draft.start_page,
      end_page: draft.end_page, depth: draft.depth, content: '',
    });
  }
  const ordered = [...chapters.values()].sort((a,b) => a.start_page - b.start_page || a.depth - b.depth || a.end_page - b.end_page);
  const current = ordered.filter(item => !historical(item.chapter_key) && !item.chapter_key.endsWith(':__book__') && item.start_page <= page && item.end_page >= page)
    .sort((a,b) => b.depth - a.depth || (a.end_page-a.start_page) - (b.end_page-b.start_page))[0]
    || ordered.find(item => item.chapter_key.endsWith(':__book__'));
  const selected = ordered.find(item => item.chapter_key === selectedKey) || current || ordered[0];
  useLayoutEffect(() => {
    if (active && scroller.current) scroller.current.scrollTop = returnOffset.current;
  }, [active]);
  const jump = (target: number) => {
    setSelectedKey(selected?.chapter_key || '');
    returnOffset.current = scroller.current?.scrollTop || 0;
    onJump(target);
  };
  const content = selected ? <>
    {historical(selected.chapter_key) && <p role="status">旧总结已保留，尚未可靠匹配当前目录；可阅读和跳转页码，请勿将其视为已确认的本章总结。</p>}
    {selected.content ? <SummaryContent value={selected.content} onPageReference={jump}/> : <p>本章尚无原有总结。可切换查看导入稿。</p>}
  </> : <p>这本教材尚无已保存总结，请到教材总览生成或导入章节总结。</p>;
  return <aside className="reader-side-panel reader-summary-panel" aria-label="PDF章节总结" hidden={!active} data-tools-collapsed={toolsCollapsed || undefined}>
    <header><nav><button onClick={onPages}>页面</button><button onClick={onOutline}>目录</button><button className="active" aria-selected="true">总结</button></nav><button type="button" className="reader-summary-tools-toggle" aria-expanded={!toolsCollapsed}
      onClick={() => setToolsCollapsed(value => !value)}>{toolsCollapsed ? '展开工具' : '收起工具'}</button><button aria-label="关闭章节总结" onClick={onClose}>×</button></header>
    <div className="reader-summary-picker"><label>查看已保存总结<select aria-label="查看章节总结" value={selected?.chapter_key || ''} onChange={event => {setSelectedKey(event.target.value); returnOffset.current = 0; if(scroller.current) scroller.current.scrollTop=0;}}>
      {!ordered.length && <option value="">尚无已保存总结</option>}
      {ordered.map(item => <option key={item.chapter_key} value={item.chapter_key}>{item.title}{historical(item.chapter_key) ? '（历史总结，章节待确认）' : ''} · PDF {item.start_page}-{item.end_page}</option>)}
    </select></label><button disabled={!current} onClick={() => {setSelectedKey(current?.chapter_key || ''); returnOffset.current=0; if(scroller.current) scroller.current.scrollTop=0;}}>查看本页章节</button></div>
    <div className="reader-summary-content" ref={scroller}>
      {selected && <><h2>{selected.title}</h2><p>PDF {selected.start_page}-{selected.end_page}</p></>}
      {selected && draftModel ? <DraftPicker key={selected.chapter_key} model={draftModel} inkTools={inkTools}
        chapterKey={selected.chapter_key} onJump={jump} toolsCollapsed={toolsCollapsed}>{content}</DraftPicker> : content}
    </div>
  </aside>;
}
