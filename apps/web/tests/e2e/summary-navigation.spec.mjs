import {test,expect} from '@playwright/test';
test('summary references jump to PDF page top and return to the same chapter and button',async({page}, info)=>{
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
 const grip = panel.getByRole('separator', {name:'调整总结面板宽度'});
 const originalWidth = (await panel.boundingBox()).width;
 const gripBox = await grip.boundingBox();
 if (info.project.name === 'touch') {
  const client = await page.context().newCDPSession(page);
  const x=gripBox.x+gripBox.width/2,y=gripBox.y+80;
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
  await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+150,y,id:1}]});
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await client.detach();
 } else {
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + 80);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + gripBox.width / 2 + 150, gripBox.y + 80, {steps:8});
  await page.mouse.up();
 }
 await expect.poll(async () => (await panel.boundingBox()).width).toBeCloseTo(originalWidth + 150, 0);
 const wide = (await panel.boundingBox()).width;
 expect(Number(await page.evaluate(() => localStorage.getItem('reader-summary-panel-width')))).toBeCloseTo(wide, 0);
 await grip.focus(); await grip.press('ArrowLeft');
 await expect.poll(async () => (await panel.boundingBox()).width).toBeCloseTo(wide - 16, 0);
 await panel.getByRole('button',{name:'关闭章节总结'}).click();
 await page.getByRole('button',{name:'章节总结',exact:true}).click();
 await expect.poll(async () => (await panel.boundingBox()).width).toBeCloseTo(wide - 16, 0);
 await grip.dblclick({position:{x:4,y:80}});
 await expect.poll(async () => (await panel.boundingBox()).width).toBeCloseTo(420, 0);
 await panel.getByRole('button',{name:'关闭章节总结'}).click();
 for(const width of [1440,1180,900,640]){
  await page.setViewportSize({width,height:1000});
  const toolbar=page.locator('.original-toolbar');
  await expect.poll(()=>toolbar.evaluate(root=>{
   const bounds=root.getBoundingClientRect();
   const buttons=[...root.querySelectorAll('.reader-tools > button, .reader-more > summary')].filter(b=>getComputedStyle(b).display!=='none');
   const rects=buttons.map(b=>b.getBoundingClientRect());
   return rects.every(r=>r.left>=bounds.left && r.right<=bounds.right+1 && r.top>=bounds.top && r.bottom<=bounds.bottom+1)
    && rects.every((a,i)=>rects.slice(i+1).every(b=>a.right<=b.left+1 || b.right<=a.left+1 || a.bottom<=b.top+1 || b.bottom<=a.top+1));
  })).toBe(true);
  await toolbar.locator('.reader-more > summary').click();
  const settings=toolbar.locator('.reader-more > div');
  await expect(settings).toBeVisible();
  const paper=settings.getByRole('checkbox',{name:'柔和纸色'});
  await paper.check();await expect(paper).toBeChecked();await paper.uncheck();
  const bounds=await toolbar.boundingBox();
  const popup=await settings.boundingBox();
  expect(popup.y).toBeGreaterThanOrEqual(bounds.y+bounds.height-1);
  expect(popup.x).toBeGreaterThanOrEqual(bounds.x);
  expect(popup.x+popup.width).toBeLessThanOrEqual(bounds.x+bounds.width+1);
  await toolbar.locator('.reader-more > summary').click();
  await toolbar.getByRole('button',{name:'章节总结',exact:true}).click();
  await expect.poll(async()=>{
   const t=await toolbar.boundingBox();const p=await panel.boundingBox();
   return Math.abs(p.y-t.y-t.height);
  }).toBeLessThan(2);
  if(width===1180)await page.screenshot({path:'.tmp/reader-toolbar-fixed.png'});
  await panel.getByRole('button',{name:'关闭章节总结'}).click();
 }
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'章节总结',exact:true}).click();
 await expect(panel.getByLabel('查看章节总结')).toHaveValue((await (await page.request.get(`/api/documents/${book.id}/chapter-summaries`)).json()).summaries.find(s=>s.title==='第二章测试').chapter_key);
});
