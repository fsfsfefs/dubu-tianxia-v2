import {test,expect} from '@playwright/test';

async function clone(page,source,title){
 const docs=(await(await page.request.get('/api/documents')).json()).documents;
 const original=docs.find(item=>item.title===source);
 const buffer=await(await page.request.get(`/api/documents/${original.id}/file`)).body();
 const result=await(await page.request.post('/api/documents',{multipart:{file:{name:title+'.pdf',mimeType:'application/pdf',buffer:Buffer.concat([buffer,Buffer.from('\n%outline-'+title+'\n')])}}})).json();
 await expect.poll(async()=>{const tasks=(await(await page.request.get('/api/tasks')).json()).tasks;return tasks.filter(t=>t.document_id===result.document.id).every(t=>t.status==='completed');}).toBe(true);
 return result.document;
}

test('missing outline becomes an editable AI draft; saved corrections drive overview and reader',async({page},testInfo)=>{
 const book=await clone(page,'E2E Native','Outline AI '+testInfo.project.name);
 await page.route('**/api/model-profiles',route=>route.fulfill({json:{profiles:[{id:'fake',name:'测试模型',model:'test-model'}]}}));
 const current=await(await page.request.get(`/api/documents/${book.id}/outline`)).json();
 await page.route(`**/api/documents/${book.id}/outline/generate`,route=>route.fulfill({json:{...current,source:'ai-draft',generated:true,message:'AI目录草稿，请人工校对',outline:[{title:'AI chapter',page:1,depth:0},{title:'AI section',page:2,depth:1}]}}));
 await page.goto('/');
 await page.locator('.library-book').filter({hasText:book.title}).getByRole('button',{name:/打开教材/}).click();
 await page.getByRole('button',{name:'生成 / 编辑目录',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'目录编辑与校对'});
 await expect(dialog.getByRole('button',{name:'AI生成目录草稿'})).toBeEnabled();
 await expect.poll(()=>dialog.locator('canvas').evaluate(canvas=>canvas.height/canvas.width)).toBeGreaterThan(1.3);
 await dialog.getByRole('button',{name:'AI生成目录草稿'}).click();
 await expect(dialog.getByLabel('第2项标题')).toHaveValue('AI section');
 expect((await(await page.request.get(`/api/documents/${book.id}/outline`)).json()).outline).toHaveLength(0);
 await dialog.getByLabel('第2项标题').fill('人工校对章节');
 await dialog.getByRole('button',{name:'校对原文',exact:true}).nth(1).click();
 await expect(dialog.locator('canvas')).toHaveAttribute('aria-label','原文PDF第2页预览');
 await dialog.getByRole('button',{name:'保存校对目录'}).click();
 await expect(dialog).not.toBeVisible();
 await expect(page.locator('.chapter-entry').filter({hasText:'人工校对章节'})).toBeVisible();
 await page.getByRole('button',{name:/继续 PDF/}).click();
 await page.locator('.reader-tools').getByRole('button',{name:'目录',exact:true}).click();
 const navigation=page.getByRole('complementary',{name:'页面与目录导航'});
 await navigation.getByRole('button',{name:/人工校对章节/}).click();
 await expect(page.getByLabel('PDF页码')).toHaveValue('2');
 await navigation.getByRole('button',{name:'编辑 / 校对目录'}).click();
 await expect(dialog.getByLabel('第2项标题')).toHaveValue('人工校对章节');
 await expect(dialog.getByRole('button',{name:'AI生成目录草稿'})).toHaveCount(0);
 await dialog.getByLabel('第2项页码').fill('99');
 await dialog.getByRole('button',{name:'保存校对目录'}).click();
 await expect(dialog.getByRole('alert')).toContainText('页码');
 await dialog.getByLabel('第2项页码').fill('2');
 await page.setViewportSize({width:640,height:1000});
 await expect.poll(()=>dialog.locator('canvas').evaluate(canvas=>canvas.height/canvas.width)).toBeGreaterThan(1.3);
 await page.screenshot({path:'.tmp/outline-editor-mobile.png'});
 await dialog.getByRole('button',{name:'保存校对目录'}).click();
 await expect(dialog).not.toBeVisible();
 expect((await(await page.request.get(`/api/documents/${book.id}/outline`)).json()).outline[1]).toMatchObject({title:'人工校对章节',page:2,depth:1});
});

test('original PDF bookmarks are reused and can be corrected without AI',async({page},testInfo)=>{
 const book=await clone(page,'E2E Bookmarks','Outline Original '+testInfo.project.name);
 await page.goto('/');
 await page.locator('.library-book').filter({hasText:book.title}).getByRole('button',{name:/打开教材/}).click();
 await page.getByRole('button',{name:'编辑 / 校对目录',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'目录编辑与校对'});
 await expect(dialog.getByText(/已使用原文书签/)).toBeVisible();
 await expect(dialog.getByLabel('第1项标题')).toHaveValue('Original chapter');
 await expect(dialog.getByRole('button',{name:'AI生成目录草稿'})).toHaveCount(0);
 await dialog.getByLabel('第1项标题').fill('原目录人工修订');
 await dialog.getByRole('button',{name:'保存校对目录'}).click();
 await expect(dialog).not.toBeVisible();
 await expect(page.locator('.chapter-entry').filter({hasText:'原目录人工修订'})).toBeVisible();
});
