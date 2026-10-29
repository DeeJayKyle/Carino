package app.carino.android;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/**
 * Home-screen widget with three shortcuts into Carino: Ramble, Talk (voice mode) and a new chat.
 * Each opens the app at that page; no data is read by the widget itself.
 */
public class QuickActionsWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        for (int id : widgetIds) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_quick_actions);
            views.setOnClickPendingIntent(R.id.widget_ramble, open(context, "/ramble", 1));
            views.setOnClickPendingIntent(R.id.widget_talk, open(context, "/chat/new?voice=1", 2));
            views.setOnClickPendingIntent(R.id.widget_chat, open(context, "/chat/new", 3));
            manager.updateAppWidget(id, views);
        }
    }

    private static PendingIntent open(Context context, String path, int requestCode) {
        Intent intent = new Intent(context, MainActivity.class).putExtra("path", path);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
