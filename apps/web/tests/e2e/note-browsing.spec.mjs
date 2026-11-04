import {test, expect} from '@playwright/test';

test('notes open in a grid and remember their order and view on reload', async ({page}, info) => {
  test.skip(info.project.name !== 'mouse', 'Same note view in both browser projects');
  const doc = (await (await page.request.get('/api/documents')).json()).documents.find(item => item.title === 'E2E Native');
  const url = `/api/documents/${doc.id}/notes`;
  const ids = [];
  async function openNotes() {
    await page.goto('/');
    await page.locator('.library-book').filter({hasText: 'E2E Native'}).getByRole('button', {name: /打开教材/}).click();
    await page.getByRole('button', {name: /继续 PDF/}).click();
    await page.getByRole('button', {name: 'AI助读', exact: true}).click();
    await page.getByRole('button', {name: /^笔记/}).click();
  }
  try {
    for (const [title, pinned] of [['测试笔记甲', false], ['测试笔记乙', false], ['测试置顶', true]]) {
      const response = await page.request.post(url, {data: {title, pinned, page_number: 1, content: title + '的完整正文'}});
      expect(response.ok()).toBe(true);
      ids.push((await response.json()).note.id);
    }
    await openNotes();
    const switcher = page.getByRole('group', {name: '笔记显示方式'});
    await switcher.getByRole('button', {name: '网格'}).click();
    const grid = page.locator('.notes-list.note-icon-grid');
    await expect(grid).toHaveCSS('display', 'grid');
    const titles = grid.locator('strong').filter({hasText: /测试/});
    await expect(titles).toHaveCount(3);
    await grid.getByRole('button', {name: /测试笔记乙/}).click();
    const detail = page.getByRole('dialog', {name: '笔记详情'});
    await expect(detail.getByText('测试笔记乙的完整正文', {exact: true})).toBeVisible();
    await detail.getByRole('button', {name: '关闭笔记详情'}).click();
    await grid.getByRole('button', {name: /测试笔记甲/}).click();
    await detail.getByRole('button', {name: '关闭笔记详情'}).click();
    await expect(titles).toHaveText(['测试置顶', '测试笔记甲', '测试笔记乙']);
    await openNotes();
    await expect(switcher.getByRole('button', {name: '网格'})).toHaveAttribute('aria-pressed', 'true');
    await expect(titles).toHaveText(['测试置顶', '测试笔记甲', '测试笔记乙']);
    await switcher.getByRole('button', {name: '列表'}).click();
    await expect(page.locator('.notes-list .note-card h3').filter({hasText: /测试/})).toHaveText(['测试置顶', '测试笔记甲', '测试笔记乙']);
  } finally {
    for (const id of ids) await page.request.delete(`${url}/${id}`);
  }
});
