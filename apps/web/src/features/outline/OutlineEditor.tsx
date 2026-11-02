import {lazy, Suspense, useEffect, useRef, useState} from 'react';
import {getDocumentOutline, generateDocumentOutline, saveDocumentOutline, listProfiles, type DocumentOutline, type ModelProfile, type ImportedOutlineEntry} from '../../api';
const Preview=lazy(()=>import('./OutlinePreview'));
const collectSource: typeof import('../../chapterSummary').collectChapterSource=async(...args)=>(await import('../../chapterSummary')).collectChapterSource(...args);
type Props={documentId:string; onClose:()=>void; onSaved:(items:ImportedOutlineEntry[])=>void};
export function OutlineEditor({documentId,onClose,onSaved}:Props){
 const [metadata,setMetadata]=useState<DocumentOutline|null>(null);
 const [rows,setRows]=useState<ImportedOutlineEntry[]>([]);
 const [profiles,setProfiles]=useState<ModelProfile[]>([]),[profile,setProfile]=useState('');
 const [busy,setBusy]=useState('正在读取原文目录…'),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [preview,setPreview]=useState(1);
 const [modelStarted,setModelStarted]=useState<number|null>(null),[waitSeconds,setWaitSeconds]=useState(0);
 useEffect(()=>{
  if(modelStarted===null)return;
  const update=()=>setWaitSeconds(Math.floor((Date.now()-modelStarted)/1000));
  update();const timer=window.setInterval(update,1000);
  return ()=>window.clearInterval(timer);
 },[modelStarted]);
 const active=useRef(true),request=useRef<AbortController|null>(null),running=useRef(false);
 const dialog=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  active.current=true;const controller=new AbortController();request.current=controller;
  const previous=document.activeElement as HTMLElement|null;dialog.current?.focus();
  void Promise.all([getDocumentOutline(documentId,controller.signal),listProfiles().catch(()=>[])]).then(([data,models])=>{
   if(!active.current)return;setMetadata(data);setRows(data.outline);setProfiles(models);setProfile(models[0]?.id || '');setBusy('');
  }).catch(reason=>{if(active.current){setError(reason.message);setBusy('');}});
  return ()=>{active.current=false;request.current?.abort();previous?.focus();};
 },[documentId]);
 const change=(index:number,patch:Partial<ImportedOutlineEntry>)=>setRows(items=>items.map((item,i)=>i===index?{...item,...patch}:item));
 const move=(index:number,offset:number)=>setRows(items=>{const next=[...items];[next[index],next[index+offset]]=[next[index+offset],next[index]];return next;});
 const generate=async()=>{
  if(running.current || !profile || !metadata)return;
  running.current=true;const controller=new AbortController();request.current=controller;setError('');setNotice('');
  try{
   setBusy('准备全书文字…');
   await collectSource(documentId,1,undefined,p=>{if(active.current)setBusy(`准备原文 PDF ${p.page} · ${p.completed}/${p.total}${p.phase==='ocr'?' · OCR识别中':''}`);},controller.signal);
   if(controller.signal.aborted)return;
   setWaitSeconds(0);setModelStarted(Date.now());setBusy('AI正在生成目录草稿…');
   const draft=await generateDocumentOutline(documentId,profile,controller.signal);
   if(!active.current || controller.signal.aborted)return;
   setRows(draft.outline);setMetadata(draft);setNotice((draft.message || '')+(draft.unreadable_pages?` 有${draft.unreadable_pages}页未识别到文字，请特别核对。`:''));
  }catch(reason){if(active.current && !controller.signal.aborted)setError(reason instanceof Error?reason.message:'生成失败');}
  finally{running.current=false;if(active.current){setBusy('');setModelStarted(null);}}
 };
 const save=async()=>{
  if(running.current || !metadata)return;
  running.current=true;const controller=new AbortController();request.current=controller;setBusy('保存目录…');setError('');
  try{const data=await saveDocumentOutline(documentId,rows,metadata.revision,controller.signal);if(active.current){onSaved(data.outline);onClose();}}
  catch(reason){if(active.current)setError(reason instanceof Error?reason.message:'保存失败');}
  finally{running.current=false;if(active.current)setBusy('');}
 };
 return <div className="outline-editor-backdrop"><div className="outline-editor" role="dialog" aria-modal="true" aria-label="目录编辑与校对" tabIndex={-1} ref={dialog} onKeyDown={event=>{
  if(event.ctrlKey || event.metaKey)event.stopPropagation();
  if(event.key==='Escape' && busy!=='保存目录…'){event.stopPropagation();onClose();}
  if(event.key==='Tab'){
   const focusable=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')];
   const first=focusable[0],last=focusable.at(-1);
   if(event.shiftKey && (document.activeElement===first || document.activeElement===dialog.current)){event.preventDefault();last?.focus();}
   else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
  }
 }}>
  <header><div><h2>目录编辑与校对</h2><small>{metadata?`共 ${metadata.page_count} 页 · ${metadata.source==='pdf'?'已使用原文书签':metadata.source==='none'?'原文没有电子目录':metadata.source==='ai-draft'?'AI草稿，尚未保存':'已保存目录'}`:'读取中'}</small></div><button disabled={busy==='保存目录…'} onClick={onClose}>关闭</button></header>
  <p className="outline-editor-help">已有目录优先使用；没有时可用AI生成草稿。页码填写实际PDF页码（含封面），层级从0开始。修改标题、页码或层级后，原总结会保留，可能需要重新生成对应章节总结。</p>
  {(!metadata || metadata.source==='none' || metadata.source==='ai-draft') && <div className="outline-ai-controls"><label>生成目录模型<select aria-label="生成目录模型" value={profile} disabled={!!busy} onChange={e=>setProfile(e.target.value)}>{!profiles.length && <option value="">请先保存模型配置</option>}{profiles.map(item=><option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label><button disabled={!metadata || !profile || !!busy || metadata.page_count>3000} onClick={()=>void generate()}>AI生成目录草稿</button></div>}
  {metadata && metadata.page_count>3000 && <p>超过3000页，请人工编写或导入目录。</p>}{busy && <p role="status">{busy}{modelStarted!==null && ` 已等待${waitSeconds}秒，最多等待5分钟。可关闭窗口取消本次等待。`}</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  <div className="outline-editor-body"><div className="outline-editor-list"><div className="outline-column-labels">章节标题 / PDF页码 / 层级</div>{rows.map((row,index)=><div className="outline-edit-row" key={index}>
   <input aria-label={`第${index+1}项标题`} value={row.title} maxLength={500} disabled={!!busy} onChange={e=>change(index,{title:e.target.value})}/>
   <input aria-label={`第${index+1}项页码`} type="number" min="1" max={metadata?.page_count} value={row.page} disabled={!!busy} onChange={e=>change(index,{page:Number(e.target.value)})}/>
   <input aria-label={`第${index+1}项层级`} type="number" min="0" max="20" value={row.depth} disabled={!!busy} onChange={e=>change(index,{depth:Number(e.target.value)})}/>
   <nav><button onClick={()=>setPreview(Math.max(1,Math.min(metadata?.page_count || 1,row.page || 1)))}>校对原文</button><button aria-label={`上移第${index+1}项`} disabled={!!busy || index===0} onClick={()=>move(index,-1)}>↑</button><button aria-label={`下移第${index+1}项`} disabled={!!busy || index===rows.length-1} onClick={()=>move(index,1)}>↓</button><button aria-label={`删除第${index+1}项`} disabled={!!busy} onClick={()=>setRows(items=>items.filter((_,i)=>i!==index))}>删除</button></nav>
  </div>)}{!rows.length && !busy && <p>暂无目录，可使用AI草稿或手动添加章节。</p>}<button disabled={!!busy || !metadata || rows.length>=1000} onClick={()=>setRows(items=>[...items,{title:'新章节',page:items.at(-1)?.page || 1,depth:0}])}>＋ 添加章节</button></div>
  <div className="outline-preview"><label>校对原文页码<input aria-label="校对原文页码" type="number" min="1" max={metadata?.page_count || 1} value={preview} onChange={e=>setPreview(Math.max(1,Math.min(metadata?.page_count || 1,Number(e.target.value))))}/></label><Suspense fallback={<p>正在加载原文预览…</p>}><Preview documentId={documentId} page={preview}/></Suspense></div></div>
  <footer><span>草稿校对后保存，总览与阅读器同步使用。</span>{busy && busy!=='保存目录…' && running.current && <button onClick={()=>request.current?.abort()}>取消生成</button>}<button disabled={!metadata || !rows.length || !!busy} onClick={()=>void save()}>保存校对目录</button></footer>
 </div></div>;
}
