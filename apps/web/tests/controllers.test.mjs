import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {JSDOM} from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'http://localhost/'});
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const {render, renderHook, fireEvent, act, cleanup} = await import('@testing-library/react');
const {useConversation} = await import('../.tmp/tests/features/assistant/useConversation.js');
const {useFlashcards} = await import('../.tmp/tests/features/practice/useFlashcards.js');
const {useDocumentLearningData} = await import('../.tmp/tests/shared/useDocumentLearningData.js');
const {LibraryHome} = await import('../.tmp/tests/features/library/LibraryHome.js');
const {PracticeWorkspace} = await import('../.tmp/tests/features/practice/PracticeWorkspace.js');
const {FloatingQuestion} = await import('../.tmp/tests/features/practice/FloatingQuestion.js');
afterEach(cleanup);

const book = {id: 'A', title: '教材A', byte_size: 100, folder_id: null, created_at: ''};
const other = {...book, id: 'B', title: '教材B', folder_id: 'folder'};
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const options = doc => ({activeDocument: doc, documents: [book, other], activeProfile: 'model', profiles: [], excerpt: '原文', currentPage: 3,
  chapterSummaries: [], master: false, includeCurrentExcerpt: true, multiBookMode: false, selectedBookIds: [], useWebVerification: false, deepAnswer: false,
  onNoteSaved() {}, setError() {}});
function useChat(doc, dependencies, overrides = {}) {
  const [busy, setBusy] = React.useState(false);
  return {...useConversation({...options(doc), ...overrides, busy, setBusy}, dependencies), busy};
}

test('excerpt chat streams to Assistant and preserves page/source parameters', async () => {
  let sent;
  const dependencies = {ensureIndex() {throw Error('excerpt must not index');}, async stream(payload, delta) {sent = payload; delta('结论'); delta('与依据');}};
  const hook = renderHook(() => useChat(book, dependencies));
  await act(async () => {await hook.result.current.runAsk('问题');});
  assert.equal(sent.excerpt, '原文'); assert.equal(sent.page_number, 3); assert.equal(sent.persist_history, false);
  assert.equal(hook.result.current.assistantMessages.at(-1).content, '结论与依据');
  assert.equal(hook.result.current.messages.length, 0); assert.equal(hook.result.current.busy, false);
});

test('late A responses cannot overwrite a later A visit or finish its new request', async () => {
  const calls = [];
  const dependencies = {ensureIndex() {throw Error('not used');}, stream(...args) {const done = deferred(); calls.push({args, done}); return done.promise;}};
  const hook = renderHook(({doc}) => useChat(doc, dependencies), {initialProps: {doc: book}});
  let oldRequest, newRequest;
  act(() => {oldRequest = hook.result.current.runAsk('旧问题');});
  hook.rerender({doc: other}); hook.rerender({doc: book});
  act(() => {newRequest = hook.result.current.runAsk('新问题');});
  assert.equal(calls[0].args[2].aborted, true);
  await act(async () => {
    calls[0].args[1]('过期正文'); calls[0].args[3]([{content: 'old'}], {indexed_pages: 1});
    calls[0].args[4]({warning: 'old'}, true); calls[0].args[5]([{title: 'old'}]);
    calls[0].args[6]({stage: 'old', message: 'old'}); calls[0].done.resolve(); await oldRequest;
  });
  assert.equal(hook.result.current.busy, true); assert.deepEqual(hook.result.current.ragSources, []);
  assert.deepEqual(hook.result.current.webSources, []); assert.equal(hook.result.current.citationVerification, null);
  assert.equal(hook.result.current.assistantMessages[0].content, '新问题');
  assert.equal(hook.result.current.assistantMessages[1].content, '');
  await act(async () => {calls[1].args[1]('新回答'); calls[1].done.resolve(); await newRequest;});
  assert.equal(hook.result.current.assistantMessages[1].content, '新回答'); assert.equal(hook.result.current.busy, false);
});

test('cancel during indexing aborts the signal and prevents any later model call', async () => {
  const done = deferred(); let signal, streamed = 0;
  const dependencies = {ensureIndex(id, progress, passed) {signal = passed; return done.promise;}, async stream() {streamed++;}};
  const hook = renderHook(() => useChat(book, dependencies, {includeCurrentExcerpt: false}));
  let request; act(() => {request = hook.result.current.runAsk('全文问题');});
  act(() => hook.result.current.cancelAsk());
  assert.equal(signal.aborted, true); assert.equal(hook.result.current.busy, false);
  assert.equal(hook.result.current.agentEvents.at(-1).stage, 'cancelled');
  await act(async () => {done.resolve({indexedPages: 1, totalPages: 1}); await request;});
  assert.equal(streamed, 0);
});

