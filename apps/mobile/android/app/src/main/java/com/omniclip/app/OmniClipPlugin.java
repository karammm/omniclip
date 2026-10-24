package com.omniclip.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import androidx.core.content.FileProvider;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Android-only helpers for the web layer:
 * - holds what other apps shared to OmniClip ("Share → OmniClip") until it is taken
 * - copies images to the clipboard as real images (the Capacitor clipboard plugin pastes them as text)
 */
@CapacitorPlugin(name = "OmniClip")
public class OmniClipPlugin extends Plugin {

    private static final long MAX_BYTES = 50L * 1024 * 1024;
    private static final List<JSObject> pending = new ArrayList<>();

    static synchronized void collect(Context ctx, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (stream != null) addFile(ctx, stream);
            else {
                CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (text != null && text.length() > 0) {
                    JSObject item = new JSObject();
                    item.put("kind", "text");
                    item.put("text", text.toString());
                    pending.add(item);
                }
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (streams != null) for (Uri uri : streams) addFile(ctx, uri);
        } else {
            return;
        }
        // handled once; don't re-deliver on configuration changes
        intent.setAction(null);
    }

    private static void addFile(Context ctx, Uri uri) {
        ContentResolver resolver = ctx.getContentResolver();
        String name = "shared";
        try (Cursor c = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
        } catch (Exception ignored) {}
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) return;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > MAX_BYTES) return;
                out.write(buf, 0, n);
            }
            String mime = resolver.getType(uri);
            JSObject item = new JSObject();
            item.put("kind", "file");
            item.put("name", name);
            item.put("mime", mime != null ? mime : "application/octet-stream");
            item.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            pending.add(item);
        } catch (Exception ignored) {}
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        collect(getContext(), intent);
        notifyListeners("shared", new JSObject());
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSArray items = new JSArray();
        synchronized (OmniClipPlugin.class) {
            for (JSObject item : pending) items.put(item);
            pending.clear();
        }
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }

    @PluginMethod
    public void copyImage(PluginCall call) {
        String data = call.getString("data");
        String mime = call.getString("mime", "image/png");
        if (data == null) {
            call.reject("missing data");
            return;
        }
        try {
            Context ctx = getContext();
            File dir = new File(ctx.getCacheDir(), "clipboard");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("cannot create cache dir");
            String ext = mime.contains("/") ? mime.substring(mime.indexOf('/') + 1) : "png";
            File file = new File(dir, "omniclip-image." + ext);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(Base64.decode(data, Base64.DEFAULT));
            }
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
            ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newUri(ctx.getContentResolver(), "OmniClip image", uri));
            call.resolve();
        } catch (Exception e) {
            call.reject("copy failed: " + e.getMessage());
        }
    }
}
