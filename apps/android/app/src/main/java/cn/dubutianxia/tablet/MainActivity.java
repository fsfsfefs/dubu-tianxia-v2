package cn.dubutianxia.tablet;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.util.Base64;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private WebView web;
    private TextView status;
    private ReaderService service;
    private boolean bound, loaded;
    private final Handler main = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> chooser;
    private Export pendingExport;
    private final Map<String, Export> exports = new ConcurrentHashMap<>();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private static final int OPEN = 101, SAVE = 102;
    private static final long EXPORT_LIMIT = 512L * 1024 * 1024;
    private static final class Export {
        File file; String name, mime; long bytes; boolean complete;
        Export(File file, String name, String mime) { this.file=file; this.name=name; this.mime=mime; }
    }
    private final ServiceConnection connection = new ServiceConnection() {
        public void onServiceConnected(ComponentName name, IBinder binder) { service=((ReaderService.LocalBinder)binder).service(); poll(); }
        public void onServiceDisconnected(ComponentName name) { service=null; loaded=false; status.setText("本机服务已停止，请退出后重新打开应用。"); status.setVisibility(View.VISIBLE); web.setVisibility(View.GONE); }
    };
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (ReaderService.STOP.equals(getIntent().getAction())) { stopService(new Intent(this,ReaderService.class)); finishAndRemoveTask(); return; }
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        FrameLayout root = new FrameLayout(this); root.setBackgroundColor(Color.rgb(247,246,239)); root.setFitsSystemWindows(true);
        status = new TextView(this); status.setText("读步天下\n正在准备平板本地学习环境…\n首次启动需要解压离线 OCR 资源"); status.setTextSize(20); status.setGravity(Gravity.CENTER); status.setTextColor(Color.rgb(61,98,80));
        web = new WebView(this); web.setVisibility(View.GONE);
        root.addView(web, new FrameLayout.LayoutParams(-1,-1)); root.addView(status, new FrameLayout.LayoutParams(-1,-1)); setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) root.setOnApplyWindowInsetsListener((view,insets)-> {
            android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left,bars.top,bars.right,bars.bottom); return insets;
        });
        WebSettings settings=web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString()+" DubuTablet/1");
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(true); settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false); settings.setTextZoom(100); settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.addJavascriptInterface(new ExportBridge(), "DubuAndroidExport");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url=request.getUrl().toString(); if (local(url)) return false;
                if (request.isForMainFrame() && request.hasGesture() && (url.startsWith("https://") || url.startsWith("http://"))) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); } catch (ActivityNotFoundException ignored) {}
                }
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String scheme=request.getUrl().getScheme();
                if (("http".equals(scheme) || "https".equals(scheme) || "file".equals(scheme) || "content".equals(scheme)) && !local(request.getUrl().toString()))
                    return new WebResourceResponse("text/plain","UTF-8",403,"Blocked",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));
                return null;
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!local(url)) return;
                web.evaluateJavascript(EXPORT_SCRIPT, null);
                status.setVisibility(View.GONE); web.setVisibility(View.VISIBLE);
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                status.setText("阅读界面被系统回收，请退出后重新打开；学习数据仍保留在本机。"); status.setVisibility(View.VISIBLE); view.setVisibility(View.GONE); view.destroy(); return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsAlert(WebView view,String url,String message,JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("确定",(d,w)->result.confirm()).setOnCancelListener(d->result.cancel()).show(); return true;
            }
            @Override public boolean onJsConfirm(WebView view,String url,String message,JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("确定",(d,w)->result.confirm()).setNegativeButton("取消",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show(); return true;
            }
            @Override public boolean onJsPrompt(WebView view,String url,String message,String value,JsPromptResult result) {
                EditText input=new EditText(MainActivity.this); input.setText(value);
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setView(input).setPositiveButton("确定",(d,w)->result.confirm(input.getText().toString())).setNegativeButton("取消",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show(); return true;
            }
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params) {
                if (chooser != null) chooser.onReceiveValue(null);
                chooser=callback;
                Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                String[] accepted=Arrays.stream(params.getAcceptTypes()).filter(s->s.contains("/")).toArray(String[]::new);
                if (accepted.length>0) intent.putExtra(Intent.EXTRA_MIME_TYPES,accepted);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,params.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(intent,OPEN); } catch (ActivityNotFoundException error) { chooser.onReceiveValue(null); chooser=null; }
                return true;
            }
        });
        if (Build.VERSION.SDK_INT>=33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS")!=PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"},103);
        Intent intent=new Intent(this,ReaderService.class); startForegroundService(intent); bound=bindService(intent,connection,BIND_AUTO_CREATE);
    }
    private boolean local(String value) {
        Uri uri=Uri.parse(value); return "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) && uri.getPort()==18894;
    }
    private void poll() {
        if (isFinishing() || isDestroyed() || service==null) return;
        if (service.error!=null) { status.setText(service.error); return; }
        if (service.url!=null && !loaded) { loaded=true; web.loadUrl(service.url); return; }
        if (!loaded) main.postDelayed(this::poll,150);
    }
    @Override public void onBackPressed() {
        web.evaluateJavascript("(()=>{const d=document.querySelector('dialog[open]');if(d){d.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;}const b=document.querySelector('button[aria-label=\"返回前一个页面\"]');if(b&&!b.disabled){b.click();return true;}return false;})()", value->{if(!"true".equals(value))moveTaskToBack(true);});
    }
    public WebView webViewForTest() { return web; }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if(ReaderService.STOP.equals(intent.getAction())) { stopService(new Intent(this,ReaderService.class)); finishAndRemoveTask(); }
    }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if(request==OPEN && chooser!=null) { chooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result,data)); chooser=null; }
        if(request==SAVE && pendingExport!=null) {
            Export item=pendingExport; pendingExport=null;
            if(result==RESULT_OK && data!=null && data.getData()!=null) {
                Uri uri=data.getData(); io.submit(()->{
                    try(InputStream input=new FileInputStream(item.file); OutputStream output=getContentResolver().openOutputStream(uri,"w")) {
                        if(output==null)throw new IOException("Cannot open selected document");
                        byte[] bytes=new byte[65536]; int n; while((n=input.read(bytes))!=-1)output.write(bytes,0,n);
                        main.post(()->Toast.makeText(this,"导出已保存",Toast.LENGTH_LONG).show());
                    }catch(IOException error){main.post(()->Toast.makeText(this,"导出保存失败，请重试",Toast.LENGTH_LONG).show());}
                    finally{item.file.delete();exports.values().remove(item);}
                });
            }else{item.file.delete();exports.values().remove(item);}
        }
    }
    @Override protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if(chooser!=null)chooser.onReceiveValue(null);
        if(bound)unbindService(connection);
        if(web!=null){web.removeJavascriptInterface("DubuAndroidExport"); web.destroy();} io.shutdown(); super.onDestroy();
    }
    public final class ExportBridge {
        @JavascriptInterface public synchronized String beginExport(String name,String mime) throws IOException {
            if(!exports.isEmpty())throw new IOException("请先完成或取消上一次导出");
            String id=UUID.randomUUID().toString();
            String safe=name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]","_"); if(safe.length()>120)safe=safe.substring(safe.length()-120);
            File file=new File(getCacheDir(),"export-"+id); if(!file.createNewFile())throw new IOException("Cannot prepare export");
            exports.put(id,new Export(file,safe,mime)); return id;
        }
        @JavascriptInterface public synchronized void appendExport(String id,String encoded) throws IOException {
            Export item=exports.get(id); if(item==null||item.complete||encoded.length()>100000)throw new IOException("Invalid export chunk");
            byte[] bytes=Base64.decode(encoded,Base64.DEFAULT); if(item.bytes+bytes.length>EXPORT_LIMIT)throw new IOException("安卓导出上限为512MB");
            try(FileOutputStream stream=new FileOutputStream(item.file,true)){stream.write(bytes);} item.bytes+=bytes.length;
        }
        @JavascriptInterface public synchronized void cancelExport(String id) { Export item=exports.remove(id);if(item!=null)item.file.delete(); }
        @JavascriptInterface public synchronized void finishExport(String id) throws IOException {
            Export item=exports.get(id);if(item==null||item.complete)throw new IOException("Invalid export"); item.complete=true;
            main.post(()->{
                pendingExport=item;
                Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(item.mime==null||item.mime.isEmpty()?"application/octet-stream":item.mime).putExtra(Intent.EXTRA_TITLE,item.name);
                try{startActivityForResult(intent,SAVE);}catch(ActivityNotFoundException error){pendingExport=null;cancelExport(id);Toast.makeText(MainActivity.this,"未找到系统文件保存器",Toast.LENGTH_LONG).show();}
            });
        }
    }
    private static final String EXPORT_SCRIPT="""
        (()=>{document.documentElement.dataset.platform='android';if(window.__dubuExport)return;window.__dubuExport=true;
        document.addEventListener('click',async event=>{const a=event.target.closest?.('a[download]');if(!a||!a.href.startsWith('blob:'))return;
        event.preventDefault();let id;try{const blob=await(await fetch(a.href)).blob();if(blob.size>512*1024*1024)throw Error('安卓导出上限为512MB，请减少模型文件或分次导出');
        const api=window.DubuAndroidExport;id=api.beginExport(a.download||'读步天下导出',blob.type);
        for(let n=0;n<blob.size;n+=65536){const bytes=new Uint8Array(await blob.slice(n,n+65536).arrayBuffer());let text='';for(const byte of bytes)text+=String.fromCharCode(byte);api.appendExport(id,btoa(text));}
        api.finishExport(id);}catch(error){if(id)window.DubuAndroidExport.cancelExport(id);alert('导出失败：'+error.message);}},true);})();
        """;
}
