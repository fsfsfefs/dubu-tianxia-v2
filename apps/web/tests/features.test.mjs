import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {JSDOM} from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'http://localhost/'});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const {render, fireEvent, cleanup, waitFor} = await import('@testing-library/react');
const {TaskCenter} = await import('../.tmp/tests/features/tasks/TaskCenter.js');
const {ModelSettings} = await import('../.tmp/tests/features/settings/ModelSettings.js');
const {chapterKey, chapterPlan} = await import('../.tmp/tests/chapters.js');
afterEach(cleanup);

const book = {id:'book', title:'教材', byte_size:10, folder_id:null, created_at:''};
function props(task) {
  return {taskCenterOpen:true, activeTaskCount:1, activeDocument:book, documents:[book], backgroundTasks:[task], preparing:false,
    chapterSummaryProgress:'', onToggle(){}, onClose(){}, onCancelPrepare(){}, onIndex(){}, onClear(){},
    onPause(){}, onCancel(){}, onRetry(){}, onView(){}, describeTaskError: message => message};
}
function task(status) {
  return {id:'task',task_type:'structure-summary',document_id:'book',title:'生成总结',status, progress:1,total:2,
    message:'分块中',error:'',result:{},updated_at:''};
}

test('running summary can be paused/cancelled through the extracted component', () => {
  const actions=[];
  const ui=render(React.createElement(TaskCenter,{...props(task('running')),onPause:id=>actions.push(['pause',id]),onCancel:id=>actions.push(['cancel',id])}));
  fireEvent.click(ui.getByText('暂停')); fireEvent.click(ui.getByText('取消'));
  assert.deepEqual(actions,[['pause','task'],['cancel','task']]);
  assert.equal(ui.queryByText('重新执行'),null);
});

test('partial summary discloses missing chapters and supports retry', () => {
  const item=task('partial');
  item.result={missing_chapters:[{chapter_key:'missing',title:'缺失章节',start_page:2,end_page:3}]};
  let retried='';
  const ui=render(React.createElement(TaskCenter,{...props(item),onRetry:id=>retried=id}));
  assert.ok(ui.getByText('部分完成')); assert.ok(ui.getByText('缺失章节'));
  fireEvent.click(ui.getByText('重新执行')); assert.equal(retried,'task');
  assert.equal(ui.queryByText('暂停'),null);
});

test('unsaved settings test submits the current draft without saving a profile', async () => {
  const calls=[]; const previous=globalThis.fetch;
  globalThis.fetch=async (url,options) => {
    calls.push([url,options]);
    return {ok:true,json:async()=>url==='/api/embedding-models'?{active_id:'builtin',models:[],presets:[]}:{ok:true,response:'OK'}};
  };
  try {
    const ui=render(React.createElement(ModelSettings,{profiles:[],onClose(){},onSaved(){throw Error('must not save');}}));
    fireEvent.change(ui.getByLabelText('模型名称'),{target:{value:'draft-model'}});
    fireEvent.click(ui.getByText('测试连接'));
    await waitFor(()=>assert.ok(ui.getByText(/连接成功/)));
    const post=calls.find(([url])=>url==='/api/model-profiles/test');
    assert.equal(JSON.parse(post[1].body).model,'draft-model');
    assert.ok(!calls.some(([url])=>url==='/api/model-profiles'));
  } finally {globalThis.fetch=previous;}
});

test('chapter keys and chapter range plans are stable and content-sensitive', () => {
  const old=[{title:'A',page:2,depth:0},{title:'B',page:5,depth:0}];
  assert.equal(chapterKey('doc',old,0),chapterKey('doc',[{title:'New',page:1,depth:0},...old],1));
  assert.notEqual(chapterKey('doc',old,0),chapterKey('doc',[old[0],{title:'Child',page:3,depth:1},old[1]],0));
  assert.equal(chapterPlan(old,0).endPage,4);
});


test('Python and TypeScript use identical chapter identities for Unicode and hierarchy', async () => {
  const {readFileSync}=await import('node:fs');
  const fixtures=JSON.parse(readFileSync('../../tests/fixtures/chapters.json','utf8'));
  for (const f of fixtures) assert.equal(chapterKey(f.document_id,f.outline,f.index),f.expected);
});

test('a note request resolving after switching books cannot append into the new book', async () => {
  const {renderHook,act}=await import('@testing-library/react');
  const {useNotes}=await import('../.tmp/tests/features/notes/useNotes.js');
  let resolve; const previous=globalThis.fetch;
  globalThis.fetch=()=>new Promise(done=>{resolve=done;});
  try {
    const hook=renderHook(({doc})=>useNotes(doc,1,'',()=>{}),{initialProps:{doc:book}});
    act(()=>hook.result.current.setNoteDraft('note for A'));
    let request;
    act(()=>{request=hook.result.current.addNote();});
    hook.rerender({doc:{...book,id:'other'}});
    await act(async()=>{resolve({ok:true,json:async()=>({note:{id:'n',document_id:'book',content:'A'}})});await request;});
    assert.equal(hook.result.current.notes.length,0);
  } finally {globalThis.fetch=previous;}
});
