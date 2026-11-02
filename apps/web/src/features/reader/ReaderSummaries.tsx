import {useLayoutEffect, useRef, useState} from 'react';
import type {ChapterSummary} from '../../api';
import {SummaryContent} from '../../StructuredContent';

type Props = {active: boolean; page: number; summaries: ChapterSummary[]; onJump: (page: number) => void; onClose: () => void; onPages: () => void; onOutline: () => void};
function historical(key: string) {return !key.endsWith(':__book__') && !key.includes(':ch-');}
export function ReaderSummaries({active, page, summaries, onJump, onClose, onPages, onOutline}: Props) {
  const [selectedKey, setSelectedKey] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const returnOffset = useRef(0);
  const ordered = [...summaries].sort((a,b) => a.start_page - b.start_page || a.depth - b.depth || a.end_page - b.end_page);
  const current = ordered.filter(item => !historical(item.chapter_key) && !item.chapter_key.endsWith(':__book__') && item.start_page <= page && item.end_page >= page)
    .sort((a,b) => b.depth - a.depth || (a.end_page-a.start_page) - (b.end_page-b.start_page))[0]
    || ordered.find(item => item.chapter_key.endsWith(':__book__'));
  const selected = ordered.find(item => item.chapter_key === selectedKey) || current || ordered[0];
  useLayoutEffect(() => {
    if (active && scroller.current) scroller.current.scrollTop = returnOffset.current;
  }, [active]);
  return <aside className="reader-side-panel reader-summary-panel" aria-label="PDF章节总结" hidden={!active}>
    <header><nav><button onClick={onPages}>页面</button><button onClick={onOutline}>目录</button><button className="active" aria-selected="true">总结</button></nav><button aria-label="关闭章节总结" onClick={onClose}>×</button></header>
    <div className="reader-summary-picker"><label>查看已保存总结<select aria-label="查看章节总结" value={selected?.chapter_key || ''} onChange={event => {setSelectedKey(event.target.value); returnOffset.current = 0; if(scroller.current) scroller.current.scrollTop=0;}}>
      {!ordered.length && <option value="">尚无已保存总结</option>}
      {ordered.map(item => <option key={item.chapter_key} value={item.chapter_key}>{item.title}{historical(item.chapter_key) ? '（历史总结，章节待确认）' : ''} · PDF {item.start_page}-{item.end_page}</option>)}
    </select></label><button disabled={!current} onClick={() => {setSelectedKey(current?.chapter_key || ''); returnOffset.current=0; if(scroller.current) scroller.current.scrollTop=0;}}>查看本页章节</button></div>
    <div className="reader-summary-content" ref={scroller}>
      {selected ? <><h2>{selected.title}</h2>{historical(selected.chapter_key) && <p role="status">旧总结已保留，尚未可靠匹配当前目录；可阅读和跳转页码，请勿将其视为已确认的本章总结。</p>}<p>PDF {selected.start_page}-{selected.end_page}</p><SummaryContent value={selected.content} onPageReference={(target) => {
        setSelectedKey(selected.chapter_key);
        returnOffset.current=scroller.current?.scrollTop || 0;
        onJump(target);
      }}/></> : <p>这本教材尚无已保存总结，请到教材总览生成或导入章节总结。</p>}
    </div>
  </aside>;
}
