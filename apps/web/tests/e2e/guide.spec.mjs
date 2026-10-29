import {test,expect} from '@playwright/test';

test('guide is available on first use and supports search, table of contents, download and Escape',async({page})=>{
 await page.goto('/');
 const opener=page.getByRole('button',{name:'打开使用指南'});await opener.click();
 const guide=page.getByRole('dialog',{name:'读步天下使用指南'});await expect(guide).toBeVisible();
 await expect(guide.getByRole('heading',{name:/第一次使用/})).toBeInViewport();
 await guide.getByRole('searchbox',{name:'查找功能'}).fill('灰色');
 await expect(guide.getByText(/“导读”“行间教学”目前只允许当前原文模式/)).toBeVisible();
 await guide.getByRole('button',{name:'清空指南搜索'}).click();
 await guide.getByRole('link',{name:/15 · 导出/}).click();
 await expect(guide.getByRole('heading',{name:/15 · 导出/})).toBeInViewport();
 const downloadPromise=page.waitForEvent('download');await guide.getByRole('button',{name:'下载 Markdown'}).click();
 expect((await downloadPromise).suggestedFilename()).toBe('读步天下使用指南.md');
 await page.keyboard.press('Escape');await expect(guide).not.toBeVisible();await expect(opener).toBeFocused();
});

test('guide opens in overview, learning memory and PDF without losing the reading page',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'打开教材 E2E Native',exact:true}).click();
 await page.getByRole('button',{name:'使用指南',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();
 await page.getByRole('button',{name:'关闭使用指南'}).click();await expect(page.getByRole('heading',{name:'E2E Native',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'学习记忆',exact:true}).click();await page.getByRole('button',{name:'使用指南',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'关闭使用指南'}).click();
 await page.getByRole('button',{name:'学习空间',exact:true}).click();await page.getByRole('button',{name:'继续学习 →',exact:true}).click();
 const pageInput=page.locator('.page-controls input');await expect(pageInput).toBeVisible();await pageInput.fill('2');await expect(pageInput).toHaveValue('2');
 await page.getByRole('button',{name:'使用指南',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();
 await page.getByRole('button',{name:'关闭使用指南'}).click();await expect(pageInput).toHaveValue('2');
});

test('guide remains readable on a narrow screen with no model or API connection',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.route('**/api/**',route=>route.abort());await page.goto('/');
 await page.getByRole('button',{name:'打开使用指南'}).click();const guide=page.getByRole('dialog');await expect(guide).toBeVisible();
 const bounds=await guide.boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(391);
 await guide.getByRole('searchbox',{name:'查找功能'}).fill('RAG');await expect(guide.getByRole('status')).not.toHaveText('0 / 16 章');
 await page.keyboard.press('Escape');await expect(guide).not.toBeVisible();
});
