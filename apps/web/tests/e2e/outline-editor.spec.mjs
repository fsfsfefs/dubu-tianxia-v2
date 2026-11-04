import {test,expect} from '@playwright/test';

async function clone(page,source,title){
 title+=` ${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
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


test('outline waiting time is visible and a timeout preserves manual draft for retry',async({page},testInfo)=>{
 const book=await clone(page,'E2E Native','Outline Timeout '+testInfo.project.name);
 await page.route('**/api/model-profiles',route=>route.fulfill({json:{profiles:[{id:'fake',name:'测试模型',model:'test-model'}]}}));
 const current=await(await page.request.get(`/api/documents/${book.id}/outline`)).json();
 let requests=0,finish;
 await page.route(`**/api/documents/${book.id}/outline/generate`,async route=>{
  requests++;
  if(requests===1){
   await new Promise(resolve=>{finish=resolve;});
   await route.fulfill({status:504,json:{detail:'目录模型连接或响应超时（单次生成最多等待5分钟）。现有目录和编辑内容未被覆盖。'}});
  } else await route.fulfill({json:{...current,generated:true,source:'ai-draft',outline:[{title:'重试成功章节',page:1,depth:0}]}});
 });
 await page.goto('/');
 await page.locator('.library-book').filter({hasText:book.title}).getByRole('button',{name:/打开教材/}).click();
 await page.getByRole('button',{name:'生成 / 编辑目录',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'目录编辑与校对'});
 await expect(dialog.getByRole('button',{name:'AI生成目录草稿'})).toBeEnabled();
 await dialog.getByRole('button',{name:'＋ 添加章节',exact:true}).click();
 await dialog.getByLabel('第1项标题').fill('人工草稿保留');
 await dialog.getByRole('button',{name:'AI生成目录草稿'}).click();
 await expect(dialog.getByRole('status')).toContainText('最多等待5分钟');
 await expect(dialog.getByRole('status')).toContainText('已等待1秒');
 await expect.poll(()=>typeof finish).toBe('function');finish();
 await expect(dialog.getByRole('alert')).toContainText('超时');
 await expect(dialog.getByLabel('第1项标题')).toHaveValue('人工草稿保留');
 expect(requests).toBe(1);
 expect((await(await page.request.get(`/api/documents/${book.id}/outline`)).json()).outline).toHaveLength(0);
 await dialog.getByRole('button',{name:'AI生成目录草稿'}).click();
 await expect(dialog.getByLabel('第1项标题')).toHaveValue('重试成功章节');
 expect(requests).toBe(2);
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();
});


test('saved leaf summary exposes import beside regenerate', async ({page}, info) => {
 const book = await clone(page, 'E2E Bookmarks', 'Leaf import ' + info.project.name);
 await page.goto('/');
 await page.locator('.library-book').filter({hasText: book.title}).getByRole('button', {name:/打开教材/}).click();
 const leaf = page.locator('.chapter-entry').filter({hasText: 'Original section'});
 await leaf.click();
 const importer = page.getByRole('button', {name:'导入小章内容', exact:true});
 await expect(importer).toBeVisible();
 const chooser = page.waitForEvent('filechooser');
 await importer.click();
 await (await chooser).setFiles({name:'extension.md', mimeType:'text/markdown', buffer:Buffer.from('人工拓展示例')});
 const actions = page.locator('.chapter-summary .chapter-task-actions');
 await expect(actions.getByRole('button', {name:'导入小章内容', exact:true})).toBeVisible();
 await expect(actions.getByRole('button', {name:'重新生成', exact:true})).toBeVisible();
 await expect(page.locator('.chapter-summary-content')).toContainText('人工拓展示例');
});
