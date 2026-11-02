import {useEffect,useRef,useState} from 'react';
import type {NoteImage} from '../../api';
export const NOTE_IMAGE_LIMIT=20*1024*1024;
const types=new Set(['image/png','image/jpeg','image/webp','image/gif']);
export function noteImageError(files:File[],existingBytes=0):string{
 if(files.some(file=>!types.has(file.type)))return '仅支持PNG、JPEG、WebP和GIF图片。';
 if(files.some(file=>file.size>NOTE_IMAGE_LIMIT) || files.reduce((sum,file)=>sum+file.size,existingBytes)>NOTE_IMAGE_LIMIT)return '单张及每条便签的图片合计不能超过20MB。';
 return '';
}
export function NoteImages({images=[]}:{images?:NoteImage[]}){
 return <div className="sticky-images">{images.map(image=><a href={image.url} target="_blank" rel="noreferrer" key={image.id}><img src={image.url} alt="便签图片" loading="lazy"/></a>)}</div>;
}
export function StickyNoteEditor({content='',images=[],onSave,onCancel}:{content?:string;images?:NoteImage[];onSave:(content:string,files:File[],keepIds:string[])=>Promise<void>;onCancel?:()=>void}){
 const [text,setText]=useState(content),[kept,setKept]=useState(images),[files,setFiles]=useState<File[]>([]),[urls,setUrls]=useState<string[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const input=useRef<HTMLInputElement>(null),saving=useRef(false),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{const next=files.map(file=>URL.createObjectURL(file));setUrls(next);return()=>next.forEach(url=>URL.revokeObjectURL(url));},[files]);
 const attach=(incoming:File[])=>{
  const next=[...files,...incoming],problem=noteImageError(next,kept.reduce((sum,image)=>sum+image.byte_size,0));
  if(problem){setError(problem);return;}setFiles(next);setError('');
 };
 const save=async()=>{
  if(saving.current)return;saving.current=true;setBusy(true);setError('');
  try{await onSave(text.trim(),files,kept.map(image=>image.id));if(alive.current && !onCancel){setText('');setFiles([]);setKept([]);}}
  catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:'便签保存失败');}
  finally{saving.current=false;if(alive.current)setBusy(false);}
 };
 return <div className="sticky-note-editor" onPaste={event=>{
  if(busy)return;
  const incoming=Array.from(event.clipboardData.items).filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter((file):file is File=>!!file);
  if(incoming.length){event.preventDefault();attach(incoming);}
 }}>
  <textarea aria-label="便签内容" value={text} disabled={busy} onChange={event=>setText(event.target.value)} placeholder="记录想法，或在这里粘贴图片…"/>
  <div className="sticky-image-drafts">{kept.map(image=><div key={image.id}><img src={image.url} alt="已保存便签图片"/><button disabled={busy} aria-label="移除已保存图片" onClick={()=>setKept(items=>items.filter(item=>item.id!==image.id))}>×</button></div>)}{files.map((file,index)=><div key={index}><img src={urls[index]} alt="待保存便签图片"/><button disabled={busy} aria-label={`移除待保存图片${index+1}`} onClick={()=>setFiles(items=>items.filter((_,i)=>i!==index))}>×</button><small>{file.name}</small></div>)}</div>
  <input ref={input} hidden type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={event=>{attach(Array.from(event.target.files || []));event.target.value='';}}/>
  <small>可粘贴或上传图片，单张及每条便签合计≤20MB</small>{error && <p role="alert">{error}</p>}
  <footer><button type="button" disabled={busy} onClick={()=>input.current?.click()}>添加图片</button>{onCancel && <button disabled={busy} onClick={onCancel}>取消</button>}<button disabled={busy || (!text.trim() && !files.length && !kept.length)} onClick={()=>void save()}>{busy?'保存中…':onCancel?'保存便签':'添加便签'}</button></footer>
 </div>;
}
