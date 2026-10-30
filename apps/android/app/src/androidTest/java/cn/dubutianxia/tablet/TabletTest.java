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
