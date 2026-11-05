import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {JSDOM} from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'http://localhost/'});
globalThis.window=dom.window; globalThis.document=dom.window.document; globalThis.HTMLElement=dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {renderHook, act, cleanup} = await import('@testing-library/react');
const {useOverview} = await import('../.tmp/tests/features/overview/useOverview.js');
const {usePdfSearch} = await import('../.tmp/tests/features/reader/usePdfSearch.js');
const {useAnnotations} = await import('../.tmp/tests/features/reader/useAnnotations.js');
const {useWorkspaceNavigation} = await import('../.tmp/tests/features/workspace/useWorkspaceNavigation.js');
const {usePanelLayout} = await import('../.tmp/tests/features/assistant/usePanelLayout.js');
afterEach(() => {cleanup(); window.localStorage.clear();});
const A={id:'A',title:'A'}, B={id:'B',title:'B'};
const deferred=()=>{let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject};};
const response=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const empty=()=>response({gaps:[],summaries:[],outline:[],pages:[]});
const imported={outline:[{title:'new chapter',page:1,depth:0}],summaries:[{content:'new'}]};
const file={text:async()=>JSON.stringify({chapters:[{title:'第一章',page:1,summary:'summary'}]})};
const options=doc=>({activeDocument:doc,activeProfile:'model',profiles:[{id:'model',name:'模型一',model:'one'},{id:'other',name:'模型二',model:'two'}],currentPage:1,screen:'home',backgroundTasks:[],notes:[],flashcards:[],setBackgroundTasks(){},setTaskCenterOpen(){},setError(){},enterReader(){},goBack(){},refreshTasksNow:async()=>{},cancelTask:async()=>{}});
const dependencies={loadOutline:async()=>[],collectSource:async()=>{}};

test('structure file read from an earlier A visit never sends an import for the later A visit',async()=>{
  const pending=deferred(); let imports=0; globalThis.fetch=async(url)=>{if(String(url).endsWith('learning-structure-import')) imports++; return empty();};
  const hook=renderHook(({doc})=>useOverview(options(doc),dependencies),{initialProps:{doc:A}});
  let operation; act(()=>{operation=hook.result.current.importLearningStructureFile({text:()=>pending.promise});});
  hook.rerender({doc:B}); hook.rerender({doc:A});
  await act(async()=>{pending.resolve(await file.text()); await operation;});
  assert.equal(imports,0); assert.equal(hook.result.current.structureImportStatus,'');
});

test('pending import responses and errors cannot replace a new book or release its import lock',async()=>{
  const pending=deferred(); let count=0; globalThis.fetch=async url=>String(url).endsWith('learning-structure-import') ? (++count===1 ? pending.promise : response(imported)) : empty();
  const hook=renderHook(({doc})=>useOverview(options(doc),dependencies),{initialProps:{doc:A}});
  let old; await act(async()=>{old=hook.result.current.importLearningStructureFile(file); await Promise.resolve();});
  hook.rerender({doc:B});
  await act(async()=>{await hook.result.current.importLearningStructureFile(file);});
  assert.equal(hook.result.current.chapters[0].title,'new chapter');
  await act(async()=>{pending.resolve(response({outline:[{title:'stale'}],summaries:[]})); await old;});
  assert.equal(hook.result.current.chapters[0].title,'new chapter'); assert.equal(hook.result.current.chapterSummaryError,'');
});

test('an outline response started before manual import cannot overwrite the imported outline',async()=>{
  const outline=deferred();globalThis.fetch=async url=>String(url).endsWith('learning-structure-import')?response(imported):empty();
  const hook=renderHook(()=>useOverview({...options(A),screen:'overview'},{...dependencies,loadOutline:()=>outline.promise}));
  await act(async()=>{await hook.result.current.importLearningStructureFile(file);});
  await act(async()=>{outline.resolve([{title:'old PDF outline',page:2,depth:0}]);});
  assert.equal(hook.result.current.chapters[0].title,'new chapter');assert.equal(hook.result.current.chaptersLoading,false);
});

