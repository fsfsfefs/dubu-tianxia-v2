import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {RefObject,Dispatch,SetStateAction} from 'react';
export const clampZoom=(value:number)=>Math.max(.5,Math.min(3,Math.round(value*1000)/1000));
export function pageContentTop(root:HTMLElement,page:HTMLElement){return page.getBoundingClientRect().top-root.getBoundingClientRect().top+root.scrollTop-root.clientTop;}
type Point={x:number;y:number};
type Anchor={page:number;x:number;y:number;client:Point};
type Contact={point:Point;start:Point;target:Element|null;delegate:boolean;scrollX:number;scrollY:number;dragging:boolean};
type Session={kind:'wheel'|'touch';base:number;value:number;anchor:Anchor;center:Point;distance:number};
type Options={documentId:string;enabled:boolean;zoom:number;setZoom:Dispatch<SetStateAction<number>>;root:RefObject<HTMLDivElement|null>;stage:RefObject<HTMLDivElement|null>;status:RefObject<HTMLOutputElement|null>;touchWrites:boolean;regionMode:boolean;onTouchGesture:()=>void};
function findAnchor(root:HTMLElement,point:Point):Anchor|null{
 const pages=[...root.querySelectorAll<HTMLElement>('[data-page-number]')];
 const page=pages.sort((a,b)=>{const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return Math.max(ar.top-point.y,point.y-ar.bottom,0)-Math.max(br.top-point.y,point.y-br.bottom,0);})[0];
 if(!page)return null;const box=page.getBoundingClientRect();
 return {page:Number(page.dataset.pageNumber),x:(point.x-box.left)/Math.max(1,box.width),y:(point.y-box.top)/Math.max(1,box.height),client:point};
}
export function useReaderZoom(options:Options){
 const config=useRef(options);config.current=options;
 const pending=useRef<Anchor|null>(null),reset=useRef<()=>void>(()=>{}),anchorFrame=useRef<number|null>(null);
 const [wheelDirect,setWheelDirect]=useState(()=>{try{return localStorage.getItem('reader-next-wheel-zoom')==='true';}catch{return false;}});
 const wheelSetting=useRef(wheelDirect);wheelSetting.current=wheelDirect;
 useEffect(()=>{try{localStorage.setItem('reader-next-wheel-zoom',String(wheelDirect));}catch{}},[wheelDirect]);
 const clearPreview=useCallback(()=>{const stage=options.stage.current;if(stage){stage.style.transform='';stage.style.transformOrigin='';stage.style.willChange='';}if(options.root.current)delete options.root.current.dataset.zoomPreview;},[options.stage,options.root]);
 const restoreAnchor=useCallback((anchor:Anchor)=>{
  const root=options.root.current,page=root?.querySelector<HTMLElement>(`[data-page-number="${anchor.page}"]`);if(!root || !page)return;
  const box=page.getBoundingClientRect();
  root.scrollLeft+=box.left+anchor.x*box.width-anchor.client.x;
  root.scrollTop+=box.top+anchor.y*box.height-anchor.client.y;
 },[options.root]);
 useLayoutEffect(()=>{
  if(pending.current){const anchor=pending.current;pending.current=null;clearPreview();restoreAnchor(anchor);anchorFrame.current=requestAnimationFrame(()=>{anchorFrame.current=null;restoreAnchor(anchor);});}
  return()=>{if(anchorFrame.current!==null){cancelAnimationFrame(anchorFrame.current);anchorFrame.current=null;}};
 },[options.zoom,clearPreview,restoreAnchor]);
 const cancelZoom=useCallback(()=>{pending.current=null;if(anchorFrame.current!==null){cancelAnimationFrame(anchorFrame.current);anchorFrame.current=null;}reset.current();},[]);
 const changeZoom=useCallback((value:number)=>{
  const root=options.root.current;if(!root)return;cancelZoom();
  const box=root.getBoundingClientRect(),anchor=findAnchor(root,{x:box.left+root.clientWidth/2,y:box.top+root.clientHeight/2});
  if(anchor)pending.current=anchor;config.current.setZoom(clampZoom(value));
 },[options.root,cancelZoom]);
 useEffect(()=>{
  const root=options.root.current,stage=options.stage.current;if(!root || !stage || !options.enabled)return;
  const contacts=new Map<number,Contact>(),pens=new Set<number>();
  let session:Session|null=null,locked=false,wheelTimer:ReturnType<typeof setTimeout>|undefined,statusTimer:ReturnType<typeof setTimeout>|undefined;
  const show=(value:number)=>{const status=options.status.current;if(!status)return;status.textContent=`${Math.round(value*100)}%`;status.dataset.visible='true';clearTimeout(statusTimer);statusTimer=setTimeout(()=>delete status.dataset.visible,750);};
  const clear=()=>{clearTimeout(wheelTimer);session=null;clearPreview();};
  reset.current=clear;
  const begin=(kind:Session['kind'],point:Point,distance=1)=>{
   const anchor=findAnchor(root,point);if(!anchor)return null;
   const bounds=stage.getBoundingClientRect();stage.style.transformOrigin=`${point.x-bounds.left}px ${point.y-bounds.top}px`;stage.style.willChange='transform';root.dataset.zoomPreview='true';
   session={kind,base:config.current.zoom,value:config.current.zoom,anchor,center:point,distance};return session;
  };
  const preview=(current:Session,value:number,center=current.anchor.client)=>{
   current.value=clampZoom(value);current.center=center;
   stage.style.transform=`translate(${center.x-current.anchor.client.x}px,${center.y-current.anchor.client.y}px) scale(${current.value/current.base})`;
   show(current.value);
  };
  const finish=()=>{
   clearTimeout(wheelTimer);const current=session;session=null;if(!current)return;
   const anchor={...current.anchor,client:current.center};
   if(current.value===config.current.zoom){clearPreview();restoreAnchor(anchor);}
   else{pending.current=anchor;config.current.setZoom(current.value);}
   show(current.value);
  };
  const wheel=(event:WheelEvent)=>{
   if(!event.ctrlKey && !wheelSetting.current)return;
   if(!event.deltaY)return;
   event.preventDefault();if(pens.size || contacts.size)return;
   const current=session?.kind==='wheel'?session:begin('wheel',{x:event.clientX,y:event.clientY});if(!current)return;
   const pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?root.clientHeight:1);
   preview(current,current.value*Math.exp(-Math.max(-400,Math.min(400,pixels))*.002));
   clearTimeout(wheelTimer);wheelTimer=setTimeout(finish,160);
  };
  const capture=(id:number)=>{try{root.setPointerCapture(id);}catch{}};
  const cancelTouchDrawing=()=>{root.dispatchEvent(new Event('reader-touch-gesture'));config.current.onTouchGesture();window.getSelection()?.removeAllRanges();};
  const down=(event:PointerEvent)=>{
   if(event.pointerType==='pen'){pens.add(event.pointerId);clear();locked=false;contacts.clear();return;}
   if(event.pointerType!=='touch')return;
   if(pens.size){event.preventDefault();event.stopPropagation();return;}
   if(session?.kind==='wheel')clear();
   const target=event.target instanceof Element?event.target:null;
   const delegate=!!target?.closest('.region-capture') && config.current.regionMode || !!target?.closest('.annotation-layer.active') && config.current.touchWrites;
   contacts.set(event.pointerId,{point:{x:event.clientX,y:event.clientY},start:{x:event.clientX,y:event.clientY},target,delegate,scrollX:root.scrollLeft,scrollY:root.scrollTop,dragging:false});
   if(contacts.size>=2){
    event.preventDefault();event.stopPropagation();cancelTouchDrawing();locked=true;
    for(const id of contacts.keys())capture(id);
    if(contacts.size===2){const [a,b]=[...contacts.values()].map(value=>value.point);begin('touch',{x:(a.x+b.x)/2,y:(a.y+b.y)/2},Math.max(16,Math.hypot(a.x-b.x,a.y-b.y)));}
   }
  };
  const move=(event:PointerEvent)=>{
   if(event.pointerType!=='touch')return;const contact=contacts.get(event.pointerId);if(!contact)return;
   contact.point={x:event.clientX,y:event.clientY};
   if(locked){
    event.preventDefault();event.stopPropagation();
    if(contacts.size===2 && session?.kind==='touch'){
     const [a,b]=[...contacts.values()].map(value=>value.point);
     preview(session,session.base*Math.hypot(a.x-b.x,a.y-b.y)/session.distance,{x:(a.x+b.x)/2,y:(a.y+b.y)/2});
    }
    return;
   }
   if(contact.delegate)return;
   const dx=event.clientX-contact.start.x,dy=event.clientY-contact.start.y;
   if(!contact.dragging && Math.hypot(dx,dy)<5)return;
   if(!contact.dragging){contact.dragging=true;capture(event.pointerId);cancelTouchDrawing();window.getSelection()?.removeAllRanges();}
   event.preventDefault();event.stopPropagation();root.scrollLeft=contact.scrollX-dx;root.scrollTop=contact.scrollY-dy;
  };
  const end=(event:PointerEvent)=>{
   if(event.pointerType==='pen'){pens.delete(event.pointerId);return;}
   const contact=contacts.get(event.pointerId);if(!contact)return;
   if(locked || contact.dragging){event.preventDefault();event.stopPropagation();}
   contacts.delete(event.pointerId);
   if(session?.kind==='touch' && contacts.size<2){if(event.type==='pointercancel')clear();else finish();}
   if(!contacts.size)locked=false;
  };
  const blur=()=>{clear();contacts.clear();pens.clear();locked=false;};
  const lost=(event:PointerEvent)=>{if(event.target===root && contacts.has(event.pointerId))end(event);};
  root.addEventListener('wheel',wheel,{passive:false});
  for(const [name,handler] of [['pointerdown',down],['pointermove',move],['pointerup',end],['pointercancel',end],['lostpointercapture',lost]] as const)root.addEventListener(name,handler,{capture:true,passive:false});
  window.addEventListener('blur',blur);
  return()=>{clear();clearTimeout(statusTimer);pending.current=null;contacts.clear();pens.clear();reset.current=()=>{};root.removeEventListener('wheel',wheel);for(const [name,handler] of [['pointerdown',down],['pointermove',move],['pointerup',end],['pointercancel',end],['lostpointercapture',lost]] as const)root.removeEventListener(name,handler,true);window.removeEventListener('blur',blur);};
 },[options.root,options.stage,options.status,options.documentId,options.enabled,clearPreview,restoreAnchor]);
 return {wheelDirect,setWheelDirect,changeZoom,cancelZoom};
}
