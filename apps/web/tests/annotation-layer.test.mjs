import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.localStorage=dom.window.localStorage;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
class Pointer extends dom.window.MouseEvent {
 constructor(type,init){super(type,init);for(const name of ['pointerId','pointerType','pressure'])Object.defineProperty(this,name,{value:init[name]??(name==='pointerType'?'mouse':name==='pointerId'?1:.5)});}
}
dom.window.PointerEvent=Pointer;
const captures=new WeakMap();
dom.window.SVGElement.prototype.setPointerCapture=function(id){captures.set(this,id);};
dom.window.SVGElement.prototype.hasPointerCapture=function(id){return captures.get(this)===id;};
dom.window.SVGElement.prototype.releasePointerCapture=function(){captures.delete(this);};
let next=0;const frames=new Map();
globalThis.requestAnimationFrame=cb=>{frames.set(++next,cb);return next;};globalThis.cancelAnimationFrame=id=>frames.delete(id);
const {render,fireEvent,act,cleanup}=await import('@testing-library/react');
const {AnnotationLayer}=await import('../.tmp/tests/features/reader/AnnotationLayer.js');
const {contactTool,readAnnotationInput,saveAnnotationInput}=await import('../.tmp/tests/features/reader/annotationInput.js');
afterEach(()=>{cleanup();frames.clear();localStorage.clear();});
const rect=(x,y)=>({x,y,width:.004,height:.004});
const ink=(id,y)=>({id,rects:[rect(.1,y),rect(.9,y)],color:'blue',tags:['__ink__','pen']});
const defaults={documentId:'A',page:1,dimensions:{width:600,height:800},zoom:1,highlights:[ink('first',.4),ink('second',.6)],tool:'eraser',color:'blue',width:.004,eraserSize:24,penOnly:false};
const pointer=(type='mouse',id=1,x=300,y=240,buttons=1,button=0,pressure=.5)=>({pointerType:type,pointerId:id,clientX:x,clientY:y,buttons,button,pressure});
function setup(overrides={}){
 const erased=[],saved=[];
 const callbacks={onErase:async(...args)=>{erased.push(args);},onSave:(...args)=>saved.push(args),...overrides};
 function Harness(){const[draft,onDraft]=React.useState(null);return React.createElement(AnnotationLayer,{...defaults,...callbacks,draft,onDraft});}
 const view=render(React.createElement(Harness));const layer=view.container.querySelector('svg');
 layer.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,width:600,height:800,right:600,bottom:800});
 const flush=()=>act(()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(cb=>cb());});
 return {view,layer,flush,erased,saved,paths:()=>[...layer.querySelectorAll('.annotation-stroke:not(.draft)')]};
}

test('held eraser updates every traversed stroke before pointerup, then submits one gesture with the chosen radius',async()=>{
 const t=setup();fireEvent.pointerDown(t.layer,pointer());
 fireEvent.pointerMove(t.layer,pointer('mouse',1,300,360));t.flush();assert.equal(t.paths().length,3);
 fireEvent.pointerMove(t.layer,pointer('mouse',1,300,560));t.flush();assert.equal(t.paths().length,4);assert.equal(t.erased.length,0);
 await act(async()=>fireEvent.pointerUp(t.layer,pointer('mouse',1,300,560,0)));
 assert.equal(t.erased.length,1);assert.equal(t.erased[0][3],24/1600);
});

test('cancel or lost capture restores the preview without persisting; a different pointer cannot end the stroke',()=>{
 const t=setup();fireEvent.pointerDown(t.layer,pointer());fireEvent.pointerMove(t.layer,pointer('mouse',1,300,400));t.flush();assert.equal(t.paths().length,3);
 fireEvent.pointerUp(t.layer,pointer('touch',9,300,400,0));assert.equal(t.erased.length,0);assert.equal(t.paths().length,3);
 fireEvent.pointerCancel(t.layer,pointer());assert.equal(t.paths().length,2);assert.equal(t.erased.length,0);
 fireEvent.pointerDown(t.layer,pointer());fireEvent.pointerMove(t.layer,pointer('mouse',1,300,400));t.flush();
 fireEvent.lostPointerCapture(t.layer,pointer());assert.equal(t.paths().length,2);assert.equal(t.erased.length,0);
});

