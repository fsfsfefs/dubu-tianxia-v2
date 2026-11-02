import {useEffect,useRef,useState} from 'react';
import type {InkMark} from './inkMarks';
type Props={marks:InkMark[];onJump:(mark:InkMark)=>void;onRename:(mark:InkMark,name:string)=>Promise<void>;onDelete:(mark:InkMark)=>Promise<void>;onClose:()=>void};
export function InkMarkPanel({marks,onJump,onRename,onDelete,onClose}:Props){
 const [query,setQuery]=useState(''),[editing,setEditing]=useState<string|null>(null),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[alive]);
 const run=async(operation:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await operation();if(alive.current)setEditing(null);}catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:'操作失败');}finally{if(alive.current)setBusy(false);}};
 const visible=marks.filter(mark=>`${mark.name} PDF ${mark.page}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 return <aside className="ink-mark-panel" aria-label="手写标记管理"><header><strong>手写标记 · {marks.length}</strong><button aria-label="关闭标记列表" onClick={onClose}>×</button></header>
  <p>相邻笔画按区域记作一个标记，可命名并跳转原文。</p><input aria-label="搜索标记" placeholder="搜索名称或PDF页码" value={query} onChange={event=>setQuery(event.target.value)}/>
  {error && <p role="alert">{error}</p>}<div className="ink-mark-list">{visible.map(mark=><article key={`${mark.page}-${mark.surface}-${mark.id}`}>
   <strong>{mark.name}</strong><small>PDF {mark.page} · {mark.surface==='page'?'正文':mark.surface==='left'?'左侧留白':'右侧留白'} · {mark.members.length} 笔</small>
   {editing===mark.id && <label>标记名称<input aria-label="标记名称" maxLength={120} disabled={busy} value={name} onChange={event=>setName(event.target.value)}/></label>}
   <nav><button disabled={busy} onClick={()=>onJump(mark)}>跳转PDF第{mark.page}页</button>{editing===mark.id?<><button disabled={busy || !name.trim()} onClick={()=>void run(()=>onRename(mark,name))}>保存名称</button><button disabled={busy} onClick={()=>setEditing(null)}>取消</button></>:<button disabled={busy} onClick={()=>{setEditing(mark.id);setName(mark.name);}}>命名</button>}<button disabled={busy} onClick={()=>void run(()=>onDelete(mark))}>删除标记</button></nav>
  </article>)}{!visible.length && <p>{marks.length?'没有匹配的标记。':'还没有手写标记。使用标注工具在PDF或两侧留白书写即可。'}</p>}</div>
 </aside>;
}
