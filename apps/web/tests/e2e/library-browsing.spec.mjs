import {test, expect} from '@playwright/test';

test('bookshelf remembers grid view and moves the latest opened textbook to the front', async ({page}, info) => {
  test.skip(info.project.name !== 'mouse', 'Same bookshelf layout in both projects');
  await page.goto('/');
  const switcher = page.getByRole('group', {name: '教材显示方式'});
  await switcher.getByRole('button', {name: '网格'}).click();
  const books = page.locator('.book-list-original.library-grid .library-book');
  await expect(books).toHaveCount(3);
  await expect(page.locator('.library-grid')).toHaveCSS('display', 'grid');
  await page.getByRole('button', {name: '打开教材 E2E Native', exact: true}).click();
  await page.getByRole('button', {name: '学习空间', exact: true}).click();
  await expect(books.first().locator('.book-identity strong')).toHaveText('E2E Native');
  await page.getByRole('button', {name: '打开教材 E2E Scan', exact: true}).click();
  await page.getByRole('button', {name: '学习空间', exact: true}).click();
  await expect(books.first().locator('.book-identity strong')).toHaveText('E2E Scan');
  await page.reload();
  await expect(switcher.getByRole('button', {name: '网格'})).toHaveAttribute('aria-pressed', 'true');
  await expect(books.first().locator('.book-identity strong')).toHaveText('E2E Scan');
});