test('eraser size controls both cursor diameter and actual clipping radius',async()=>{
 for(const size of [8,80]){
  const t=setup({eraserSize:size});fireEvent.pointerDown(t.layer,pointer('mouse',1,300,320));
  const cursor=t.layer.querySelector('.annotation-eraser-cursor');assert.equal(Number(cursor.getAttribute('rx'))*600/500,size);
  const left=t.paths().find(p=>p.getAttribute('d').startsWith('M 100 400'));
  const end=Number(left.getAttribute('d').split(' ').at(-2));assert.ok(Math.abs(end-(.5-size/1200)*1000)<.001);
  await act(async()=>fireEvent.pointerUp(t.layer,pointer('mouse',1,300,320,0)));assert.equal(t.erased[0][3],size/1600);cleanup();
 }
});

test('pen tip draws, tail and held barrel button erase temporarily, and barrel release resumes the selected pen',async()=>{
 const t=setup({tool:'pen'});
 fireEvent.pointerDown(t.layer,pointer('pen',2,100,200));fireEvent.pointerMove(t.layer,pointer('pen',2,200,200));t.flush();
 // Press side button during contact: split the pen stroke, then erase while held.
 fireEvent.pointerMove(t.layer,pointer('pen',2,300,320,3,2));t.flush();assert.equal(t.saved.length,1);assert.equal(t.paths().length,3);
 fireEvent.pointerMove(t.layer,pointer('pen',2,300,400,1,2));t.flush();assert.equal(t.erased.length,1);
 await act(async()=>fireEvent.pointerUp(t.layer,pointer('pen',2,350,400,0)));assert.equal(t.saved.length,2);assert.equal(t.saved[1][2].tool,'pen');
 fireEvent.pointerDown(t.layer,pointer('pen',3,300,320,32,5));t.flush();
 await act(async()=>fireEvent.pointerUp(t.layer,pointer('pen',3,300,320,0,5)));assert.equal(t.erased.length,2);
});

test('pen hover is harmless and pen-only mode rejects palms without blocking mouse editing',async()=>{
 const t=setup({tool:'pen',penOnly:true});fireEvent.pointerDown(t.layer,pointer('touch',7));fireEvent.pointerUp(t.layer,pointer('touch',7,300,300,0));assert.equal(t.saved.length,0);
 fireEvent.pointerDown(t.layer,pointer('pen',8,300,320,2,2,0));fireEvent.pointerMove(t.layer,pointer('pen',8,300,400,2,2,0));assert.equal(t.erased.length,0);assert.equal(t.paths().length,2);
 fireEvent.pointerDown(t.layer,pointer('mouse'));await act(async()=>fireEvent.pointerUp(t.layer,pointer('mouse',1,400,240,0)));assert.equal(t.saved.length,1);
});

test('palm input during a pen stroke cannot add, move or finish that stroke',async()=>{
 const t=setup({tool:'pen'});fireEvent.pointerDown(t.layer,pointer('pen',2,100,100));
 fireEvent.pointerDown(t.layer,pointer('touch',3,500,700));fireEvent.pointerMove(t.layer,pointer('touch',3,500,750));fireEvent.pointerUp(t.layer,pointer('touch',3,500,750,0));
 assert.equal(t.saved.length,0);await act(async()=>fireEvent.pointerUp(t.layer,pointer('pen',2,200,100,0)));
 assert.equal(t.saved.length,1);assert.ok(t.saved[0][1].every(p=>p.y===.125));
});

test('input preferences persist locally and malformed sizes are clamped safely',()=>{
 assert.deepEqual(readAnnotationInput(),{eraserSize:24,penOnly:false});saveAnnotationInput(50,true);assert.deepEqual(readAnnotationInput(),{eraserSize:50,penOnly:true});
 localStorage.setItem('reader-next-v2-annotation-input','{"eraserSize":999,"penOnly":false}');assert.equal(readAnnotationInput().eraserSize,80);
 assert.equal(contactTool(pointer('mouse',1,0,0,2,2),'pen'),null);
});
