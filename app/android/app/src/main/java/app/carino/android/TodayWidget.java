package app.carino.android;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.text.format.DateFormat;
import android.text.format.DateUtils;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Home-screen widget: today's open to-dos and the next reminder, with buttons to talk to Carino
 * or add a to-do. The app hands it a small summary whenever its data changes
 * (mobile/engine.ts → setWidgetData); the widget itself never reads the app's data.
 */
public class TodayWidget extends AppWidgetProvider {
    private static final String PREFS = "widget";

    /** Stores the latest summary from the app and redraws every Today widget. */
    static void update(Context ctx, String json) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("today", json).apply();
        AppWidgetManager m = AppWidgetManager.getInstance(ctx);
        int[] ids = m.getAppWidgetIds(new ComponentName(ctx, TodayWidget.class));
        if (ids.length > 0) draw(ctx, m, ids);
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager manager, int[] ids) {
        draw(ctx, manager, ids);
    }

    private static void draw(Context ctx, AppWidgetManager manager, int[] ids) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_today);
        v.setOnClickPendingIntent(R.id.today_root, open(ctx, "/tasks", 11));
        v.setOnClickPendingIntent(R.id.today_talk, open(ctx, "/chat/new?voice=1", 12));
        v.setOnClickPendingIntent(R.id.today_add, open(ctx, "/tasks?new=1", 13));
        String json = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("today", null);
        if (json == null) {
            v.setTextViewText(R.id.today_summary, ctx.getString(R.string.today_open));
            v.setTextViewText(R.id.today_list, "");
            v.setTextViewText(R.id.today_next, "");
        } else {
            try {
                JSONObject d = new JSONObject(json);
                int total = d.optInt("total"), overdue = d.optInt("overdue");
                JSONArray todos = d.optJSONArray("todos");
                if (total == 0) {
                    v.setTextViewText(R.id.today_summary, ctx.getString(R.string.today_none));
                } else {
                    String s = total + (total == 1 ? " thing to do" : " things to do");
                    if (overdue > 0) s += " · " + overdue + " overdue";
                    v.setTextViewText(R.id.today_summary, s);
                }
                StringBuilder list = new StringBuilder();
                for (int i = 0; todos != null && i < todos.length(); i++) {
                    if (list.length() > 0) list.append('\n');
                    list.append("○  ").append(todos.optString(i));
                }
                if (todos != null && total > todos.length()) list.append("\n+").append(total - todos.length()).append(" more");
                v.setTextViewText(R.id.today_list, list.toString());
                JSONObject next = d.optJSONObject("next");
                v.setTextViewText(R.id.today_next, next == null ? "" : "⏰ " + when(ctx, next.optLong("at")) + " · " + next.optString("title"));
            } catch (Exception e) {
                v.setTextViewText(R.id.today_summary, ctx.getString(R.string.today_open));
            }
        }
        for (int id : ids) manager.updateAppWidget(id, v);
    }

    private static String when(Context ctx, long at) {
        String time = DateFormat.getTimeFormat(ctx).format(at);
        if (DateUtils.isToday(at)) return time;
        if (DateUtils.isToday(at - DateUtils.DAY_IN_MILLIS)) return "Tomorrow " + time;
        return DateUtils.formatDateTime(ctx, at, DateUtils.FORMAT_SHOW_WEEKDAY | DateUtils.FORMAT_ABBREV_WEEKDAY) + " " + time;
    }

    private static PendingIntent open(Context ctx, String path, int requestCode) {
        Intent intent = new Intent(ctx, MainActivity.class).putExtra("path", path)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