test('switching books aborts preparation and old progress/finally cannot affect a new preparation',async()=>{
  const runs=[];let queued=0;globalThis.fetch=async url=>{if(String(url)==='/api/tasks/summary') queued++;return empty();};
  const dep={...dependencies,collectSource:(id,start,end,progress,signal)=>{const done=deferred();runs.push({done,progress,signal});return done.promise;}};
  const hook=renderHook(({doc})=>useOverview(options(doc),dep),{initialProps:{doc:A}});
  act(()=>hook.result.current.setChapters([{title:'first',page:1,depth:0}]));let first;act(()=>{first=hook.result.current.startSummaryTask(null);});
  hook.rerender({doc:B});act(()=>hook.result.current.setChapters([{title:'second',page:1,depth:0}]));let second;act(()=>{second=hook.result.current.startSummaryTask(null);});
  assert.equal(runs[0].signal.aborted,true);
  await act(async()=>{runs[0].progress({page:99,completed:99,total:99});runs[0].done.resolve();await first;});
  assert.equal(queued,0);assert.equal(hook.result.current.chapterSummaryBusy,'B:__book__');assert.ok(hook.result.current.bookGenerationTask.current);
  hook.unmount();runs[1].done.resolve();await second;
});

test('source trace requests do not leak into another book',async()=>{
 const pending=deferred();globalThis.fetch=async url=>String(url).endsWith('/ocr-pages')?pending.promise:empty();
 const hook=renderHook(({doc})=>useOverview(options(doc),dependencies),{initialProps:{doc:A}});
 act(()=>hook.result.current.setSummarySelection({text:'keyword',summary:{start_page:1,end_page:2}}));let task;act(()=>{task=hook.result.current.findSummarySources();});hook.rerender({doc:B});
 await act(async()=>{pending.resolve(response({pages:[{page_number:1,text:'keyword'}]}));await task;});
 assert.deepEqual(hook.result.current.traceLocations,[]);assert.equal(hook.result.current.traceLoading,false);
});

test('search cancellation after awaiting page text suppresses cache writes, OCR saves and results',async()=>{
 const pending=deferred();let writes=0;globalThis.fetch=async()=>{writes++;return empty();};const pdf={numPages:1,getPage:async()=>({getTextContent:()=>pending.promise})};
 const hook=renderHook(()=>usePdfSearch('A',pdf,()=>{}));act(()=>hook.result.current.setQuery('CPU'));let task;act(()=>{task=hook.result.current.searchDocument();});
 act(()=>hook.result.current.cancelSearch());await act(async()=>{pending.resolve({items:[{str:'CPU instruction source'}]});await task;});
 assert.equal(writes,0);assert.equal(hook.result.current.pageTextCache.current.size,0);assert.deepEqual(hook.result.current.results,[]);
});

test('old annotation persistence cannot append into a later A visit or its undo stack',async()=>{
 const pending=deferred();globalThis.fetch=()=>pending.promise;
 function useInk(doc){const [highlights,setHighlights]=React.useState([]);return {...useAnnotations(doc,highlights,setHighlights,()=>{}),highlights};}
 const hook=renderHook(({doc})=>useInk(doc),{initialProps:{doc:A}});let task;await act(async()=>{task=hook.result.current.saveInkAnnotation(1,[{x:.1,y:.1},{x:.2,y:.2}]);await Promise.resolve();});hook.rerender({doc:B});hook.rerender({doc:A});
 await act(async()=>{pending.resolve(response({highlight:{id:'old'}}));await task;});
 assert.deepEqual(hook.result.current.highlights,[]);assert.equal(hook.result.current.annotationUndoDepth,0);
});