test('unmount aborts active chat and ignores late errors', async () => {
  const done = deferred(); let signal; const errors = [];
  const hook = renderHook(() => useChat(book, {ensureIndex() {}, stream(payload, delta, passed) {signal = passed; return done.promise;}}, {setError: error => {if (error) errors.push(error);}}));
  let request; act(() => {request = hook.result.current.runAsk('question');});
  hook.unmount(); assert.equal(signal.aborted, true);
  await act(async () => {done.reject(new Error('late failure')); await request;});
  assert.deepEqual(errors, []);
});

test('card generation rejects duplicate submissions and ignores an older book visit', async () => {
  const previous = globalThis.fetch; const calls = [];
  globalThis.fetch = () => {const done = deferred(); calls.push(done); return done.promise;};
  try {
    const hook = renderHook(({doc}) => {
      const [busy, setBusy] = React.useState(false);
      return {...useFlashcards({activeDocument: doc, activeProfile: 'model', currentPage: 1, excerpt: '题目', busy, setBusy, setError() {}}), busy};
    }, {initialProps: {doc: book}});
    let oldRequest, newRequest;
    act(() => {oldRequest = hook.result.current.makeFlashcards(); hook.result.current.makeFlashcards();});
    assert.equal(calls.length, 1);
    hook.rerender({doc: other}); hook.rerender({doc: book});
    act(() => {newRequest = hook.result.current.makeFlashcards();});
    await act(async () => {calls[0].resolve({ok: true, json: async () => ({flashcards: [{id: 'old'}]})}); await oldRequest;});
    assert.deepEqual(hook.result.current.flashcards, []); assert.equal(hook.result.current.busy, true);
    const cards = Array.from({length: 12}, (_, i) => ({id: String(i), question: `题目${i}`, answer: '答案'}));
    await act(async () => {calls[1].resolve({ok: true, json: async () => ({flashcards: cards})}); await newRequest;});
    assert.equal(hook.result.current.flashcards.length, 12); assert.equal(hook.result.current.recognizedCardCount, 12);
    assert.equal(hook.result.current.floatingCardId, '0'); assert.equal(hook.result.current.busy, false);
  } finally {globalThis.fetch = previous;}
});

test('book learning data ignores all late results from an older visit', async () => {
  const previous = globalThis.fetch; const requests = []; const loaded = [];
  globalThis.fetch = url => {const done = deferred(); requests.push({url, done}); return done.promise;};
  try {
    const hook = renderHook(({id}) => useDocumentLearningData(id, {reset() {}, loaded: data => loaded.push(data), error() {throw Error('unexpected');}}), {initialProps: {id: 'A'}});
    hook.rerender({id: 'B'}); hook.rerender({id: 'A'});
    const finish = group => group.forEach(({done}) => done.resolve({ok: true, json: async () => ({messages: [], notes: [], flashcards: [], summaries: []})}));
    await act(async () => {finish(requests.slice(0, 8));});
    assert.equal(loaded.length, 0);
    await act(async () => {finish(requests.slice(8));});
    assert.equal(loaded.length, 1);
    hook.unmount();
  } finally {globalThis.fetch = previous;}
});

test('library filters books and routes open/move/folder actions without changing the UI contract', () => {
  const actions = [];
  const props = {activeDocument: book, currentPage: 3, notesCount: 1, masteredCount: 2, documents: [book, other], folders: [{id: 'folder', name: '学习', document_count: 1}], selectedFolderId: 'unfiled',
    setSelectedFolderId: id => actions.push(['folder', id]), enterReader() {}, onOverview() {}, onImport() {}, openBook: doc => actions.push(['open', doc.id]),
    renameBook() {}, removeBook() {}, moveBookToFolder: (doc, id) => actions.push(['move', doc.id, id]), addFolder() {}, editFolder() {}, removeFolder() {}};
  const ui = render(React.createElement(LibraryHome, props));
  assert.equal(ui.queryByRole('button', {name: '打开教材 教材B'}), null);
  fireEvent.click(ui.getByRole('button', {name: '打开教材 教材A'}));
  fireEvent.change(ui.getByLabelText('移动到'), {target: {value: 'folder'}});
  fireEvent.click(ui.getByRole('button', {name: /全部教材\s*2/}));
  assert.deepEqual(actions, [['open', 'A'], ['move', 'A', 'folder'], ['folder', 'all']]);
});

