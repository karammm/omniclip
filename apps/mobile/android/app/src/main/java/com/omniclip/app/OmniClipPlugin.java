package com.omniclip.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import androidx.core.content.FileProvider;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;

/**
 * Native helpers for the web layer:
 * - pins the OmniClip network's certificate authority for HTTPS/WebSocket connections to the hub
 * - holds what other apps shared to OmniClip ("Share → OmniClip") until it is taken
 * - copies images to the clipboard as real images (the Capacitor clipboard plugin pastes them as text),
 *   and text together with its formatting
 * - remembers that the Quick Settings tile or the widget asked to send the clipboard
 */
@CapacitorPlugin(name = "OmniClip")
public class OmniClipPlugin extends Plugin {

    static final String ACTION_SEND_CLIPBOARD = "com.omniclip.app.SEND_CLIPBOARD";
    private static final long MAX_BYTES = 50L * 1024 * 1024;
    private static final List<JSObject> pending = new ArrayList<>();
    private static boolean sendClipboard;
    private static volatile X509Certificate trustedCa;

    @PluginMethod
    public void trustCa(PluginCall call) {
        String pem = call.getString("pem");
        if (pem == null) {
            call.reject("missing pem");
            return;
        }
        try {
            CertificateFactory cf = CertificateFactory.getInstance("X.509");
            trustedCa = (X509Certificate) cf.generateCertificate(new ByteArrayInputStream(pem.getBytes(StandardCharsets.US_ASCII)));
            call.resolve();
        } catch (Exception e) {
            call.reject("invalid certificate: " + e.getMessage());
        }
    }

    /** True when the server certificate the WebView rejected was issued by the pinned OmniClip CA. */
    static boolean isTrustedHubCertificate(SslCertificate cert) {
        X509Certificate ca = trustedCa;
        if (ca == null || cert == null) return false;
        try {
            X509Certificate leaf;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) leaf = cert.getX509Certificate();
            else {
                Bundle state = SslCertificate.saveState(cert);
                byte[] der = state.getByteArray("x509-certificate");
                if (der == null) return false;
                leaf = (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
            }
            if (leaf == null) return false;
            leaf.checkValidity();
            leaf.verify(ca.getPublicKey());
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Opens OmniClip and asks it to send the clipboard (tile and widget). */
    static Intent sendClipboardIntent(Context ctx) {
        return new Intent(ctx, MainActivity.class).setAction(ACTION_SEND_CLIPBOARD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    static synchronized void collect(Context ctx, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (ACTION_SEND_CLIPBOARD.equals(action)) {
            sendClipboard = true;
        } else if (Intent.ACTION_SEND.equals(action)) {
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
        boolean send;
        synchronized (OmniClipPlugin.class) {
            for (JSObject item : pending) items.put(item);
            pending.clear();
            send = sendClipboard;
            sendClipboard = false;
        }
        JSObject result = new JSObject();
        result.put("items", items);
        result.put("sendClipboard", send);
        call.resolve(result);
    }

    /** Back to the app the user was in before the tile or widget opened OmniClip. */
    @PluginMethod
    public void moveToBack(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().moveTaskToBack(true);
            call.resolve();
        });
    }

    @PluginMethod
    public void copyText(PluginCall call) {
        String text = call.getString("text");
        String html = call.getString("html");
        if (text == null) {
            call.reject("missing text");
            return;
        }
        ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        cm.setPrimaryClip(html != null ? ClipData.newHtmlText("OmniClip", text, html) : ClipData.newPlainText("OmniClip", text));
        call.resolve();
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
