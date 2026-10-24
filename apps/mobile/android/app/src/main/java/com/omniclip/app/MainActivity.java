package com.omniclip.app;

import android.net.http.SslError;
import android.os.Bundle;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OmniClipPlugin.class);
        super.onCreate(savedInstanceState);
        OmniClipPlugin.collect(this, getIntent());

        // The hub uses a certificate from the network's own CA; accept it (and only it) once pinned.
        bridge.setWebViewClient(
            new BridgeWebViewClient(bridge) {
                @Override
                public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                    if (error.getPrimaryError() == SslError.SSL_UNTRUSTED && OmniClipPlugin.isTrustedHubCertificate(error.getCertificate())) {
                        handler.proceed();
                    } else {
                        super.onReceivedSslError(view, handler, error);
                    }
                }
            }
        );
    }
}