function inkHarness(initial = [], failCreate = () => false) {
 const stored = new Map(initial.map(item=>[item.id,item])), errors=[];let next=0;
 globalThis.fetch=async(url,options)=>{
  if(String(url).endsWith('/ink-marks')){
   const body=JSON.parse(options.body),ids=new Set(body.member_ids),rows=[...stored.values()].filter(item=>ids.has(item.id));
   if(options.method==='PUT'){
    const updated=rows.map(item=>({...item,text:body.name,tags:[...item.tags.filter(tag=>!tag.startsWith('__ink_region:')),'__ink_region:'+body.region_id]}));
    for(const item of updated)stored.set(item.id,item);return response({highlights:updated});
   }
   for(const item of rows)stored.delete(item.id);return response({deleted_ids:rows.map(item=>item.id),removed:rows});
  }
  if(options.method==='POST'){
   if(failCreate(++next))return new Response(JSON.stringify({detail:'test save failure'}),{status:500});
   const item={...JSON.parse(options.body),id:`new-${next}`,document_id:'A'};stored.set(item.id,item);return response({highlight:item});
  }
  if(options.method==='DELETE'){stored.delete(String(url).split('/').at(-1));return new Response(null,{status:204});}
  throw new Error(`Unexpected ${url}`);
 };
 const hook=renderHook(()=>{const [highlights,setHighlights]=React.useState(initial);return {...useAnnotations(A,highlights,setHighlights,message=>errors.push(message)),highlights};});
 return {hook,stored,errors};
}
const ink = (id,page=1,tags=['__ink__','pen'])=>({id,page_number:page,rects:[{x:.1,y:.5,width:.004,height:.004},{x:.9,y:.5,width:.004,height:.004}],color:'red',comment:'kept comment',tags,text:'ink'});
const pageSize={width:595,height:842};

test('drag erases every touched ink stroke in one undo step and preserves text highlights, other pages and metadata',async()=>{
 const original=[ink('pen'),ink('marker',1,['__ink__','marker']),ink('other-page',2),ink('text',1,[])];
 const {hook,stored,errors}=inkHarness(original);
 await act(async()=>{await hook.result.current.eraseInkAt(1,[{x:.5,y:.2},{x:.5,y:.8}],pageSize);});
 assert.equal(stored.size,6);assert.equal(hook.result.current.annotationUndoDepth,1);
 assert.ok(stored.has('other-page')&&stored.has('text'));assert.ok(!stored.has('pen')&&!stored.has('marker'));
 assert.ok([...stored.values()].every(item=>item.comment==='kept comment'&&item.color==='red'));
 await act(async()=>{await hook.result.current.undoAnnotation();});
 assert.equal(stored.size,4);assert.equal(hook.result.current.highlights.length,4);assert.deepEqual(errors,[]);
});

test('queued drawing, multiple erase gestures and undo use the latest persisted segments and restored IDs',async()=>{
 const {hook,stored,errors}=inkHarness();
 await act(async()=>{
  const draw=hook.result.current.saveInkAnnotation(1,[{x:.1,y:.5},{x:.9,y:.5}]);
  const first=hook.result.current.eraseInkAt(1,[{x:.4,y:.2},{x:.4,y:.8}],pageSize);
  const second=hook.result.current.eraseInkAt(1,[{x:.7,y:.2},{x:.7,y:.8}],pageSize);
  await Promise.all([draw,first,second]);
 });
 assert.equal(stored.size,3);assert.equal(hook.result.current.annotationUndoDepth,3);
 await act(async()=>{await hook.result.current.undoAnnotation();await hook.result.current.undoAnnotation();await hook.result.current.undoAnnotation();});
 assert.equal(stored.size,0);assert.equal(hook.result.current.highlights.length,0);assert.deepEqual(errors,[]);
});