test('practice view opens the selected question and floating navigation retains review/page callbacks', () => {
  const actions = []; const cards = [{id: 'one', question: '问题1', answer: '答案1', page_number: 7}, {id: 'two', question: '问题2', answer: '答案2', page_number: 8}];
  const practice = {flashcards: cards, recognizedCardCount: 2, makeFlashcards() {}, manualQuestion: '', setManualQuestion() {}, manualAnswer: '', setManualAnswer() {}, addManualCard() {}, editCard() {}, removeFlashcard() {},
    floatingCardId: 'one', setFloatingCardId: id => actions.push(['select', id]), markCard: (card, mastered) => actions.push(['review', card.id, mastered])};
  const ui = render(React.createElement(React.Fragment, null,
    React.createElement(PracticeWorkspace, {practice, canGenerate: false, busy: false, error: '', onOpenCard: id => actions.push(['open', id])}),
    React.createElement(FloatingQuestion, {practice, floatingCardOffset: {x: 0, y: 0}, beginFloatingCardDrag() {}, requestReaderPage: page => actions.push(['page', page])})));
  fireEvent.click(ui.getByText('问题2')); fireEvent.click(ui.getByRole('button', {name: '下一题'}));
  assert.equal(ui.getByRole('button', {name: '上一题'}).disabled, true);
  fireEvent.click(ui.getByRole('button', {name: '已掌握'})); fireEvent.click(ui.getByRole('button', {name: '回到原题'}));
  assert.deepEqual(actions, [['open', 'two'], ['select', 'two'], ['review', 'one', true], ['page', 7]]);
});


test('multi-book Master preserves selected scope, history mode and verification callbacks', async () => {
  const indexed = []; let sent;
  const dependencies = {async ensureIndex(id) {indexed.push(id); return {indexedPages: 2, totalPages: 2};},
    async stream(payload, delta, signal, sources, verification, web, progress) {
      sent = payload; delta('跨书回答'); sources([{document_id: 'B', page_number: 2, content: '依据'}], {document_count: 2});
      verification({method: 'local', warning: '', counts: {supported: 1}, checks: []}, false);
      web([{title: '外部资料', url: 'https://example.com', snippet: '摘要'}]);
      progress({stage: 'done', message: '完成', model_calls: 4, max_model_calls: 4});
    }};
  const hook = renderHook(() => useChat(book, dependencies, {includeCurrentExcerpt: false, multiBookMode: true,
    selectedBookIds: ['A', 'B'], master: true, useWebVerification: true, deepAnswer: true}));
  await act(async () => {await hook.result.current.runAsk('比较');});
  assert.deepEqual(indexed, ['A', 'B']); assert.deepEqual(sent.document_ids, ['A', 'B']);
  assert.equal(sent.persist_history, true); assert.equal(sent.use_agent, true); assert.equal(sent.use_web, true);
  assert.equal(hook.result.current.messages.at(-1).content, '跨书回答');
  assert.equal(hook.result.current.ragSources[0].document_id, 'B');
  assert.equal(hook.result.current.citationVerification.counts.supported, 1);
});

test('a completed fast response remains attached to its answer across batched sequential calls', async () => {
  const hook = renderHook(() => useChat(book, {ensureIndex() {}, async stream(payload, delta) {delta(payload.question + '的回答');}}));
  await act(async () => {await hook.result.current.runAsk('第一题'); await hook.result.current.runAsk('第二题');});
  assert.deepEqual(hook.result.current.assistantMessages.filter(item => item.role === 'assistant').map(item => item.content), ['第一题的回答', '第二题的回答']);
});

test('note results from a previous A visit do not clear the draft of a new A visit', async () => {
  const previous = globalThis.fetch; const done = deferred();
  globalThis.fetch = () => done.promise;
  try {
    const {useNotes} = await import('../.tmp/tests/features/notes/useNotes.js');
    const hook = renderHook(({doc}) => useNotes(doc, 1, '', () => {}), {initialProps: {doc: book}});
    act(() => hook.result.current.setNoteDraft('旧草稿'));
    let request; act(() => {request = hook.result.current.addNote();});
    hook.rerender({doc: other}); hook.rerender({doc: book});
    act(() => hook.result.current.setNoteDraft('新草稿'));
    await act(async () => {done.resolve({ok: true, json: async () => ({note: {id: 'old', content: '旧草稿'}})}); await request;});
    assert.equal(hook.result.current.noteDraft, '新草稿'); assert.deepEqual(hook.result.current.notes, []);
  } finally {globalThis.fetch = previous;}
});

test('summary source matching respects the chapter page range', async () => {
  const {locateSummarySources} = await import('../.tmp/tests/features/summary/sourceTrace.js');
  const results = locateSummarySources('虚拟内存', [{page_number: 1, text: '虚拟内存'}, {page_number: 5, text: '虚拟内存依靠页面置换。'}], 5, 8);
  assert.deepEqual(results.map(item => item.page), [5]); assert.match(results[0].snippet, /页面置换/);
});
