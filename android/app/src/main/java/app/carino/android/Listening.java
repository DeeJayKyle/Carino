package app.carino.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * Keeps Carino answering WhatsApp and Telegram while it's in the background. Android only lets an
 * app keep working when it shows an ongoing notification, so this is a foreground service with a
 * quiet one. Every few seconds it nudges the app (__hn.tick) to collect new messages; the work
 * itself happens in the app. If the app is swiped away, messages wait (on the WhatsApp relay, or
 * at Telegram) until Carino is opened again, and the notification says so.
 */
public class Listening extends Service {
    private static final String CHANNEL = "listening";
    private static final int ID = 7001;
    private static final long TICK_MS = 5000;
    private final Handler handler = new Handler(Looper.getMainLooper());
    static volatile boolean running = false;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            MainActivity a = MainActivity.current;
            if (a == null) {
                paused();
                return;
            }
            if (!MainActivity.visible) a.bridge.emit("window.__hn && __hn.tick && __hn.tick()");
            handler.postDelayed(this, TICK_MS);
        }
    };

    static void set(Context ctx, boolean on) {
        Intent i = new Intent(ctx, Listening.class);
        if (on) {
            try {
                ctx.startForegroundService(i);
            } catch (Exception ignored) {
                // Android may refuse while the app is in the background; it's started again when the app opens.
            }
        } else {
            ctx.stopService(i);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = notification(getString(R.string.listening_title), getString(R.string.listening_body), false);
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(ID, n);
        running = true;
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, TICK_MS);
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        paused();
        super.onTaskRemoved(rootIntent);
    }

    /** The app was closed: say messages are waiting for it, then stop. */
    private void paused() {
        handler.removeCallbacks(tick);
        NotificationManager nm = getSystemService(NotificationManager.class);
        try {
            if (nm != null) nm.notify("listening-paused", 0, notification(getString(R.string.listening_paused_title), getString(R.string.listening_paused_body), true));
        } catch (SecurityException ignored) {
        }
        running = false;
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private Notification notification(String title, String body, boolean dismissable) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.channel_listening), NotificationManager.IMPORTANCE_LOW);
            ch.setDescription(getString(R.string.channel_listening_description));
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).putExtra("path", "/messaging").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(getColor(R.color.brand))
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(pi)
                .setOngoing(!dismissable)
                .setAutoCancel(dismissable)
                .setOnlyAlertOnce(true)
                .build();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tick);
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