test('failed replacement save leaves the original ink in place and removes temporary segments',async()=>{
 const original=ink('original');const {hook,stored,errors}=inkHarness([original],count=>count===2);
 await act(async()=>{await hook.result.current.eraseInkAt(1,[{x:.5,y:.5}],pageSize);});
 assert.deepEqual([...stored.values()],[original]);assert.deepEqual(hook.result.current.highlights,[original]);
 assert.equal(hook.result.current.annotationUndoDepth,0);assert.equal(errors.length,1);
});

test('workspace navigation remembers books and explicit page jumps without reloading the reader',()=>{
 const hook=renderHook(()=>useWorkspaceNavigation([A,B]));act(()=>hook.result.current.setActiveDocument(A));act(()=>hook.result.current.openBook(B));act(()=>hook.result.current.enterReader(B,5));
 assert.equal(hook.result.current.readerRestorePosition,false);const revision=hook.result.current.readerPageRevision;act(()=>hook.result.current.enterReader(B,8));assert.equal(hook.result.current.readerPageRevision,revision+1);
 act(()=>hook.result.current.goBack());assert.equal(hook.result.current.screen,'overview');assert.equal(hook.result.current.activeDocument.id,'B');
});

test('panel resizing removes global pointer listeners and body state on unmount',()=>{
 const hook=renderHook(()=>usePanelLayout());act(()=>hook.result.current.beginPanelResize({button:0,preventDefault(){},clientX:500,clientY:20},'assistant'));assert.ok(document.body.classList.contains('panel-resizing'));act(()=>hook.result.current.beginPanelResize({button:0,preventDefault(){},clientX:450,clientY:20},'excerpt'));assert.ok(document.body.classList.contains('panel-resizing'));hook.unmount();assert.equal(document.body.classList.contains('panel-resizing'),false);
});

test('summary polling begun before an import cannot overwrite its committed results',async()=>{
 const pending=deferred();globalThis.fetch=async url=>String(url).endsWith('learning-structure-import')?response(imported):String(url).endsWith('chapter-summaries')?pending.promise:empty();
 const tasks=[{id:'task',document_id:'A',task_type:'structure-summary',status:'completed',message:'done',progress:1,total:1,result:{summary_request:{chapter_index:null,outline:[]}}}];
 const hook=renderHook(()=>useOverview({...options(A),backgroundTasks:tasks},dependencies));
 await act(async()=>{await hook.result.current.importLearningStructureFile(file);});
 await act(async()=>{pending.resolve(response({summaries:[{content:'stale poll'}]}));});
 assert.equal(hook.result.current.chapterSummaries[0].content,'new');
});

test('cancel clicked while task submission is in flight also cancels the server task once identified',async()=>{
 const queued=deferred(); const cancelled=[];
 globalThis.fetch=async url=>String(url)==='/api/tasks/summary'?queued.promise:empty();
 const hook=renderHook(()=>useOverview({...options(A),cancelTask:async id=>{cancelled.push(id);}},dependencies));
 act(()=>hook.result.current.setChapters([{title:'first',page:1,depth:0}]));let request;
 await act(async()=>{request=hook.result.current.startSummaryTask(null);await Promise.resolve();});
 await act(async()=>{await hook.result.current.cancelBookStructure();});
 await act(async()=>{queued.resolve(response({task:{id:'just-submitted'}}));await request;});
 assert.deepEqual(cancelled,['just-submitted']);
 assert.equal(hook.result.current.chapterSummaryBusy,'');
});

