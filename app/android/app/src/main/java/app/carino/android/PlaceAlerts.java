package app.carino.android;

import android.Manifest;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Place reminders ("remind me when I get to the shop"), handed over by the app
 * (mobile/engine.ts → setPlaceAlerts). Uses Android's own proximity alerts, so no Google Play
 * services are needed; Android checks the location now and then, and rings once on arriving.
 * Needs location allowed "all the time" to work while Carino is closed.
 */
public final class PlaceAlerts extends BroadcastReceiver {
    private static final String PREFS = "place_alerts";
    private static final String ACTION = "app.carino.PLACE";
    private static final int MAX = 50;

    static void replace(Context ctx, String json) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        cancelAll(ctx, p.getString("list", "[]"));
        p.edit().putString("list", json).apply();
        arm(ctx, json);
    }

    static void rearm(Context ctx) {
        arm(ctx, ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("list", "[]"));
    }

    static boolean allowed(Context ctx) {
        return ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private static PendingIntent intent(Context ctx, int slot, JSONObject a) {
        Intent i = new Intent(ctx, PlaceAlerts.class).setAction(ACTION + "." + slot);
        if (a != null) i.putExtra("id", a.optString("id")).putExtra("title", a.optString("title")).putExtra("body", a.optString("body"));
        // Android adds "entering" to the intent, so it must be mutable.
        return PendingIntent.getBroadcast(ctx, 20_000 + slot, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
    }

    @SuppressWarnings("MissingPermission")
    private static void arm(Context ctx, String json) {
        LocationManager lm = ctx.getSystemService(LocationManager.class);
        if (lm == null || !allowed(ctx)) return;
        try {
            JSONArray list = new JSONArray(json);
            for (int i = 0; i < Math.min(list.length(), MAX); i++) {
                JSONObject a = list.getJSONObject(i);
                lm.addProximityAlert(a.getDouble("lat"), a.getDouble("lon"), (float) a.optDouble("radius", 150), -1, intent(ctx, i, a));
            }
        } catch (SecurityException | org.json.JSONException ignored) {
        }
    }

    @SuppressWarnings("MissingPermission")
    private static void cancelAll(Context ctx, String json) {
        LocationManager lm = ctx.getSystemService(LocationManager.class);
        if (lm == null) return;
        try {
            int n = Math.min(new JSONArray(json).length(), MAX);
            for (int i = 0; i < n; i++) lm.removeProximityAlert(intent(ctx, i, null));
        } catch (SecurityException | org.json.JSONException ignored) {
        }
    }

    @Override
    public void onReceive(Context ctx, Intent i) {
        if (!i.getBooleanExtra(LocationManager.KEY_PROXIMITY_ENTERING, false)) return;
        String id = i.getStringExtra("id");
        if (id == null || id.isEmpty()) return;
        // Ring once: stop watching this place; the app marks it done when it next runs.
        try {
            LocationManager lm = ctx.getSystemService(LocationManager.class);
            if (lm != null) lm.removeProximityAlert(PendingIntent.getBroadcast(ctx, 20_000 + slotOf(i), i, PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_MUTABLE));
        } catch (Exception ignored) {
        }
        ReminderEvents.add(ctx, "arrived", id, 0);
        String body = i.getStringExtra("body");
        Notifier.show(ctx, "place-" + id, "📍 " + i.getStringExtra("title"), body == null || body.isEmpty() ? ctx.getString(R.string.place_arrived) : body, "/tasks");
    }

    private static int slotOf(Intent i) {
        String a = i.getAction();
        try {
            return Integer.parseInt(a.substring(a.lastIndexOf('.') + 1));
        } catch (Exception e) {
            return 0;
        }
    }
}
