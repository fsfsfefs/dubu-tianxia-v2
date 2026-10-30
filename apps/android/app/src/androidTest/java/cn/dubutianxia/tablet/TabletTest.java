package cn.dubutianxia.tablet;

import android.Manifest;
import android.content.pm.ActivityInfo;
import androidx.test.rule.ActivityTestRule;
import androidx.test.rule.GrantPermissionRule;
import androidx.test.platform.app.InstrumentationRegistry;
import com.chaquo.python.Python;
import org.junit.*;
import org.junit.rules.RuleChain;
import java.util.concurrent.*;
import static org.junit.Assert.*;

public class TabletTest {
    private final ActivityTestRule<MainActivity> activity=new ActivityTestRule<>(MainActivity.class);
    @Rule public RuleChain rules=RuleChain.outerRule(GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)).around(activity);
    private String evaluate(String script) throws Exception {
        CountDownLatch done=new CountDownLatch(1); String[] value={null};
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->activity.getActivity().webViewForTest().evaluateJavascript(script,result->{value[0]=result;done.countDown();}));
        assertTrue(done.await(15,TimeUnit.SECONDS));return value[0];
    }
    private void ready() throws Exception {
        long deadline=System.currentTimeMillis()+90000;
        while(System.currentTimeMillis()<deadline){if("true".equals(evaluate("document.body.innerText.includes('打开使用指南')")))return;Thread.sleep(300);}
        fail("Offline native UI did not load");
    }
    private void awaitJs(String script,long timeout) throws Exception {
        long deadline=System.currentTimeMillis()+timeout;
        while(System.currentTimeMillis()<deadline){if("true".equals(evaluate(script)))return;Thread.sleep(250);}
        fail("Native WebView condition timed out: "+script+"; page="+evaluate("JSON.stringify({text:document.body.innerText.slice(0,2000),errors:window.__tabletErrors,ua:navigator.userAgent})"));
    }
    @Test public void nativePdfAndRealOfflineOcr() throws Exception {
        ready();
        for(boolean scanned:new boolean[]{false,true}) {
            android.graphics.pdf.PdfDocument pdf=new android.graphics.pdf.PdfDocument();
            android.graphics.pdf.PdfDocument.Page page=pdf.startPage(new android.graphics.pdf.PdfDocument.PageInfo.Builder(600,800,1).create());
            android.graphics.Paint paint=new android.graphics.Paint();paint.setColor(android.graphics.Color.BLACK);paint.setTextSize(36);
            if(scanned){
                android.graphics.Bitmap bitmap=android.graphics.Bitmap.createBitmap(1200,1600,android.graphics.Bitmap.Config.ARGB_8888);
                android.graphics.Canvas canvas=new android.graphics.Canvas(bitmap);canvas.drawColor(android.graphics.Color.WHITE);paint.setTextSize(72);canvas.drawText("SCANNED TABLET TEST",80,200,paint);
                page.getCanvas().drawBitmap(bitmap,null,new android.graphics.Rect(0,0,600,800),null);
            }else{page.getCanvas().drawText("NATIVE TABLET TEST",40,100,paint);}
            pdf.finishPage(page);java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();pdf.writeTo(bytes);pdf.close();
            String name=scanned?"Android Scan Fixture":"Android Text Fixture";
            java.net.HttpURLConnection request=(java.net.HttpURLConnection)new java.net.URL("http://127.0.0.1:18894/api/documents").openConnection();
            request.setRequestMethod("POST");request.setDoOutput(true);request.setRequestProperty("Cookie",android.webkit.CookieManager.getInstance().getCookie("http://127.0.0.1:18894"));request.setRequestProperty("Content-Type","multipart/form-data; boundary=TabletFixtureBoundary");
            try(java.io.OutputStream out=request.getOutputStream()){
                out.write(("--TabletFixtureBoundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\""+name+".pdf\"\r\nContent-Type: application/pdf\r\n\r\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));out.write(bytes.toByteArray());out.write("\r\n--TabletFixtureBoundary--\r\n".getBytes());
            }
            assertEquals(201,request.getResponseCode());request.disconnect();
            evaluate("window.__tabletReloadStamp=1;location.reload()");
            awaitJs("!window.__tabletReloadStamp && document.readyState==='complete' && document.body.innerText.includes('打开使用指南')",30000);
            evaluate("window.__tabletErrors=[];new MutationObserver(()=>{document.querySelectorAll('.error').forEach(e=>{if(e.innerText&&!window.__tabletErrors.includes(e.innerText))window.__tabletErrors.push(e.innerText);});}).observe(document.body,{subtree:true,childList:true,characterData:true});addEventListener('error',e=>window.__tabletErrors.push(e.message+e.error?.stack));addEventListener('unhandledrejection',e=>window.__tabletErrors.push(String(e.reason)+e.reason?.stack));");
            evaluate("Array.from(document.querySelectorAll('.library-book')).find(e=>e.innerText.includes('"+name+"')).querySelector('button[aria-label^=\"打开教材\"]').click()");
            awaitJs("Array.from(document.querySelectorAll('button')).some(b=>b.innerText.includes('继续 PDF'))",30000);
            evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.innerText.includes('继续 PDF')).click()");
            awaitJs("Boolean(document.querySelector('.continuous-page canvas')?.width)",30000);
            awaitJs(scanned?"document.body.innerText.includes('OCR 文字可选')":"document.body.innerText.includes('文字层已就绪')",90000);
            awaitJs("Boolean(document.querySelector('.textLayer')?.innerText.includes('TABLET'))",10000);
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
            awaitJs("!document.querySelector('.reader-shell') && document.body.innerText.includes('学习空间')",10000);
            evaluate("window.__tabletReloadStamp=1;location.reload()");
            awaitJs("!window.__tabletReloadStamp && document.readyState==='complete' && document.body.innerText.includes('打开使用指南')",30000);
        }
    }
    @Test public void offlineBackendAndOcrResources() throws Exception {
        ready(); String report=Python.getInstance().getModule("reader_next_api.android_backend").callAttr("probe").toString();
        assertTrue(report,report.contains("\"builtin_retrieval\": true"));assertTrue(report,report.contains("traineddata.gz\": 200"));
        assertEquals("true",evaluate("document.documentElement.dataset.platform==='android'"));
    }
    @Test public void keystoreEncryptsSecrets() throws Exception {
        SecretVault vault=new SecretVault(activity.getActivity());String id="instrumentation-only",value="fixture-not-an-api-key";
        try{vault.set(id,value);assertEquals(value,vault.get(id));assertFalse(activity.getActivity().getSharedPreferences("secret-vault",0).getString(id,"").contains(value));}
        finally{vault.delete(id);}assertNull(vault.get(id));
    }
    @Test public void tabletRotationAndGuide() throws Exception {
        ready();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->activity.getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));Thread.sleep(1200);
        assertEquals("true",evaluate("document.documentElement.scrollWidth<=innerWidth+1"));
        evaluate("document.querySelector('.guide-open').click()");Thread.sleep(1200);
        assertEquals("true",evaluate("Boolean(document.querySelector('dialog[open]'))"));
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->activity.getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));Thread.sleep(1200);
        assertEquals("true",evaluate("document.documentElement.scrollWidth<=innerWidth+1 && Boolean(document.querySelector('dialog[open]'))"));
        android.graphics.Bitmap image=InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(activity.getActivity().getExternalFilesDir(null),"tablet-guide.png"))){image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,out);}
    }
}
