import {test,expect} from '@playwright/test';

test('saved chats survive reload, naming and switching, with a composer attachment button',async({page},info)=>{
 await page.goto('/');await page.getByRole('button',{name:'打开教材 E2E Native',exact:true}).click();
 await page.getByRole('button',{name:/继续 PDF/}).click();
 await page.getByRole('button',{name:/AI助读/}).click();
 const dock=page.locator('.original-assistant');
 await expect(dock.getByRole('button',{name:'＋ 新建聊天',exact:true})).toBeEnabled();
 await dock.getByRole('button',{name:'＋ 新建聊天',exact:true}).click();
 const title='命名聊天 '+info.project.name;
 page.once('dialog',dialog=>dialog.accept(title));await dock.getByRole('button',{name:'命名',exact:true}).click();
 await expect(dock.getByLabel('历史聊天').locator('option:checked')).toHaveText(title);
 const chooser=page.waitForEvent('filechooser');await dock.getByRole('button',{name:'添加图片或选择文件'}).click();
 await (await chooser).setFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9X8AAAAASUVORK5CYII=','base64')});
 await expect(dock.getByRole('button',{name:'移除图片1'})).toBeVisible();
 await dock.getByRole('button',{name:'＋ 新建聊天',exact:true}).click();
 await expect(dock.getByRole('button',{name:'移除图片1'})).toHaveCount(0);
 const previous=await dock.getByLabel('历史聊天').locator('option').filter({hasText:title}).getAttribute('value');
 await dock.getByLabel('历史聊天').selectOption(previous);
 await page.reload();
 await page.getByRole('button',{name:'继续学习 →',exact:true}).click();
 await page.getByRole('button',{name:/AI助读/}).click();
 await expect(page.locator('.original-assistant').getByLabel('历史聊天').locator('option').filter({hasText:title})).toHaveCount(1);
});
