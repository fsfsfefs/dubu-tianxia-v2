import {test,expect} from '@playwright/test';

for(const width of [390,1440])test(`folder menus stay visible and rename/delete works at ${width}px`,async({page},info)=>{
 const prefix=`Folders ${info.project.name} ${width} ${Date.now().toString(36)}`;
 const activate=locator=>info.project.name==='touch'?locator.tap():locator.click();
 const ids=[];
 try{
  for(let i=0;i<7;i++){
   const response=await page.request.post('/api/folders',{data:{name:`${prefix} 分类 ${i} 长名称测试`}});
   expect(response.ok()).toBeTruthy();ids.push((await response.json()).folder.id);
  }
  await page.setViewportSize({width,height:900});await page.goto('/');
  const original=`${prefix} 分类 0 长名称测试`,renamed=`${prefix} 已重命名`;
  const trigger=page.getByRole('button',{name:original+' 文件夹设置',exact:true});
  await trigger.scrollIntoViewIfNeeded();await activate(trigger);
  const menu=page.getByRole('menu',{name:original+' 文件夹操作'});
  await expect(menu).toBeVisible();
  const box=await menu.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
  expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(900);
  for(const name of ['重命名','删除文件夹']){
   const item=menu.getByRole('menuitem',{name,exact:true});
   expect(await item.evaluate(node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
  }
  await page.screenshot({path:`.tmp/folder-menu-${info.project.name}-${width}.png`});
  page.once('dialog',dialog=>dialog.accept(renamed));await activate(menu.getByRole('menuitem',{name:'重命名',exact:true}));
  const updated=page.getByRole('button',{name:renamed+' 文件夹设置',exact:true});await expect(updated).toBeVisible();
  await activate(updated);await expect(page.getByRole('menu')).toContainText('教材回到未分类');
  page.once('dialog',async dialog=>{expect(dialog.message()).toContain('不会被删除');await dialog.accept();});
  await activate(page.getByRole('menuitem',{name:'删除文件夹',exact:true}));
  await expect(updated).toHaveCount(0);await expect(page.getByRole('menu')).toHaveCount(0);
 }finally{for(const id of ids)await page.request.delete(`/api/folders/${id}`);}
});
