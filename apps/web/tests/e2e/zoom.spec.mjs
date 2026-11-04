import {test,expect} from '@playwright/test';
async function open(page){
 await page.goto('/');await page.locator('.library-book').filter({hasText:'E2E Native'}).getByRole('button',{name:/打开教材/}).click();
 await page.getByRole('button',{name:/继续 PDF/}).click();await expect(page.locator('.textLayer').first()).toContainText('NATIVE');
 await page.locator('.reader-more > summary').click();await page.getByRole('button',{name:'适应宽度',exact:true}).click();await page.locator('.reader-more > summary').click();
 await expect(page.locator('.pdf-reader')).toHaveAttribute('data-zoom','1.000');
 await page.getByLabel('PDF页码').fill('1');await page.getByLabel('PDF页码').press('Enter');
}
const value=page=>page.locator('.pdf-reader').getAttribute('data-zoom').then(Number);
async function pinch(session,x,y,start,end){
 await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-start,y,id:1},{x:x+start,y,id:2}]});
 for(let step=1;step<=6;step++){
  const distance=start+(end-start)*step/6;
  await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-distance,y,id:1},{x:x+distance,y,id:2}]});
 }
 await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
}

test('wheel zoom preserves reading, anchor and browser scale, clamps limits and offers direct wheel mode',async({page})=>{
 await open(page);const root=page.locator('.pdf-scroll'),paper=page.locator('[data-page-number="1"]');
 const box=await root.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+300);
 await page.mouse.wheel(0,150);await expect.poll(()=>root.evaluate(el=>el.scrollTop)).toBeGreaterThan(80);expect(await value(page)).toBe(1);
 await page.getByLabel('PDF页码').press('Enter');
 const before=await paper.boundingBox(),point={x:before.x+before.width/2,y:before.y+300},fraction=300/before.height;
 await page.mouse.move(point.x,point.y);await page.keyboard.down('Control');await page.mouse.wheel(0,-220);await page.keyboard.up('Control');
 await expect.poll(()=>value(page)).toBeGreaterThan(1.4);
 await expect.poll(async()=>{const after=await paper.boundingBox();return Math.abs(after.y+after.height*fraction-point.y);}).toBeLessThan(5);
 expect(await page.evaluate(()=>window.visualViewport.scale)).toBe(1);
 await page.locator('.reader-more > summary').click();await page.getByLabel('滚轮直接缩放',{exact:true}).check();await page.locator('.reader-more > summary').click();
 const previous=await value(page);await page.mouse.move(point.x,point.y);await page.mouse.wheel(0,120);await expect.poll(()=>value(page)).toBeLessThan(previous);
 await page.mouse.wheel(0,-10000);await page.mouse.wheel(0,-10000);await expect(page.locator('.pdf-reader')).toHaveAttribute('data-zoom','3.000');
 await root.evaluate(el=>el.scrollLeft=0);expect((await paper.boundingBox()).x).toBeGreaterThanOrEqual((await root.boundingBox()).x);
 expect(await root.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
 for(let index=0;index<5;index++)await page.mouse.wheel(0,10000);
 await expect(page.locator('.pdf-reader')).toHaveAttribute('data-zoom','0.500');
 await expect(page.locator('.pdf-status.error')).toHaveCount(0);
 expect(await page.evaluate(()=>localStorage.getItem('reader-next-wheel-zoom'))).toBe('true');
 await page.locator('.reader-more > summary').click();await page.getByRole('button',{name:'适应宽度',exact:true}).click();await page.locator('.reader-more > summary').click();
 await expect(page.locator('.pdf-reader')).toHaveAttribute('data-zoom','1.000');
 await page.getByLabel('PDF页码').fill('2');await page.getByLabel('PDF页码').press('Enter');
 const last=page.locator('[data-page-number="2"]'),lastBefore=await last.boundingBox(),lastPoint={x:lastBefore.x+lastBefore.width/2,y:lastBefore.y+300},lastFraction=300/lastBefore.height;
 await page.mouse.move(lastPoint.x,lastPoint.y);await page.mouse.wheel(0,700);
 await expect(page.locator('.pdf-reader')).toHaveAttribute('data-zoom','0.500');
 await expect.poll(async()=>{const after=await last.boundingBox();return Math.abs(after.y+after.height*lastFraction-lastPoint.y);}).toBeLessThan(5);
 const docs=(await(await page.request.get('/api/documents')).json()).documents,book=docs.find(item=>item.title==='E2E Native');
 await expect.poll(async()=>(await(await page.request.get(`/api/documents/${book.id}/position`)).json()).position.zoom).toBe(.5);
 await page.locator('.reader-more > summary').click();await page.getByRole('button',{name:'适应宽度',exact:true}).click();await page.locator('.reader-more > summary').click();
 await expect.poll(async()=>(await(await page.request.get(`/api/documents/${book.id}/position`)).json()).position.zoom).toBe(1);
});

