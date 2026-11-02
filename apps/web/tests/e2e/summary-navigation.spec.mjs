import {test,expect} from '@playwright/test';
test('summary references jump to PDF page top and return to the same chapter and button',async({page})=>{
 const docs=(await (await page.request.get('/api/documents')).json()).documents;
 const book=docs.find(d=>d.title==='E2E Native');
 const outline=[{title:'第一章测试',page:1,depth:0},{title:'第二章测试',page:2,depth:0}];
 const imported=await page.request.put(`/api/documents/${book.id}/learning-structure-import`,{data:{outline,summaries:[
  {chapter_key:book.id+':0',title:'第一章测试',start_page:1,end_page:1,depth:0,content:'【本节结论】\n第一章的依据请查看 PDF2。'},
  {chapter_key:book.id+':1',title:'第二章测试',start_page:2,end_page:2,depth:0,content:'【本节结论】\n第二章对应的补充说明 PDF1。'}
 ]}});
 expect(imported.ok()).toBe(true);
 await page.goto('/');
 await page.locator('.library-book').filter({hasText:'E2E Native'}).getByRole('button',{name:/打开教材/}).click();
 await page.locator('.chapter-entry').filter({hasText:'第一章测试'}).click();
 const reference=page.getByRole('button',{name:'查看原PDF第2页：PDF2',exact:true});
 await reference.click();
 await expect(page.locator('.page-controls input')).toHaveValue('2');
 await expect.poll(async()=>{
  const root=await page.locator('.pdf-scroll').boundingBox();
  const target=await page.locator('[data-page-number="2"]').boundingBox();
  return Math.abs(target.y-root.y);
 }).toBeLessThan(8);
 await page.getByRole('button',{name:'↩ 返回总结',exact:true}).click();
 await expect(page.locator('.chapter-entry[aria-current="true"]')).toContainText('第一章测试');
 await expect(reference).toBeFocused();
 await reference.click();
 await page.getByRole('button',{name:'章节总结',exact:true}).click();
 const panel=page.getByRole('complementary',{name:'PDF章节总结'});
 await expect(panel).toBeVisible();
 await panel.getByLabel('查看章节总结').selectOption({label:'第二章测试 · PDF 2-2'});
 await panel.getByRole('button',{name:'查看原PDF第1页：PDF1'}).click();
 await expect(panel).not.toBeVisible();
 await expect(page.locator('.page-controls input')).toHaveValue('1');
 await page.getByRole('button',{name:'↩ 返回章节总结',exact:true}).click();
 await expect(panel).toBeVisible();
 await expect(panel.getByLabel('查看章节总结')).toHaveValue((await (await page.request.get(`/api/documents/${book.id}/chapter-summaries`)).json()).summaries.find(s=>s.title==='第二章测试').chapter_key);
});
