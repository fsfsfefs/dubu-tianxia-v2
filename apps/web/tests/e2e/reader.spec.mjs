import {test,expect} from '@playwright/test';

async function openBook(page,title){
 await page.goto('/');
 await page.locator('.library-book').filter({hasText:title}).getByRole('button',{name:/打开教材/}).click();
 await page.getByRole('button',{name:/继续 PDF/}).click();
 await expect(page.locator('.continuous-page canvas').first()).toBeVisible();
 // Each scenario starts on an explicit page, independently of another project's saved reading position.
 await page.locator('.page-controls input').fill('1');
 await expect(page.locator('.continuous-page').first()).toBeInViewport({ratio:.7});
}
async function stroke(page,project){
 const layer=page.locator('.annotation-layer').first();await expect(layer).toBeInViewport({ratio:.7});
 const box=await layer.boundingBox();const x=box.x+box.width*.25,y=box.y+box.height*.3;
 if(project==='touch'){
  const client=await page.context().newCDPSession(page);
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
  for(let i=1;i<=20;i++)await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+i*5,y:y+Math.sin(i/4)*8,id:1}]});
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await client.detach();
 } else {
  await page.mouse.move(x,y);await page.mouse.down();
  for(let i=1;i<=20;i++)await page.mouse.move(x+i*5,y+Math.sin(i/4)*8);
  await page.mouse.up();
 }
 return {x:x+50,y:y+Math.sin(10/4)*8};
}

test('native PDF: pointer drawing, persistence, local erasing, undo and page search',async({page},info)=>{
 await openBook(page,'E2E Native');
 await expect(page.getByRole('button',{name:'文字层已就绪'})).toBeVisible();
 await page.getByTitle('在 PDF 上绘制标注').click();
 await stroke(page,info.project.name);
 await expect(page.locator('.annotation-stroke:not(.draft)')).toHaveCount(1);
 const docs=(await (await page.request.get('/api/documents')).json()).documents;
 const book=docs.find(d=>d.title==='E2E Native');
 await expect.poll(async()=> (await (await page.request.get(`/api/documents/${book.id}/highlights`)).json()).highlights.length).toBe(1);
 await openBook(page,'E2E Native');
 await expect(page.locator('.annotation-stroke:not(.draft)')).toHaveCount(1);
 await page.getByTitle('在 PDF 上绘制标注').click();
 await page.getByRole('button',{name:'橡皮擦',exact:true}).click();
 const saved=(await (await page.request.get(`/api/documents/${book.id}/highlights`)).json()).highlights[0];
 const point=saved.rects[Math.floor(saved.rects.length/2)],box=await page.locator('.annotation-layer').first().boundingBox();
 const x=box.x+box.width*point.x,y=box.y+box.height*point.y;
 if(info.project.name==='touch')await page.touchscreen.tap(x,y);
 else await page.mouse.click(x,y);
 await expect(page.getByRole('button',{name:'撤销 Ctrl+Z'})).toBeEnabled();
 await page.getByRole('button',{name:'撤销 Ctrl+Z'}).click();
 await expect(page.locator('.annotation-stroke:not(.draft)')).toHaveCount(1);
 await page.getByRole('button',{name:'完成',exact:true}).click();
 await page.getByRole('button',{name:'书内搜索',exact:true}).click();
 await page.getByPlaceholder('搜索原文文字…').fill('SECOND PAGE');
 await page.getByRole('button',{name:'搜索',exact:true}).click();
 await expect(page.locator('.search-results button').filter({hasText:'SECOND PAGE'})).toBeVisible();
 await page.locator('.search-results button').filter({hasText:'SECOND PAGE'}).click();
 await expect(page.locator('.page-controls input')).toHaveValue('2');
 // Clean only these generated annotations, in the test-only API instance.
 const highlights=(await (await page.request.get(`/api/documents/${book.id}/highlights`)).json()).highlights;
 for(const h of highlights) await page.request.delete(`/api/documents/${book.id}/highlights/${h.id}`);
});

