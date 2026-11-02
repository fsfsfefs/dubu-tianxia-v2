import {test,expect} from '@playwright/test';

async function open(page){
 await page.goto('/');
 await page.locator('.library-book').filter({hasText:'E2E Native'}).getByRole('button',{name:/打开教材/}).click();
 await page.getByRole('button',{name:/继续 PDF/}).click();
 await expect(page.locator('.continuous-page canvas').first()).toBeVisible();
 await page.getByLabel('PDF页码').fill('1');
 await page.getByLabel('PDF页码').press('Enter');
}

test('image-only pasted sticky note persists, edits and removes attachments',async({page})=>{
 await open(page);
 await page.getByTitle('页边便签', {exact:true}).click();
 const panel=page.getByRole('complementary',{name:'页边便签'});
 const editor=panel.locator('.sticky-note-editor').first();
 await editor.getByRole('textbox',{name:'便签内容'}).evaluate(element=>{
  const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;
  const context=canvas.getContext('2d');context.fillStyle='red';context.fillRect(0,0,8,8);
  const encoded=canvas.toDataURL('image/png').split(',')[1];
  const file=new File([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],'pasted.png',{type:'image/png'});
  const transfer=new DataTransfer();transfer.items.add(file);
  element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
 });
 await expect(editor.getByAltText('待保存便签图片')).toBeVisible();
 await editor.getByRole('button',{name:'添加便签',exact:true}).click();
 await expect(panel.locator('.page-sticky-list img')).toHaveCount(1);
 const docs=(await(await page.request.get('/api/documents')).json()).documents,book=docs.find(d=>d.title==='E2E Native');
 let notes=(await(await page.request.get(`/api/documents/${book.id}/notes`)).json()).notes;
 const saved=notes.find(n=>n.images?.length);expect(saved.content).toBe('');expect((await page.request.get(saved.images[0].url)).ok()).toBe(true);
 await open(page);await page.getByTitle('页边便签',{exact:true}).click();
 const card=panel.locator('.page-sticky-list article').first();
 await expect(card.getByAltText('便签图片')).toBeVisible();
 await card.getByRole('button',{name:'编辑',exact:true}).click();
 await card.getByRole('button',{name:'移除已保存图片'}).click();
 await card.getByRole('textbox',{name:'便签内容'}).fill('已校对的图文便签');
 await card.getByRole('button',{name:'保存便签'}).click();
 await expect(card.getByAltText('便签图片')).toHaveCount(0);
 await expect(card).toContainText('已校对的图文便签');
 expect((await page.request.get(saved.images[0].url)).status()).toBe(404);
 await panel.locator('.page-sticky-list article').filter({hasText:'已校对的图文便签'}).getByRole('button',{name:'删除',exact:true}).click();
});

