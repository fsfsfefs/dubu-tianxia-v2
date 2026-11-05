import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {RefObject,Dispatch,SetStateAction} from 'react';
import {penInContact} from './annotationInput';
import {pageAtViewportY} from './pageViewport';
import {horizontalPanOrigin, touchMomentum} from './touchPan';
export const clampZoom=(value:number)=>Math.max(.5,Math.min(3,Math.round(value*1000)/1000));
export function pageContentTop(root:HTMLElement,page:HTMLElement){return page.getBoundingClientRect().top-root.getBoundingClientRect().top+root.scrollTop-root.clientTop;}
type Point={x:number;y:number};
type Anchor={page:number;x:number;y:number;client:Point};
type PanStart={start:Point;scrollX:number;scrollY:number};
type Contact=PanStart&{point:Point;delegate:boolean;dragging:boolean;lastMove:number;velocity:Point;horizontalOrigin:number|null;verticalExtent:number};
type Session={kind:'wheel'|'touch';base:number;value:number;anchor:Anchor;center:Point;distance:number};
type Options={documentId:string;enabled:boolean;zoom:number;setZoom:Dispatch<SetStateAction<number>>;root:RefObject<HTMLDivElement|null>;stage:RefObject<HTMLDivElement|null>;status:RefObject<HTMLOutputElement|null>;touchWrites:boolean;regionMode:boolean;onTouchGesture:()=>void};
function findAnchor(stage:HTMLElement,point:Point):Anchor|null{
 const hit=pageAtViewportY(stage,point.y,true);
 if(!hit)return null;const {page,bounds:box}=hit;
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
  const root=options.root.current,stage=options.stage.current;if(!root || !stage)return;cancelZoom();
  const box=root.getBoundingClientRect(),anchor=findAnchor(stage,{x:box.left+root.clientWidth/2,y:box.top+root.clientHeight/2});
  if(anchor)pending.current=anchor;config.current.setZoom(clampZoom(value));
 },[options.root,options.stage,cancelZoom]);
 useEffect(()=>{
  const root=options.root.current,stage=options.stage.current;if(!root || !stage || !options.enabled)return;
  const contacts=new Map<number,Contact>(),pens=new Set<number>(),blockedTouches=new Set<number>();
  let mousePan:(PanStart&{id:number})|null=null;
  let momentumFrame:number|null=null;
  let session:Session|null=null,locked=false,wheelTimer:ReturnType<typeof setTimeout>|undefined,statusTimer:ReturnType<typeof setTimeout>|undefined;
  const show=(value:number)=>{const status=options.status.current;if(!status)return;status.textContent=`${Math.round(value*100)}%`;status.dataset.visible='true';clearTimeout(statusTimer);statusTimer=setTimeout(()=>delete status.dataset.visible,750);};
  const stopMomentum=()=>{if(momentumFrame!==null)cancelAnimationFrame(momentumFrame);momentumFrame=null;};
  const clear=()=>{stopMomentum();clearTimeout(wheelTimer);session=null;clearPreview();};
  const startMomentum=(velocity:ReturnType<typeof touchMomentum>)=>{
   if(window.matchMedia('(prefers-reduced-motion: reduce)').matches || Math.hypot(velocity.x,velocity.y)<.14)return;
   let {scrollLeft:x,scrollTop:y}=root;
   let vx=velocity.x,vy=velocity.y,last=performance.now();
   const step=(time:number)=>{
    momentumFrame=null;
    const elapsed=Math.max(0,Math.min(32,time-last));last=time;
    const maxX=root.scrollWidth-root.clientWidth,maxY=root.scrollHeight-root.clientHeight;
    const nextX=x+vx*elapsed,nextY=y+vy*elapsed;
    x=Math.max(0,Math.min(maxX,nextX));y=Math.max(0,Math.min(maxY,nextY));
    root.scrollLeft=x;root.scrollTop=y;
    const decay=Math.exp(-elapsed/velocity.decayTime);
    vx=x===nextX?vx*decay:0;vy=y===nextY?vy*decay:0;
    if(Math.hypot(vx,vy)>=.035)momentumFrame=requestAnimationFrame(step);
   };
   momentumFrame=requestAnimationFrame(step);
  };
  reset.current=clear;
  const begin=(kind:Session['kind'],point:Point,distance=1)=>{
   const anchor=findAnchor(stage,point);if(!anchor)return null;
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
   stopMomentum();
   if(!event.ctrlKey && !wheelSetting.current)return;
   if(!event.deltaY)return;
   event.preventDefault();if(pens.size || contacts.size || mousePan)return;
   const current=session?.kind==='wheel'?session:begin('wheel',{x:event.clientX,y:event.clientY});if(!current)return;
   const pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?root.clientHeight:1);
   preview(current,current.value*Math.exp(-Math.max(-400,Math.min(400,pixels))*.002));
   clearTimeout(wheelTimer);wheelTimer=setTimeout(finish,160);
  };
  const capture=(id:number)=>{try{root.setPointerCapture(id);}catch{}};
  const stopEvent=(event:Event)=>{event.preventDefault();event.stopPropagation();};
  const cancelTouchDrawing=()=>{root.dispatchEvent(new Event('reader-touch-gesture'));config.current.onTouchGesture();window.getSelection()?.removeAllRanges();};
  const stopMousePan=()=>{
   const id=mousePan?.id;
   mousePan=null;delete root.dataset.mousePanning;
   if(id!==undefined && root.hasPointerCapture(id))root.releasePointerCapture(id);
  };
  const panFrom=(event:PointerEvent):PanStart=>({start:{x:event.clientX,y:event.clientY},scrollX:root.scrollLeft,scrollY:root.scrollTop});
  const pan=(start:PanStart,dx:number,dy:number)=>{root.scrollLeft=start.scrollX-dx;root.scrollTop=start.scrollY-dy;};
  const trackPen=(event:PointerEvent)=>{
   const id=event.pointerId;
   if(!penInContact(event)){pens.delete(id);return;}
   if(pens.has(id))return;
   pens.add(id);stopMousePan();clear();locked=false;
   if(contacts.size)cancelTouchDrawing();
   // Contacts already on the screen stay rejected until they lift.
   for(const touchId of contacts.keys())blockedTouches.add(touchId);
   contacts.clear();
  };
  const down=(event:PointerEvent)=>{
   stopMomentum();
   if(event.pointerType==='pen'){trackPen(event);return;}
   if(event.pointerType==='mouse' && event.button===2){
    stopEvent(event);
    if(pens.size || contacts.size)return;
    clear();mousePan={...panFrom(event),id:event.pointerId};root.dataset.mousePanning='true';capture(event.pointerId);
    return;
   }
   if(event.pointerType!=='touch')return;
   if(pens.size || mousePan){blockedTouches.add(event.pointerId);stopEvent(event);return;}
   blockedTouches.delete(event.pointerId);
   if(session?.kind==='wheel')clear();
   const target=event.target instanceof Element?event.target:null;
   const delegate=!!target?.closest('.region-capture') && config.current.regionMode || !!target?.closest('.annotation-layer.active') && config.current.touchWrites;
   const start=panFrom(event);
   contacts.set(event.pointerId,{...start,point:start.start,delegate,dragging:false,lastMove:event.timeStamp,velocity:{x:0,y:0},horizontalOrigin:null,verticalExtent:0});
   if(contacts.size>=2){
    event.preventDefault();event.stopPropagation();cancelTouchDrawing();locked=true;
    for(const id of contacts.keys())capture(id);
    if(contacts.size===2){const [a,b]=[...contacts.values()].map(value=>value.point);begin('touch',{x:(a.x+b.x)/2,y:(a.y+b.y)/2},Math.max(16,Math.hypot(a.x-b.x,a.y-b.y)));}
   }
  };
  const move=(event:PointerEvent)=>{
   if(event.pointerType==='pen'){trackPen(event);return;}
   if(event.pointerType==='mouse' && mousePan?.id===event.pointerId){
    stopEvent(event);
    if(!(event.buttons & 2)){stopMousePan();return;}
    pan(mousePan,event.clientX-mousePan.start.x,event.clientY-mousePan.start.y);
    return;
   }
   if(event.pointerType!=='touch')return;
   if(blockedTouches.has(event.pointerId) || pens.size || mousePan){stopEvent(event);return;}
   const contact=contacts.get(event.pointerId);if(!contact)return;
   const previous=contact.point;
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
   const previousOrigin=contact.horizontalOrigin;
   contact.verticalExtent=Math.max(contact.verticalExtent,Math.abs(dy));
   contact.horizontalOrigin ??= horizontalPanOrigin(dx,contact.verticalExtent);
   // Subtract the unlock distance so the page does not jump sideways at the threshold.
   const horizontal=contact.horizontalOrigin===null ? 0 : dx-contact.horizontalOrigin;
   const previousHorizontal=previousOrigin===null ? 0 : previous.x-contact.start.x-previousOrigin;
   const elapsed=Math.max(8,event.timeStamp-contact.lastMove);
   const speed=(delta:number)=>Math.max(-2.8,Math.min(2.8,delta/elapsed));
   contact.velocity={x:speed(previousHorizontal-horizontal),y:speed(previous.y-contact.point.y)};
   contact.lastMove=event.timeStamp;
   if(!contact.dragging && Math.hypot(horizontal,dy)<5)return;
   if(!contact.dragging){contact.dragging=true;capture(event.pointerId);cancelTouchDrawing();window.getSelection()?.removeAllRanges();}
   stopEvent(event);pan(contact,horizontal,dy);
  };
  const end=(event:PointerEvent)=>{
   if(event.pointerType==='pen'){pens.delete(event.pointerId);return;}
   if(event.pointerType==='mouse' && mousePan?.id===event.pointerId){stopEvent(event);stopMousePan();return;}
   if(event.pointerType!=='touch')return;
   if(blockedTouches.delete(event.pointerId) || pens.size || mousePan){stopEvent(event);return;}
   const contact=contacts.get(event.pointerId);if(!contact)return;
   if(locked || contact.dragging){event.preventDefault();event.stopPropagation();}
   contacts.delete(event.pointerId);
   if(session?.kind==='touch' && contacts.size<2){if(event.type==='pointercancel')clear();else finish();}
   if(!locked && contact.dragging && event.type==='pointerup' && event.timeStamp-contact.lastMove<90){
    startMomentum(touchMomentum(contact.velocity,contact.point.y-contact.start.y,contact.horizontalOrigin!==null));
   }
   if(!contacts.size)locked=false;
  };
  const blur=()=>{clear();stopMousePan();contacts.clear();blockedTouches.clear();pens.clear();locked=false;};
  const lost=(event:PointerEvent)=>{
   if(event.pointerType==='pen'){pens.delete(event.pointerId);return;}
   if(event.target===root && (mousePan?.id===event.pointerId || contacts.has(event.pointerId)))end(event);
  };
  const releasePen=(event:PointerEvent)=>{if(event.pointerType==='pen')pens.delete(event.pointerId);};
  const contextMenu=(event:MouseEvent)=>{if(event.button===2)event.preventDefault();};
  root.addEventListener('wheel',wheel,{passive:false});
  root.addEventListener('contextmenu',contextMenu);
  for(const [name,handler] of [['pointerdown',down],['pointermove',move],['pointerup',end],['pointercancel',end],['lostpointercapture',lost]] as const)root.addEventListener(name,handler,{capture:true,passive:false});
  window.addEventListener('blur',blur);
  window.addEventListener('pointerup',releasePen,true);
  window.addEventListener('pointercancel',releasePen,true);
  return()=>{blur();clearTimeout(statusTimer);pending.current=null;reset.current=()=>{};root.removeEventListener('wheel',wheel);root.removeEventListener('contextmenu',contextMenu);for(const [name,handler] of [['pointerdown',down],['pointermove',move],['pointerup',end],['pointercancel',end],['lostpointercapture',lost]] as const)root.removeEventListener(name,handler,true);window.removeEventListener('blur',blur);window.removeEventListener('pointerup',releasePen,true);window.removeEventListener('pointercancel',releasePen,true);};
 },[options.root,options.stage,options.status,options.documentId,options.enabled,clearPreview,restoreAnchor]);
 return {wheelDirect,setWheelDirect,changeZoom,cancelZoom};
}
