package app.carino.android;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Things that happened to reminders while the app may have been closed: Snooze and Done pressed
 * on a notification, or arriving at a place. The app takes them on its next run
 * (mobile/engine.ts → takeReminderEvents) and updates its own records.
 */
final class ReminderEvents {
    private static final String PREFS = "reminder_events";
    private static final int MAX = 200;

    private ReminderEvents() {}

    static synchronized void add(Context ctx, String type, String id, int minutes) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            JSONArray list = new JSONArray(p.getString("list", "[]"));
            if (list.length() >= MAX) return;
            JSONObject e = new JSONObject().put("type", type).put("id", id).put("at", System.currentTimeMillis());
            if (minutes > 0) e.put("minutes", minutes);
            list.put(e);
            p.edit().putString("list", list.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    /** Returns every event recorded so far and forgets them. */
    static synchronized String take(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String list = p.getString("list", "[]");
        p.edit().putString("list", "[]").apply();
        return list;
    }
}
