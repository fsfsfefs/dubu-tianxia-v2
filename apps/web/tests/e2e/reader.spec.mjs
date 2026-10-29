import {test,expect} from '@playwright/test';

async function openBook(page,title){
 await page.goto('/');
 await page.locator('.library-book').filter({hasText:title}).getByRole('button',{name:/打开教材/}).click();
 await page.getByRole('button',{name:/继续 PDF/}).click();
 await expect(page.locator('.continuous-page canvas').first()).toBeVisible();
}
async function stroke(page,project){
 const layer=page.locator('.annotation-layer').first();await expect(layer).toBeVisible();
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
 // Erase through an actual hit-tested SVG target, then restore it with the undo control.
 const target=page.locator('.annotation-eraser-target').first();const box=await target.boundingBox();
 if(info.project.name==='touch')await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);
 else await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
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