test('touch pinch and one-finger pan work with pen-only mode and cancel unfinished touch ink',async({page},info)=>{
 test.skip(info.project.name!=='touch','Requires the touch-capable browser project');
 await page.setViewportSize({width:900,height:1000});await open(page);
 const docs=(await(await page.request.get('/api/documents')).json()).documents,book=docs.find(item=>item.title==='E2E Native');
 const list=async()=>(await(await page.request.get(`/api/documents/${book.id}/highlights`)).json()).highlights;
 const initial=(await list()).length,session=await page.context().newCDPSession(page);
 await page.getByTitle('在 PDF 上绘制标注',{exact:true}).click();
 const paper=page.locator('[data-page-number="1"]'),before=await paper.boundingBox();
 const x=before.x+before.width/2,y=before.y+300,fraction=300/before.height;
 await pinch(session,x,y,65,115);await expect.poll(()=>value(page)).toBeGreaterThan(1.6);
 await expect.poll(async()=>{const after=await paper.boundingBox();return Math.abs(after.y+after.height*fraction-y);}).toBeLessThan(5);
 expect((await list()).length).toBe(initial);
 await page.getByLabel('仅手写笔',{exact:true}).check();
 const root=page.locator('.pdf-scroll'),scroll=await root.evaluate(el=>({x:el.scrollLeft,y:el.scrollTop}));
 await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:450,y:500,id:1}]});
 await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:380,y:380,id:1}]});await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await expect.poll(()=>root.evaluate(el=>el.scrollTop)).toBeGreaterThan(scroll.y+80);
 expect(await root.evaluate(el=>el.scrollLeft)).toBeGreaterThan(scroll.x+20);
 const oldZoom=await value(page);await pinch(session,450,500,100,70);await expect.poll(()=>value(page)).toBeLessThan(oldZoom);
 expect((await list()).length).toBe(initial);
 await expect(page.locator('.pdf-status.error')).toHaveCount(0);expect(await page.evaluate(()=>window.visualViewport.scale)).toBe(1);
 const penZoom=await value(page),penBox=await paper.boundingBox(),penX=penBox.x+penBox.width*.3,penY=400;
 await page.getByRole('button',{name:'收起手写面板',exact:true}).click();
 await expect(page.getByLabel('PDF 标注工具',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'结束标注',exact:true})).toBeVisible();
 await session.send('Input.dispatchMouseEvent',{type:'mousePressed',x:penX,y:penY,button:'left',buttons:1,pointerType:'pen',force:.6,clickCount:1});
 await pinch(session,450,500,70,100);
 expect(await value(page)).toBe(penZoom);
 await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:penX+50,y:penY+20,button:'left',buttons:1,pointerType:'pen',force:.6});
 await session.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:penX+50,y:penY+20,button:'left',buttons:0,pointerType:'pen',force:0,clickCount:1});
 await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:penX+50,y:penY+20,button:'none',buttons:0,pointerType:'pen',force:0});
 await pinch(session,450,500,70,100);
 await expect.poll(()=>value(page)).toBeGreaterThan(penZoom);
 await expect.poll(async()=>(await list()).length).toBe(initial+1);
 await page.screenshot({path:'.tmp/touch-pdf-zoom.png'});await session.detach();
 for(const item of await list())await page.request.delete(`/api/documents/${book.id}/highlights/${item.id}`);
});

test('right mouse drag pans the PDF on both axes without leaving ink',async({page},info)=>{
 test.skip(info.project.name!=='mouse','Requires the mouse project');
 await open(page);
 await page.getByTitle('在 PDF 上绘制标注',{exact:true}).click();
 await page.getByRole('button',{name:'收起手写面板',exact:true}).click();
 const root=page.locator('.pdf-scroll');
 await root.evaluate(el=>{el.scrollTop=150;el.scrollLeft=(el.scrollWidth-el.clientWidth)/2;});
 const before=await root.evaluate(el=>({x:el.scrollLeft,y:el.scrollTop}));
 const ink=page.locator('.annotation-stroke');
 const count=await ink.count();
 const box=await root.boundingBox();
 const x=box.x+box.width/2,y=box.y+box.height/2;
 await page.mouse.move(x,y);
 await page.mouse.down({button:'right'});
 await expect(root).toHaveAttribute('data-mouse-panning','true');
 await page.mouse.move(x-95,y-115,{steps:5});
 await page.mouse.up({button:'right'});
 await expect.poll(()=>root.evaluate(el=>el.scrollLeft)).toBeGreaterThan(before.x+80);
 await expect.poll(()=>root.evaluate(el=>el.scrollTop)).toBeGreaterThan(before.y+100);
 await expect(root).not.toHaveAttribute('data-mouse-panning','true');
 await expect(ink).toHaveCount(count);
 await page.getByTitle('在 PDF 上绘制标注',{exact:true}).click();
 await expect(page.getByLabel('PDF 标注工具',{exact:true})).toBeVisible();
});
