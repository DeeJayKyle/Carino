package app.carino.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

/** Shows Carino's notifications. Tapping one opens the app at the page it's about. */
final class Notifier {
    private static final String CHANNEL = "reminders";

    private Notifier() {}

    static void show(Context ctx, String tag, String title, String body, String path) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, ctx.getString(R.string.channel_reminders), NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription(ctx.getString(R.string.channel_reminders_description));
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(ctx, MainActivity.class)
                .putExtra("path", path == null || path.isEmpty() ? "/" : path)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(ctx.getColor(R.color.brand))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .build();
        try {
            nm.notify(tag, 0, n);
        } catch (SecurityException ignored) {
            // Notifications not allowed; the reminder still shows inside the app.
        }
    }
}