test('eraser drag from blank space cuts sparse pen and marker lines, persists and undoes as one gesture',async({page},info)=>{
 const docs=(await (await page.request.get('/api/documents')).json()).documents;
 const book=docs.find(d=>d.title==='E2E Native'),endpoint=`/api/documents/${book.id}/highlights`;
 const list=async()=> (await (await page.request.get(endpoint)).json()).highlights;
 try {
  for(const [index,y] of [.32,.46].entries()){
   const response=await page.request.post(endpoint,{data:{page_number:1,text:'sparse ink',rects:[{x:.2,y,width:.004,height:.004},{x:.8,y,width:.004,height:.004}],color:'red',comment:'keep metadata',tags:['__ink__',index?'marker':'pen']}});
   expect(response.ok()).toBeTruthy();
  }
  const response=await page.request.post(endpoint,{data:{page_number:1,text:'text highlight',rects:[{x:.45,y:.4,width:.1,height:.02}],color:'yellow',comment:'keep text',tags:[]}});
  expect(response.ok()).toBeTruthy();
  await openBook(page,'E2E Native');
  await expect(page.getByRole('button',{name:'文字层已就绪'})).toBeVisible();
  await page.getByTitle('在 PDF 上绘制标注').click();
  await page.getByRole('button',{name:'橡皮擦',exact:true}).click();
  const drag=async()=>{
   const box=await page.locator('.annotation-layer').first().boundingBox();
   const x=box.x+box.width*.5,start=box.y+box.height*.24,end=box.y+box.height*.53;
   if(info.project.name==='touch'){
    const client=await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:start,id:1}]});
    await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:end,id:1}]});
    await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await client.detach();
   } else {await page.mouse.move(x,start);await page.mouse.down();await page.mouse.move(x,end);await page.mouse.up();}
  };
  await drag();
  await expect.poll(async()=> (await list()).length).toBe(5);
  const cut=(await list()).filter(h=>h.tags.includes('__ink__'));
  expect(cut).toHaveLength(4);
  expect(cut.every(h=>h.comment==='keep metadata'&&(h.rects.at(-1).x<.49||h.rects[0].x>.51))).toBeTruthy();
  expect((await list()).find(h=>h.text==='text highlight').comment).toBe('keep text');
  if(info.project.name==='mouse')await page.keyboard.press('Control+z');
  else await page.getByRole('button',{name:'撤销 Ctrl+Z'}).click();
  await expect.poll(async()=> (await list()).length).toBe(3);
  await expect(page.getByRole('button',{name:'撤销 Ctrl+Z'})).toBeDisabled();
  await drag();
  await expect.poll(async()=> (await list()).length).toBe(5);
  await openBook(page,'E2E Native');
  await expect(page.locator('.annotation-stroke:not(.draft)')).toHaveCount(4);
 } finally {for(const h of await list())await page.request.delete(`${endpoint}/${h.id}`);}
});

test('scanned PDF: real local OCR creates a selectable, searchable text layer and persists it',async({page})=>{
 await openBook(page,'E2E Scan');
 await expect(page.getByRole('button',{name:'OCR 文字可选'})).toBeVisible({timeout:90000});
 await expect(page.locator('.textLayer')).toContainText('SCANNED');
 await page.getByRole('button',{name:'书内搜索',exact:true}).click();
 await page.getByPlaceholder('搜索原文文字…').fill('SCANNED');
 await page.getByRole('button',{name:'搜索',exact:true}).click();
 await expect(page.locator('.search-results button').filter({hasText:'SCANNED'})).toBeVisible();
 const docs=(await (await page.request.get('/api/documents')).json()).documents;const book=docs.find(d=>d.title==='E2E Scan');
 await expect.poll(async()=>JSON.stringify(await (await page.request.get(`/api/documents/${book.id}/ocr-pages`)).json())).toContain('SCANNED');
 await page.screenshot({path:`.tmp/e2e-results/ocr-${test.info().project.name}.png`});
});
