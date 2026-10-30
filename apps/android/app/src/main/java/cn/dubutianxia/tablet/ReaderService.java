package cn.dubutianxia.tablet;

import android.app.*;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.*;
import com.chaquo.python.Python;
import java.io.*;
import java.util.concurrent.Executors;
import java.util.zip.*;

/** Owns the on-device Python server across Activity recreation/backgrounding. */
public final class ReaderService extends Service {
    public static final String STOP = "cn.dubutianxia.tablet.STOP";
    public volatile String url, error;
    private final Binder binder = new LocalBinder();
    public final class LocalBinder extends Binder { public ReaderService service() { return ReaderService.this; } }
    @Override public IBinder onBind(Intent intent) { return binder; }
    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("local-learning", "本机学习任务", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, "local-learning").setSmallIcon(cn.dubutianxia.tablet.R.drawable.app_icon)
            .setContentTitle("读步天下 · 本地学习服务").setContentText("教材和任务在平板本地运行，点击返回应用").setContentIntent(open)
            .addAction(new Notification.Action.Builder(null, "停止服务", stop).build()).setOngoing(true).build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE); else startForeground(1, notification);
        java.util.concurrent.ExecutorService startup=Executors.newSingleThreadExecutor();
        startup.submit(() -> {
            try {
                File resources = unpack();
                File data = new File(getFilesDir(), "study");
                url = Python.getInstance().getModule("reader_next_api.android_backend").callAttr("start", data.getAbsolutePath(), resources.getAbsolutePath(), new SecretVault(this)).toString();
            } catch (Exception exception) { error = "本地服务启动失败，请保留应用数据。"; android.util.Log.e("DubuStartup", "Startup failure", exception); }
            finally { startup.shutdown(); }
        });
    }
    private File unpack() throws IOException {
        File root = new File(getNoBackupFilesDir(), "resources-20001");
        File marker = new File(root, ".ready");
        if (marker.isFile()) return root;
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Cannot prepare resources");
        String prefix = root.getCanonicalPath() + File.separator;
        try (ZipInputStream zip = new ZipInputStream(getAssets().open("offline.zip"))) {
            ZipEntry entry; byte[] buffer = new byte[65536];
            while ((entry = zip.getNextEntry()) != null) {
                File output = new File(root, entry.getName());
                if (!output.getCanonicalPath().startsWith(prefix)) throw new IOException("Invalid asset path");
                if (entry.isDirectory()) { output.mkdirs(); continue; }
                output.getParentFile().mkdirs();
                try (FileOutputStream stream = new FileOutputStream(output)) { int n; while ((n = zip.read(buffer)) != -1) stream.write(buffer, 0, n); }
            }
        }
        if (!marker.createNewFile()) throw new IOException("Cannot finish resources");
        return root;
    }
    @Override public int onStartCommand(Intent intent, int flags, int id) {
        if (intent != null && STOP.equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        return START_NOT_STICKY;
    }
    @Override public void onDestroy() {
        url = null;
        new Thread(() -> { try { Python.getInstance().getModule("reader_next_api.android_backend").callAttr("stop"); } catch (Exception ignored) {} }, "dubu-shutdown").start();
        super.onDestroy();
    }
}