test('both PDF margins support persistent ink and isolated erase/undo',async({page},info)=>{
 await open(page);
 await page.getByTitle('在 PDF 上绘制标注',{exact:true}).click();
 await page.getByRole('button',{name:'画笔',exact:true}).click();
 for(const name of ['左侧留白','右侧留白']){
  const root=page.locator('.pdf-scroll');await root.evaluate((el,left)=>{el.scrollLeft=left?0:el.scrollWidth-el.clientWidth;},name==='左侧留白');
  const layer=page.getByLabel(`PDF 第 1 页${name}标注`,{exact:true});const box=await layer.boundingBox(),rootBox=await root.boundingBox();
  expect(box.width).toBeGreaterThan(30);
  const x=Math.max(box.x,rootBox.x)+80,y=box.y+220;
  if(info.project.name==='touch'){
   const session=await page.context().newCDPSession(page);
   await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
   await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+120,y:y+50,id:1}]});
   await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await session.detach();
  }else{await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+120,y+50,{steps:8});await page.mouse.up();}
  await expect(layer.locator('.annotation-stroke:not(.draft)')).toHaveCount(1);
 }
 await open(page);
 await expect(page.locator('[data-margin="left"] .annotation-stroke')).toHaveCount(1);
 await expect(page.locator('[data-margin="right"] .annotation-stroke')).toHaveCount(1);
 await page.getByTitle('在 PDF 上绘制标注',{exact:true}).click();await page.getByRole('button',{name:'橡皮擦',exact:true}).click();
 await page.locator('.pdf-scroll').evaluate(el=>{el.scrollLeft=0;});
 const left=page.getByLabel('PDF 第 1 页左侧留白标注',{exact:true}),box=await left.boundingBox();
 if(info.project.name==='touch')await page.touchscreen.tap(box.x+140,box.y+245);
 else await page.mouse.click(box.x+140,box.y+245);
 await expect(page.getByRole('button',{name:'撤销 Ctrl+Z'})).toBeEnabled();
 await page.getByRole('button',{name:'撤销 Ctrl+Z'}).click();
 await expect(left.locator('.annotation-stroke:not(.draft)')).toHaveCount(1);
 await expect(page.locator('[data-margin="right"] .annotation-stroke')).toHaveCount(1);
 await page.getByRole('button',{name:'完成',exact:true}).click();
 await page.screenshot({path:'.tmp/pdf-margin-ink.png'});
 const docs=(await(await page.request.get('/api/documents')).json()).documents,book=docs.find(d=>d.title==='E2E Native');
 for(const item of (await(await page.request.get(`/api/documents/${book.id}/highlights`)).json()).highlights)await page.request.delete(`/api/documents/${book.id}/highlights/${item.id}`);
});

test('PDF main thread and worker load when the browser lacks Map upsert methods',async({page})=>{
 let patchedWorkers=0;
 await page.addInitScript(()=>{delete Map.prototype.getOrInsertComputed;delete Map.prototype.getOrInsert;delete Promise.withResolvers;});
 await page.route(/\/src\/pdfWorker\.ts\?/,async route=>{
  if(!new URL(route.request().url()).searchParams.has('worker_file'))return route.continue();
  patchedWorkers++;
  const response=await route.fetch();await route.fulfill({response,body:'delete Map.prototype.getOrInsertComputed;delete Map.prototype.getOrInsert;delete Promise.withResolvers;\n'+await response.text()});
 });
 await open(page);
 await expect(page.locator('.textLayer').first()).toContainText('NATIVE READER');
 await expect(page.locator('.pdf-status.error')).toHaveCount(0);
 expect(patchedWorkers).toBeGreaterThan(0);
});


test('margin aspect ratio is fixed through zoom and window resizing, with wide horizontal reach',async({page})=>{
 await open(page);
 const margin=page.locator('[data-margin="right"]').first(),root=page.locator('.pdf-scroll');
 const ratio=await margin.evaluate(el=>{const r=el.getBoundingClientRect();return r.width/r.height;});
 await page.setViewportSize({width:1100,height:900});
 expect(await margin.evaluate(el=>{const r=el.getBoundingClientRect();return r.width/r.height;})).toBeCloseTo(ratio,3);
 const box=await root.boundingBox();
 await page.mouse.move(box.x+box.width/2,box.y+200);await page.mouse.wheel(0,-180);
 await root.dispatchEvent('wheel',{deltaY:-200,ctrlKey:true,clientX:box.x+box.width/2,clientY:box.y+200});
 await expect.poll(()=>page.locator('.pdf-reader').getAttribute('data-zoom')).not.toBe('1.000');
 expect(await margin.evaluate(el=>{const r=el.getBoundingClientRect();return r.width/r.height;})).toBeCloseTo(ratio,3);
 await root.evaluate(el=>{el.scrollLeft=el.scrollWidth-el.clientWidth;});
 await expect(margin).toBeInViewport();
 expect(await root.evaluate(el=>el.scrollWidth/el.clientWidth)).toBeGreaterThan(2);
});