test('summary model choices are isolated per book, survive remount, and recover from deletion', async()=>{
 globalThis.fetch=async()=>empty();
 const hook=renderHook(({doc,profiles})=>useOverview({...options(doc),profiles},dependencies),{initialProps:{doc:A,profiles:options(A).profiles}});
 assert.equal(hook.result.current.summaryProfileId,'model');
 act(()=>hook.result.current.setSummaryProfileId('other'));
 hook.rerender({doc:B,profiles:options(A).profiles});
 assert.equal(hook.result.current.summaryProfileId,'model');
 hook.rerender({doc:A,profiles:options(A).profiles});
 assert.equal(hook.result.current.summaryProfileId,'other');
 hook.unmount();
 const restored=renderHook(({profiles})=>useOverview({...options(A),profiles},dependencies),{initialProps:{profiles:options(A).profiles}});
 assert.equal(restored.result.current.summaryProfileId,'other');
 restored.rerender({profiles:[options(A).profiles[0]]});
 assert.equal(restored.result.current.summaryProfileId,'model');
 restored.rerender({profiles:[]});
 assert.equal(restored.result.current.summaryProfileId,'');
});

test('summary submits the chosen book model and locks it during source preparation',async()=>{
 const source=deferred();const requests=[];
 globalThis.fetch=async(url,init)=>{
  if(String(url)==='/api/tasks/summary'){requests.push(JSON.parse(init.body));return response({task:{id:'chosen-model-task'}});}
  return empty();
 };
 const hook=renderHook(()=>useOverview(options(A),{...dependencies,collectSource:()=>source.promise}));
 act(()=>{hook.result.current.setChapters([{title:'first',page:1,depth:0}]);hook.result.current.setSummaryProfileId('other');});
 let pending;
 act(()=>{pending=hook.result.current.startSummaryTask(null);});
 assert.equal(hook.result.current.summaryModelLocked,true);
 act(()=>hook.result.current.setSummaryProfileId('model'));
 assert.equal(hook.result.current.summaryProfileId,'other');
 await act(async()=>{source.resolve();await pending;});
 assert.equal(requests.length,1);
 assert.equal(requests[0].profile_id,'other');
 assert.equal(requests[0].document_id,'A');
});

test('running book shows its submitted model rather than another books default',()=>{
 globalThis.fetch=async()=>empty();
 const task={id:'running',document_id:'A',task_type:'structure-summary',status:'running',message:'working',result:{summary_request:{profile_id:'other',chapter_index:null}}};
 const hook=renderHook(()=>useOverview({...options(A),backgroundTasks:[task]},dependencies));
 assert.equal(hook.result.current.summaryProfileId,'other');
 act(()=>hook.result.current.setSummaryProfileId('model'));
 assert.equal(hook.result.current.summaryProfileId,'other');
});


test('margin ink persists its surface and erase/undo are isolated from PDF and opposite margin',async()=>{
 const original=[ink('page'),ink('left',1,['__ink__','pen','__margin_left__']),ink('right',1,['__ink__','pen','__margin_right__'])];
 const {hook,stored,errors}=inkHarness(original);
 await act(async()=>{await hook.result.current.eraseInkAt(1,[{x:.875,y:.1},{x:.875,y:.9}],{width:200,height:842},undefined,'left');});
 assert.ok(stored.has('page') && stored.has('right'));assert.ok(!stored.has('left'));
 assert.ok([...stored.values()].filter(i=>i.id!=='page' && i.id!=='right').every(i=>i.tags.includes('__margin_left__')));
 await act(async()=>{await hook.result.current.undoAnnotation();});assert.equal(stored.size,3);
 await act(async()=>{await hook.result.current.saveInkAnnotation(1,[{x:.1,y:.1},{x:.2,y:.2}],{tool:'pen',color:'blue',width:.004,surface:'right'});});
 assert.equal([...stored.values()].at(-1).tags.includes('__margin_right__'),true);assert.deepEqual(errors,[]);
});


test('all strokes on the same PDF page share one mark',async()=>{
 const {hook,stored,errors}=inkHarness();
 await act(async()=>{await hook.result.current.saveInkAnnotation(1,[{x:.1,y:.1},{x:.2,y:.2}]);await hook.result.current.saveInkAnnotation(1,[{x:.15,y:.15},{x:.25,y:.25}]);});
 let rows=[...stored.values()];const region=rows[0].tags.find(tag=>tag.startsWith('__ink_region:'));
 assert.equal(rows[1].tags.includes(region),true);
 await act(async()=>{await hook.result.current.saveInkAnnotation(1,[{x:.15,y:.15},{x:.25,y:.25}]);});
 rows=[...stored.values()];assert.equal(rows[2].tags.includes(region),true);
 assert.deepEqual(errors,[]);
});


