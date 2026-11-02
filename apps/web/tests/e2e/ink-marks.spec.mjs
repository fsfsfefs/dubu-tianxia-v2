import {test,expect} from '@playwright/test';

async function open(page){
 await page.goto('/');await page.locator('.library-book').filter({hasText:'E2E Native'}).getByRole('button',{name:/打开教材/}).click();
 await page.getByRole('button',{name:/继续 PDF/}).click();await expect(page.locator('.continuous-page canvas').first()).toBeVisible();
 await page.getByLabel('PDF页码').fill('1');await page.getByLabel('PDF页码').press('Enter');
}
async function draw(page,touch,x,y){
 if(touch){const session=await page.context().newCDPSession(page);await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+35,y:y+25,id:1}]});await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await session.detach();}
 else{await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+35,y+25,{steps:8});await page.mouse.up();}
}

test('one handwritten region is one named, jumpable mark; toolbar folds without ending drawing',async({page},info)=>{
 const docs=(await(await page.request.get('/api/documents')).json()).documents,book=docs.find(d=>d.title==='E2E Native');
 const endpoint=`/api/documents/${book.id}/highlights`;
 for(const row of (await(await page.request.get(endpoint)).json()).highlights)await page.request.delete(endpoint+'/'+row.id);
 await open(page);await page.getByTitle('在 PDF 上绘制标注',{exact:true}).click();
 const layer=page.getByLabel('PDF 第 1 页右侧留白标注',{exact:true}),bounds=await layer.boundingBox();const x=bounds.x+30,y=bounds.y+190;
 await draw(page,info.project.name==='touch',x,y);await expect(layer.locator('.annotation-stroke:not(.draft)')).toHaveCount(1);
 await draw(page,info.project.name==='touch',x+10,y+10);await expect(layer.locator('.annotation-stroke:not(.draft)')).toHaveCount(2);
 await expect(page.getByTitle('在 PDF 上绘制标注').locator('sup')).toHaveText('1');
 await page.getByRole('button',{name:'标记列表',exact:true}).click();
 const panel=page.getByRole('complementary',{name:'手写标记管理'});
 await expect(panel.locator('article')).toHaveCount(1);await expect(panel.locator('article small')).toContainText('2 笔');
 await panel.getByRole('button',{name:'命名',exact:true}).click();await panel.getByLabel('标记名称').fill('我的推导');await panel.getByRole('button',{name:'保存名称'}).click();
 await expect(panel.getByText('我的推导',{exact:true})).toBeVisible();await panel.getByRole('button',{name:'关闭标记列表'}).click();
 await page.getByRole('button',{name:'收起功能栏',exact:true}).click();
 await expect(page.locator('.reader-tools')).toBeHidden();await expect(page.getByRole('button',{name:'画笔',exact:true})).toHaveCount(0);
 const collapsedBounds=await layer.boundingBox();
 await draw(page,info.project.name==='touch',collapsedBounds.x+50,collapsedBounds.y+210);await expect(layer.locator('.annotation-stroke:not(.draft)')).toHaveCount(3);
 await page.getByRole('button',{name:'展开功能栏',exact:true}).click();
 await expect(page.getByTitle('在 PDF 上绘制标注').locator('sup')).toHaveText('1');
 const expandedBounds=await layer.boundingBox();
 await draw(page,info.project.name==='touch',expandedBounds.x+50,expandedBounds.y+210);await expect(layer.locator('.annotation-stroke:not(.draft)')).toHaveCount(4);
 await expect(page.getByTitle('在 PDF 上绘制标注').locator('sup')).toHaveText('1');
 await page.getByRole('button',{name:'完成',exact:true}).click();
 await page.getByLabel('PDF页码').fill('2');await page.getByLabel('PDF页码').press('Enter');
 await page.getByTitle('管理手写标记',{exact:true}).click();
 await panel.locator('article').filter({hasText:'我的推导'}).getByRole('button',{name:'跳转PDF第1页'}).click();
 await expect(page.getByLabel('PDF页码')).toHaveValue('1');
 await open(page);await page.getByTitle('管理手写标记',{exact:true}).click();await expect(panel.getByText('我的推导',{exact:true})).toBeVisible();
 await page.screenshot({path:'.tmp/named-ink-marks.png'});await panel.getByRole('button',{name:'关闭标记列表'}).click();
 await page.getByRole('button',{name:'收起功能栏',exact:true}).click();await open(page);
 await expect(page.getByRole('button',{name:'展开功能栏',exact:true})).toBeVisible();
 await page.setViewportSize({width:640,height:1000});await page.screenshot({path:'.tmp/collapsed-reader-toolbar.png'});
 await page.getByRole('button',{name:'展开功能栏',exact:true}).click();
 for(const row of (await(await page.request.get(endpoint)).json()).highlights)await page.request.delete(endpoint+'/'+row.id);
});
