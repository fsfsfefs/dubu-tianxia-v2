import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {render,fireEvent,cleanup}=await import('@testing-library/react');
const {SummaryContent,AnswerContent}=await import('../.tmp/tests/StructuredContent.js');
const {ReaderSummaries}=await import('../.tmp/tests/features/reader/ReaderSummaries.js');
afterEach(cleanup);

test('summary PDF references become buttons in paragraphs, emphasis, citations and tables',()=>{
 const pages=[];
 const value='【本节结论】\n说明（PDF5-42），**PDF 7—9**，〔PDF第10页〕，第12至15页，16页。\n\n|知识|出处|\n|---|---|\n|概念|PDF18～20|';
 const ui=render(React.createElement(SummaryContent,{value,onPageReference:(page)=>pages.push(page)}));
 const buttons=ui.getAllByRole('button');
 for(const button of buttons) fireEvent.click(button);
 assert.deepEqual(pages,[5,7,10,12,16,18]);
 assert.match(buttons[0].title,/第5页开头/);
 assert.equal(ui.container.querySelector('img'),null);
});

test('invalid page ranges stay text and returning highlights preserve page buttons',()=>{
 const ui=render(React.createElement(SummaryContent,{value:'PDF0，PDF8-3；返回 PDF5-6。',highlight:'PDF5-6',onPageReference(){}}));
 assert.equal(ui.getAllByRole('button').length,1);
 assert.equal(ui.getByRole('button').textContent,'PDF5-6');
 assert.ok(ui.container.querySelector('[data-summary-return] button'));
 const other=render(React.createElement(AnswerContent,{value:'文字回答 PDF5-6'}));
 assert.equal(other.container.querySelector('button'),null);
});

test('reader summary selection and scroll survive jumping to PDF and returning',()=>{
 const summaries=[{chapter_key:'A:ch-one',title:'第一章',start_page:1,end_page:1,depth:0,content:'本章内容 PDF2'},{chapter_key:'A:ch-two',title:'第二章',start_page:2,end_page:2,depth:0,content:'另一章 PDF1'}];
 const calls=[];
 const ui=render(React.createElement(ReaderSummaries,{active:true,page:1,summaries,onJump:p=>calls.push(p),onClose(){},onPages(){},onOutline(){}}));
 const scroller=ui.container.querySelector('.reader-summary-content');scroller.scrollTop=250;
 fireEvent.click(ui.getByRole('button',{name:'查看原PDF第2页：PDF2'}));
 assert.deepEqual(calls,[2]);
 const props={summaries,onJump(){},onClose(){},onPages(){},onOutline(){}};
 ui.rerender(React.createElement(ReaderSummaries,{...props,active:false,page:2}));
 ui.rerender(React.createElement(ReaderSummaries,{...props,active:true,page:2}));
 assert.equal(ui.getByLabelText('查看章节总结').value,'A:ch-one');
 assert.equal(ui.container.querySelector('.reader-summary-content').scrollTop,250);
 fireEvent.click(ui.getByRole('button',{name:'查看本页章节'}));
 assert.equal(ui.getByLabelText('查看章节总结').value,'A:ch-two');
});


test('unmatched legacy summaries remain readable without claiming they belong to the current chapter',()=>{
 const summaries=[{chapter_key:'legacy:A:0',title:'旧目录章节',start_page:1,end_page:2,depth:0,content:'历史内容 PDF2'}];
 const ui=render(React.createElement(ReaderSummaries,{active:true,page:1,summaries,onJump(){},onClose(){},onPages(){},onOutline(){}}));
 assert.match(ui.getByLabelText('查看章节总结').textContent,/历史总结/);
 assert.match(ui.getByRole('status').textContent,/尚未可靠匹配/);
 assert.equal(ui.getByRole('button',{name:'查看本页章节'}).disabled,true);
 assert.ok(ui.getByRole('button',{name:'查看原PDF第2页：PDF2'}));
});