test('renaming a region survives erasing, undo and whole-region delete/undo',async()=>{
 const {buildInkMarks}=await import('../.tmp/tests/features/reader/inkMarks.js');
 const {hook,stored,errors}=inkHarness();
 await act(async()=>{await hook.result.current.saveInkAnnotation(1,[{x:.1,y:.5},{x:.9,y:.5}]);await hook.result.current.saveInkAnnotation(1,[{x:.2,y:.51},{x:.3,y:.51}]);});
 const mark=()=>buildInkMarks(hook.result.current.highlights)[0];
 await act(async()=>{await hook.result.current.renameMark(mark(),'我的公式');});
 assert.equal(mark().name,'我的公式');
 await act(async()=>{await hook.result.current.eraseInkAt(1,[{x:.5,y:.1},{x:.5,y:.9}],pageSize);});
 assert.equal(buildInkMarks(hook.result.current.highlights).length,1);assert.equal(mark().name,'我的公式');
 await act(async()=>{await hook.result.current.undoAnnotation();await hook.result.current.removeMark(mark());});
 assert.equal(stored.size,0);
 await act(async()=>{await hook.result.current.undoAnnotation();});
 assert.equal(stored.size,2);assert.equal(mark().name,'我的公式');assert.deepEqual(errors,[]);
});

test('rapid strokes stay visible while persistence waits and are replaced without duplicates',async()=>{
 const {hook,stored,errors}=inkHarness();
 const pending=deferred(),fetch=globalThis.fetch;
 globalThis.fetch=(...args)=>pending.promise.then(()=>fetch(...args));
 let first,second;
 act(()=>{
  first=hook.result.current.saveInkAnnotation(1,[{x:.1,y:.1},{x:.2,y:.2}]);
  second=hook.result.current.saveInkAnnotation(1,[{x:.3,y:.3},{x:.4,y:.4}]);
 });
 assert.equal(hook.result.current.highlights.length,2);
 const geometry=hook.result.current.highlights.map(item=>item.rects);
 assert.equal(stored.size,0);
 await act(async()=>{pending.resolve();await Promise.all([first,second]);});
 assert.equal(stored.size,2);
 assert.deepEqual(hook.result.current.highlights.map(item=>item.rects),geometry);
 assert.ok(hook.result.current.highlights.every(item=>!item.id.startsWith('pending-ink-')));
 assert.deepEqual(errors,[]);
});

test('an older erase does not erase a later stroke still waiting to save',async()=>{
 const {hook,stored,errors}=inkHarness([ink('old')]);
 await act(async()=>{
  const erase=hook.result.current.eraseInkAt(1,[{x:.5,y:.2},{x:.5,y:.8}],pageSize);
  const draw=hook.result.current.saveInkAnnotation(1,[{x:.4,y:.5},{x:.6,y:.5}]);
  await Promise.all([erase,draw]);
 });
 assert.equal(stored.size,3);
 assert.equal(hook.result.current.highlights.length,3);
 assert.deepEqual(errors,[]);
});

test('a failed new stroke rolls back its temporary display and reports the failure',async()=>{
 const {hook,stored,errors}=inkHarness([],()=>true);
 await act(async()=>{await hook.result.current.saveInkAnnotation(1,[{x:.1,y:.1},{x:.2,y:.2}]);});
 assert.equal(stored.size,0);
 assert.deepEqual(hook.result.current.highlights,[]);
 assert.equal(hook.result.current.annotationUndoDepth,0);
 assert.equal(errors.length,1);
});
