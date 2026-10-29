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
            return;
        }
        // While Carino is open its own scheduler delivers the reminder (same tag, so no duplicate).
        if (MainActivity.visible) return;
        Notifier.show(ctx, i.getStringExtra("tag"), i.getStringExtra("title"), i.getStringExtra("body"), i.getStringExtra("url"));
    }
}
