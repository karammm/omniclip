package com.omniclip.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/** Home-screen widget: "Send clipboard" sends whatever is copied; the icon opens OmniClip. */
public class SendClipboardWidget extends AppWidgetProvider {

    @Override
    public void onUpdate(Context ctx, AppWidgetManager manager, int[] ids) {
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent send = PendingIntent.getActivity(ctx, 1, OmniClipPlugin.sendClipboardIntent(ctx), flags);
        Intent launch = new Intent(ctx, MainActivity.class).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        PendingIntent open = PendingIntent.getActivity(ctx, 2, launch, flags);
        for (int id : ids) {
            RemoteViews views = new RemoteViews(ctx.getPackageName(), R.layout.widget_send);
            views.setOnClickPendingIntent(R.id.widget_send, send);
            views.setOnClickPendingIntent(R.id.widget_open, open);
            manager.updateAppWidget(id, views);
        }
    }
}
