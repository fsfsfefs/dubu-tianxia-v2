import {test, expect} from '@playwright/test';

test('long answer cards preserve source lines and remain within separate card bounds', async ({page}, info) => {
  test.skip(info.project.name !== 'mouse', 'Same card layout in both browser projects');
  await page.setViewportSize({width: 1200, height: 850});
  const question = ['9. 下列说法正确的有（ ）',
    ...Array.from({length: 5}, (_, i) => '①②③④⑤'[i] + '区域协调发展的资料说明'.repeat(5)),
    'A 2 项', 'B 3 项', 'C 4 项', 'D 5 项'].join('\n');
  await page.route('**/api/documents/*/flashcards', route => route.fulfill({json: {flashcards: [
    {id: 'long', page_number: 1, question, answer: 'A\n解析第二行', review_count: 0},
    {id: 'short', page_number: 2, question: '10. 下一题', answer: 'B', review_count: 0},
  ]}}));
  await page.goto('/');
  await page.locator('.library-book').filter({hasText: 'E2E Native'}).getByRole('button', {name: /打开教材/}).click();
  await page.getByRole('button', {name: /继续 PDF/}).click();
  await page.getByRole('button', {name: 'AI助读', exact: true}).click();
  await page.getByRole('button', {name: '练习', exact: true}).click();
  const cards = page.locator('.flashcard-list .flashcard');
  await expect(cards).toHaveCount(2);
  const content = cards.first().locator('.flashcard-question');
  expect(await content.textContent()).toBe(question);
  await expect(content).toHaveCSS('white-space', 'pre-wrap');
  const geometry = await cards.evaluateAll(([first, second]) => ({
    first: first.getBoundingClientRect().bottom,
    text: first.querySelector('.flashcard-question').getBoundingClientRect().bottom,
    next: second.getBoundingClientRect().top,
  }));
  expect(geometry.text).toBeLessThan(geometry.first);
  expect(geometry.next - geometry.first).toBeGreaterThanOrEqual(10);
  await content.focus();
  await page.keyboard.press('Enter');
  const floating = page.getByRole('region', {name: '题目悬浮窗'});
  await expect(floating).toBeVisible();
  expect(await floating.locator('h3').textContent()).toBe(question);
  await floating.locator('.floating-card-body').evaluate(el => {el.scrollTop = el.scrollHeight;});
  await floating.getByRole('button', {name: '下一题'}).click();
  await expect(floating.locator('h3')).toHaveText('10. 下一题');
  expect(await floating.locator('.floating-card-body').evaluate(el => el.scrollTop)).toBe(0);
});

test('card edits persist separate multiline answer and explanation after reopening', async ({page}, info) => {
  test.skip(info.project.name !== 'mouse', 'Same editor in both browser projects');
  const docs = (await (await page.request.get('/api/documents')).json()).documents;
  const book = docs.find(item => item.title === 'E2E Native');
  const url = `/api/documents/${book.id}/flashcards`;
  const response = await page.request.post(url, {data: {page_number: 1, question: '测试自定义答题卡片', answer: 'A'}});
  expect(response.ok()).toBe(true);
  const {flashcard} = await response.json();
  try {
    await page.goto('/');
    await page.locator('.library-book').filter({hasText: 'E2E Native'}).getByRole('button', {name: /打开教材/}).click();
    await page.getByRole('button', {name: /继续 PDF/}).click();
    await page.getByRole('button', {name: 'AI助读', exact: true}).click();
    await page.getByRole('button', {name: '练习', exact: true}).click();
    await page.locator('.flashcard').filter({hasText: '测试自定义答题卡片'}).getByRole('button', {name: '编辑', exact: true}).click();
    const editor = page.getByRole('form', {name: '编辑答题卡片'});
    await expect(editor.getByRole('textbox', {name: '答案', exact: true})).toHaveValue('A');
    await editor.getByRole('textbox', {name: '答案', exact: true}).fill('B\n正确选项');
    await editor.getByRole('textbox', {name: '解释（选填）', exact: true}).fill('第一个理由\n第二个理由');
    await editor.getByRole('button', {name: '保存修改'}).click();
    await expect(editor).toHaveCount(0);
    const floating = page.getByRole('region', {name: '题目悬浮窗'});
    expect(await floating.locator('section p').allTextContents()).toEqual(['B\n正确选项', '第一个理由\n第二个理由']);
    await floating.getByRole('button', {name: '关闭题目悬浮窗'}).click();
    await page.getByRole('button', {name: '测试自定义答题卡片', exact: true}).click();
    await floating.getByRole('button', {name: '编辑卡片'}).click();
    await expect(editor.getByRole('textbox', {name: '解释（选填）', exact: true})).toHaveValue('第一个理由\n第二个理由');
    await editor.getByRole('button', {name: '取消', exact: true}).click();
    const saved = (await (await page.request.get(url)).json()).flashcards.find(item => item.id === flashcard.id);
    expect([saved.answer, saved.explanation]).toEqual(['B\n正确选项', '第一个理由\n第二个理由']);
  } finally {
    await page.request.delete(`${url}/${flashcard.id}`);
  }
});
