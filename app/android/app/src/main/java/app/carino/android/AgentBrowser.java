package app.carino.android;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

/**
 * The hidden browser Carino's agent uses for websites (server/services/browser.ts). It is a
 * separate WebView with its own pages, never shown and never given Carino's bridge, so a website
 * cannot reach the app. Only http and https pages load; everything else is refused. Answers go
 * back to the engine as __hn.browser(id, {value} | {error}).
 */
class AgentBrowser {
    private final MainActivity activity;
    private final NativeBridge bridge;
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private String loadingId;

    AgentBrowser(MainActivity activity, NativeBridge bridge) {
        this.activity = activity;
        this.bridge = bridge;
    }

    private void reply(String id, String value, String error) {
        try {
            JSONObject o = new JSONObject();
            if (error != null) o.put("error", error); else o.put("value", value == null ? "" : value);
            bridge.emit("window.__hn && __hn.browser(" + NativeBridge.quote(id) + "," + NativeBridge.quote(o.toString()) + ")");
        } catch (Exception ignored) {
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView web() {
        if (web != null) return web;
        web = new WebView(activity);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " CarinoAgent");
        // Never on screen, but laid out like a phone page so sites render their normal layout.
        int w = 1080, h = 2200;
        web.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY));
        web.layout(0, 0, w, h);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                return !("https".equals(scheme) || "http".equals(scheme));
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (loadingId != null) {
                    String id = loadingId;
                    loadingId = null;
                    // A little time for scripts that draw the page after loading.
                    main.postDelayed(() -> reply(id, url, null), 600);
                }
            }
        });
        return web;
    }

    void open(String id, String url) {
        main.post(() -> {
            Uri u = Uri.parse(url);
            if (!"https".equals(u.getScheme()) && !"http".equals(u.getScheme())) {
                reply(id, null, "Only web pages can be opened.");
                return;
            }
            if (loadingId != null) reply(loadingId, null, "Another page was opened.");
            loadingId = id;
            web().loadUrl(url);
        });
    }

    void eval(String id, String script) {
        main.post(() -> {
            if (web == null) {
                reply(id, null, "No page is open.");
                return;
            }
            web.evaluateJavascript(script, value -> reply(id, value, null));
        });
    }

    void back(String id) {
        main.post(() -> {
            if (web != null && web.canGoBack()) {
                loadingId = id;
                web.goBack();
            } else {
                reply(id, null, "There is no earlier page.");
            }
        });
    }

    void destroy() {
        main.post(() -> {
            if (web != null) web.destroy();
            web = null;
        });
    }
}
