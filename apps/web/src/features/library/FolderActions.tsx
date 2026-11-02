import {useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import type {FolderRecord} from '../../api';

type Props={folder:FolderRecord; onRename:(folder:FolderRecord)=>void; onDelete:(folder:FolderRecord)=>void};
export function FolderActions({folder,onRename,onDelete}:Props){
 const [open,setOpen]=useState(false),[position,setPosition]=useState({top:0,left:0});
 const trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
 const close=(restore=false)=>{setOpen(false);if(restore)trigger.current?.focus();};
 useLayoutEffect(()=>{
  if(!open)return;
  const anchor=trigger.current!,panel=menu.current!;
  const place=()=>{
   const box=anchor.getBoundingClientRect(),size=panel.getBoundingClientRect();
   setPosition({left:Math.max(12,Math.min(box.right-size.width,window.innerWidth-size.width-12)),
    top:Math.max(12,box.bottom+6+size.height<=window.innerHeight-12?box.bottom+6:box.top-size.height-6)});
  };
  place();panel.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});
  const outside=(event:PointerEvent)=>{if(!panel.contains(event.target as Node)&&!anchor.contains(event.target as Node))close();};
  const scroll=(event:Event)=>{if(!panel.contains(event.target as Node)){const box=anchor.getBoundingClientRect();if(box.bottom<0 || box.top>window.innerHeight)close();else place();}};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close(true);}};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
  window.addEventListener('resize',place);document.addEventListener('scroll',scroll,true);
  return ()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);window.removeEventListener('resize',place);document.removeEventListener('scroll',scroll,true);};
 },[open]);
 return <><button ref={trigger} className="folder-actions-trigger" aria-label={`${folder.name} 文件夹设置`} aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>···</button>
 {open&&createPortal(<div ref={menu} className="folder-actions-menu" role="menu" aria-label={`${folder.name} 文件夹操作`} style={position} onKeyDown={event=>{
  const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
  if(event.key==='Tab'){event.preventDefault();close(true);}
 }}><strong>{folder.name}</strong><button role="menuitem" onClick={()=>{close(true);onRename(folder);}}>重命名</button><button role="menuitem" className="danger-text" onClick={()=>{close(true);onDelete(folder);}}>删除文件夹</button><small>删除分类后，教材回到未分类</small></div>,document.body)}</>;
}
