import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {JSDOM} from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(dom.window.HTMLDialogElement.prototype,'showModal',{value(){this.open=true;},configurable:true});
Object.defineProperty(dom.window.HTMLDialogElement.prototype,'close',{value(){this.open=false;},configurable:true});
const {render,fireEvent,cleanup}=await import('@testing-library/react');
const {GuideDialog}=await import('../.tmp/tests/features/guide/GuideDialog.js');
const {parseGuide,filterGuide}=await import('../.tmp/tests/features/guide/guideContent.js');
const markdown=readFileSync('../../docs/user-guide.md','utf8');
afterEach(cleanup);

test('the single guide source covers all 16 main areas and ignores headings in import examples',()=>{
 const guide=parseGuide(markdown);
 assert.equal(guide.title,'读步天下使用指南');assert.equal(guide.sections.length,16);
 for(const name of ['第一次使用','书架','OCR','手写标注','连接测试','Master','行间教学','深度问答','向量模型','学习记忆','框选识题','全书结构','外部结构导入','任务中心','完整备份','常见问题'])assert.ok(guide.sections.some(s=>s.title.includes(name)),name);
 assert.ok(guide.sections.some(s=>s.blocks.some(b=>b.kind==='code'&&b.text.includes('# 第一章'))));
 assert.deepEqual(parseGuide(markdown.replace(/\r?\n/g,'\r\n')),guide);
});

test('guide searches titles and usage conditions, including case-insensitive RAG terms',()=>{
 const {sections}=parseGuide(markdown);
 assert.ok(filterGuide(sections,'全文 rag').some(s=>s.title.includes('常见问题')));
 assert.ok(filterGuide(sections,'灰色').some(s=>s.title.includes('行间教学')));
 assert.equal(filterGuide(sections,'不存在的功能abcdef').length,0);
 assert.equal(filterGuide(sections,'  ').length,16);
});

test('guide displays conditions, filters chapters and recovers from an empty search',()=>{
 const view=render(React.createElement(GuideDialog,{markdown,onClose(){}}));
 assert.ok(view.getByRole('dialog',{name:'读步天下使用指南'}).open);
 const input=view.getByRole('searchbox',{name:'查找功能'});
 fireEvent.change(input,{target:{value:'灰色'}});
 assert.ok(view.getByText(/“导读”“行间教学”目前只允许当前原文模式/));
 fireEvent.change(input,{target:{value:'不存在的功能abcdef'}});
 assert.ok(view.getByRole('heading',{name:'没有找到相关功能'}));
 fireEvent.click(view.getByRole('button',{name:'查看全部功能'}));
 assert.equal(input.value,'');assert.equal(view.getByRole('navigation',{name:'使用指南目录'}).querySelectorAll('a').length,16);
});

test('guide table of contents scrolls and focuses its heading without navigating the app',()=>{
 const view=render(React.createElement(GuideDialog,{markdown,onClose(){}}));
 const heading=view.getByRole('heading',{name:/07 · 导读/});let scroll=0;
 heading.scrollIntoView=()=>{scroll++;};
 fireEvent.click(view.getByRole('link',{name:/07 · 导读/}));
 assert.equal(scroll,1);assert.equal(document.activeElement,heading);assert.equal(window.location.hash,'');
});

test('guide cancels safely and isolates Ctrl+Z from the PDF beneath it',()=>{
 let closed=0,underlyingUndo=0;const undo=()=>{underlyingUndo++;};window.addEventListener('keydown',undo);
 try{
  const view=render(React.createElement(GuideDialog,{markdown,onClose(){closed++;}}));
  fireEvent.keyDown(view.getByRole('button',{name:'关闭使用指南'}),{key:'z',ctrlKey:true});assert.equal(underlyingUndo,0);
  fireEvent(view.getByRole('dialog'),new window.Event('cancel',{cancelable:true}));assert.equal(closed,1);
  assert.equal(view.queryByRole('dialog'),null);
 }finally{window.removeEventListener('keydown',undo);}
});

test('guide renders markup as safe text and downloads exactly its source document',async()=>{
 const source='# 安全指南\n\n## 示例\n<script>bad()</script>\n\n```md\n# 示例代码\n```';
 let downloaded;const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
 URL.createObjectURL=blob=>{downloaded=blob;return 'blob:guide-test';};URL.revokeObjectURL=()=>{};
 const originalClick=dom.window.HTMLAnchorElement.prototype.click;let filename;
 dom.window.HTMLAnchorElement.prototype.click=function(){filename=this.download;};
 try{
  const view=render(React.createElement(GuideDialog,{markdown:source,onClose(){}}));assert.equal(view.container.querySelectorAll('script').length,0);
  fireEvent.click(view.getByRole('button',{name:'下载 Markdown'}));assert.equal(await downloaded.text(),source);assert.equal(filename,'读步天下使用指南.md');
 }finally{URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;dom.window.HTMLAnchorElement.prototype.click=originalClick;}
});
