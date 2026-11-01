import {test,expect} from '@playwright/test';
test('image excerpt previews, sends image-only questions and removes attachments',async({page})=>{
 await page.route('**/api/model-profiles',route=>route.fulfill({json:{profiles:[{id:'vision',name:'视觉测试',model:'vision-test',endpoint:'https://example.com/chat/completions',is_default:true,max_tokens:2048}]}}));
 let payload;
 await page.route('**/api/chat/stream',async route=>{
  payload=route.request().postDataJSON();
  await route.fulfill({contentType:'text/event-stream',body:'data: {"type":"delta","text":"图片测试回答"}\n\ndata: {"type":"complete"}\n\n'});
 });
 await page.goto('/');
 await page.locator('.library-book').filter({hasText:'E2E Native'}).getByRole('button',{name:/打开教材/}).click();
 await page.getByRole('button',{name:/继续 PDF/}).click();
 const toggle=page.getByRole('button',{name:'AI助读',exact:true});
 await toggle.click();
 await page.getByRole('button',{name:'当前原文',exact:true}).click();
 const input=page.getByLabel('添加教材或问题图片');
 await expect(input).toBeVisible();
 const buffer=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=','base64');
 await input.setInputFiles({name:'题目.png',mimeType:'image/png',buffer});
 await expect(page.locator('.excerpt-image-list img')).toBeVisible();
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.getByText('图片测试回答',{exact:true})).toBeVisible();
 expect(payload.images).toHaveLength(1);
 expect(payload.images[0]).toMatch(/^data:image\/png;base64,/);
 expect(payload.use_rag).toBe(false);
 await page.getByRole('button',{name:'移除图片1'}).click();
 await expect(page.locator('.excerpt-image-list img')).toHaveCount(0);
});
