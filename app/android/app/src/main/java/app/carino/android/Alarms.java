package app.carino.android;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Upcoming reminders handed over by the app (mobile/engine.ts → setAlarms), so they still ring
 * while Carino is closed. The list is replaced each time; it's kept so a restart can re-arm it.
 */
public final class Alarms extends BroadcastReceiver {
    private static final String PREFS = "alarms";
    private static final int MAX = 60;
    static final String REMINDER_PREFIX = "reminder-";
    static final String SNOOZE = "app.carino.SNOOZE";
    static final String DONE = "app.carino.DONE";
    private static final String SNOOZED = "app.carino.SNOOZED";
    static final int SNOOZE_MINUTES = 10;

    /** A Snooze or Done button on a reminder notification. */
    static PendingIntent action(Context ctx, String what, String tag, String title, String body, String url) {
        Intent i = new Intent(ctx, Alarms.class).setAction(what)
                .putExtra("tag", tag).putExtra("title", title).putExtra("body", body).putExtra("url", url);
        return PendingIntent.getBroadcast(ctx, (what + tag).hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** The alarm that rings a snoozed reminder again (its own request code, so replace() keeps it). */
    private static PendingIntent snoozed(Context ctx, Intent from) {
        String tag = from.getStringExtra("tag");
        Intent i = new Intent(ctx, Alarms.class).setAction(SNOOZED)
                .putExtra("tag", tag).putExtra("title", from.getStringExtra("title"))
                .putExtra("body", from.getStringExtra("body")).putExtra("url", from.getStringExtra("url"));
        return PendingIntent.getBroadcast(ctx, 10_000 + (tag.hashCode() & 0xffff), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void replace(Context ctx, String json) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        cancelAll(ctx, p.getString("list", "[]"));
        p.edit().putString("list", json).apply();
        arm(ctx, json);
    }

    static void rearm(Context ctx) {
        arm(ctx, ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("list", "[]"));
    }

    private static PendingIntent intent(Context ctx, int slot, JSONObject a) {
        Intent i = new Intent(ctx, Alarms.class).setAction("app.carino.ALARM." + slot);
        if (a != null) {
            i.putExtra("tag", a.optString("tag")).putExtra("title", a.optString("title"))
                    .putExtra("body", a.optString("body")).putExtra("url", a.optString("url", "/"));
        }
        return PendingIntent.getBroadcast(ctx, slot, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void arm(Context ctx, String json) {
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        if (am == null) return;
        try {
            JSONArray list = new JSONArray(json);
            long now = System.currentTimeMillis();
            for (int i = 0; i < Math.min(list.length(), MAX); i++) {
                JSONObject a = list.getJSONObject(i);
                long at = a.optLong("at");
                if (at <= now) continue;
                PendingIntent pi = intent(ctx, i, a);
                if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (Exception ignored) {
        }
    }

    private static void cancelAll(Context ctx, String json) {
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        if (am == null) return;
        try {
            int n = Math.min(new JSONArray(json).length(), MAX);
            for (int i = 0; i < n; i++) am.cancel(intent(ctx, i, null));
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onReceive(Context ctx, Intent i) {
        String action = i.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            rearm(ctx);
            PlaceAlerts.rearm(ctx);
            return;
        }
        String tag = i.getStringExtra("tag");
        if (SNOOZE.equals(action) && tag != null) {
            // Ring again in 10 minutes, even if the app stays closed; the app records it next time it runs.
            Notifier.cancel(ctx, tag);
            AlarmManager am = ctx.getSystemService(AlarmManager.class);
            long at = System.currentTimeMillis() + SNOOZE_MINUTES * 60_000L;
            if (am != null) {
                if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, snoozed(ctx, i));
                else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, snoozed(ctx, i));
            }
            ReminderEvents.add(ctx, "snooze", tag.substring(REMINDER_PREFIX.length()), SNOOZE_MINUTES);
            return;
        }
        if (DONE.equals(action) && tag != null) {
            Notifier.cancel(ctx, tag);
            ReminderEvents.add(ctx, "done", tag.substring(REMINDER_PREFIX.length()), 0);
            return;
        }
        if (SNOOZED.equals(action)) {
            // Shown even while the app is open: the app's own copy is the same notification (same tag).
            Notifier.show(ctx, tag, i.getStringExtra("title"), i.getStringExtra("body"), i.getStringExtra("url"));
            return;
        }
        // While Carino is open its own scheduler delivers the reminder (same tag, so no duplicate).
        if (MainActivity.visible) return;
        Notifier.show(ctx, i.getStringExtra("tag"), i.getStringExtra("title"), i.getStringExtra("body"), i.getStringExtra("url"));
    }
}
