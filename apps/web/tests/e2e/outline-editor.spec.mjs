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

test('independent drafts preserve the summary, preview PDF and Word images, and jump to the textbook', async ({page}, info) => {
 const book = await clone(page, 'E2E Bookmarks', 'Independent drafts ' + info.project.name);
 const base = `/api/documents/${book.id}`;
 const pdf = await (await page.request.get(base + '/file')).body();
 const {default: JSZip} = await import('jszip');
 const word = new JSZip();
 word.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 word.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 word.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/dot.png"/></Relationships>');
 word.file('word/media/dot.png', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', {base64:true});
 word.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
   <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Word 排版正文</w:t></w:r></w:p>
   <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Word 表格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
   <w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="image1"/></pic:blipFill><pic:spPr><a:xfrm><a:ext cx="914400" cy="914400"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
   <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`);
 await page.goto('/');
 await page.locator('.library-book').filter({hasText: book.title}).getByRole('button', {name:/打开教材/}).click();
 await page.locator('.chapter-entry').filter({hasText:'Original section'}).click();
 const upload = async (name, buffer) => {
   const chooser = page.waitForEvent('filechooser');
   await page.getByRole('button', {name:'导入其他生成', exact:true}).click();
   await (await chooser).setFiles({name, mimeType:'application/octet-stream', buffer});
 };
 const old = page.waitForEvent('filechooser');
 await page.getByRole('button', {name:'导入小章内容', exact:true}).click();
 await (await old).setFiles({name:'original.txt', mimeType:'text/plain', buffer:Buffer.from('保留此原总结')});
 await expect(page.locator('.chapter-summary-content')).toContainText('保留此原总结');
 await upload('对照稿.pdf', pdf);
 await expect(page.getByRole('region', {name:'导入稿预览'}).locator('canvas')).toBeVisible();
 const preview = page.getByRole('region', {name:'导入稿预览'});
 const mode = preview.getByLabel('导入稿翻页方式');
 await preview.getByRole('button', {name:'下一页', exact:true}).click();
 await expect(preview.getByLabel('导入稿页码')).toHaveValue('2');
 await mode.selectOption('scroll');
 const scroll = preview.getByLabel('滑动翻阅导入稿');
 await scroll.evaluate(root => {root.scrollTop = 0;});
 await expect(preview.getByLabel('导入稿页码')).toHaveValue('1');
 await mode.selectOption('click');
 await preview.getByRole('button', {name:'添加教材页码跳转'}).click();
 const editor = preview.getByRole('form', {name:'教材页码跳转编辑'});
 await expect(editor).toHaveCount(1);
 await editor.getByLabel('教材 PDF 页码').fill('2');
 await editor.getByLabel('按钮名称').fill('定位按钮');
 const sheet = preview.locator('.chapter-draft-sheet');
 await sheet.evaluate(node => node.scrollIntoView({block:'start'}));
 const box = await sheet.boundingBox();
 await page.mouse.move(box.x + box.width * .2, box.y + box.height * .1);
 await page.mouse.down();
 await page.mouse.move(box.x + box.width * .5, box.y + box.height * .2);
 await page.mouse.up();
 await editor.getByRole('button', {name:'保存跳转'}).click();
 const overlay = sheet.getByRole('button', {name:'定位按钮'});
 await expect(overlay).toBeVisible();
 const placed = await overlay.boundingBox();
 expect((placed.x - box.x) / box.width).toBeCloseTo(.2, 1);
 expect(placed.width / box.width).toBeCloseTo(.3, 1);
 await preview.getByText('管理本页跳转（1）').click();
 await preview.getByRole('button', {name:'编辑跳转', exact:true}).click();
 await editor.getByLabel('按钮名称').fill('已修改按钮');
 await editor.getByRole('button', {name:'保存跳转'}).click();
 await expect(sheet.getByRole('button', {name:'已修改按钮'})).toBeVisible();
 await preview.getByRole('button', {name:'删除跳转', exact:true}).click();
 await expect(sheet.getByRole('button', {name:'已修改按钮'})).toHaveCount(0);
 await upload('带图稿.docx', await word.generateAsync({type:'nodebuffer'}));
 const frame = page.frameLocator('iframe[title="导入稿正文"]');
 await expect(frame.getByText('Word 排版正文', {exact:true})).toHaveCSS('font-weight', '700');
 await expect(frame.locator('td')).toContainText('Word 表格');
 await expect.poll(() => frame.locator('img').evaluate(img => img.naturalWidth)).toBe(1);
 const versions = page.getByLabel('查看总结版本');
 await expect(versions.locator('option')).toHaveCount(3);
 await versions.selectOption('');
 await expect(page.locator('.chapter-summary-content')).toContainText('保留此原总结');
 await versions.selectOption({label:'2. 带图稿.docx'});
 await page.getByRole('button', {name:'添加教材页码跳转'}).click();
 await page.getByLabel('教材 PDF 页码').fill('1');
 await page.getByLabel('按钮名称').fill('查看教材第一面');
 await page.getByRole('button', {name:'保存跳转'}).click();
 await page.getByRole('button', {name:'查看教材第一面'}).click();
 await expect(page.getByLabel('PDF页码')).toHaveValue('1');
 await page.getByRole('button', {name:'返回总结', exact:false}).first().click();
 await expect(page.getByRole('button', {name:'查看教材第一面'})).toBeVisible();
 await page.getByRole('button', {name:/继续 PDF/}).click();
 await page.getByRole('button', {name:'章节总结', exact:true}).click();
 const panel = page.getByRole('complementary', {name:'PDF章节总结'});
 await panel.getByLabel('查看章节总结').selectOption({label:'Original section · PDF 2-2'});
 await expect(panel.getByLabel('查看总结版本').locator('option')).toHaveCount(3);
 await panel.getByRole('button', {name:'查看教材第一面'}).click();
 await expect(page.getByLabel('PDF页码')).toHaveValue('1');
 await page.getByRole('button', {name:'↩ 返回章节总结'}).click();
 await expect(panel.getByRole('button', {name:'查看教材第一面'})).toBeVisible();
});
