package app.carino.android;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;
import androidx.webkit.WebViewAssetLoader;

import java.util.Map;

import io.flutter.embedding.android.FlutterActivity;
import io.flutter.embedding.engine.FlutterEngine;
import io.flutter.plugin.common.MethodChannel;
import io.flutter.plugin.common.StandardMessageCodec;
import io.flutter.plugin.platform.PlatformView;
import io.flutter.plugin.platform.PlatformViewFactory;

/**
 * Carino for Android, Flutter edition. Carino's engine (its server code, database and AI agent,
 * see mobile/engine.ts) runs in one WebView at the same address as in the earlier app, so all saved
 * data carries over. The Flutter screens talk to it through window.__carinoFlutter (requests in) and
 * CarinoFlutter.post (replies and events out). Screens not yet rebuilt in Flutter are shown by the
 * same WebView, which Flutter places on screen as a platform view.
 */
public class MainActivity extends FlutterActivity {
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;
    private static final int FILE_CHOOSER = 41;
    private static final String TAG = "Carino";

    /** True while the app is on screen; alarms then leave reminders to the app itself. */
    static volatile boolean visible = false;
    /** The running activity, for the background listener and the sign-in listener. */
    static volatile MainActivity current;

    WebView web;
    NativeBridge bridge;
    private MethodChannel channel;
    private ValueCallback<Uri[]> fileCallback;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public void configureFlutterEngine(@NonNull FlutterEngine engine) {
        super.configureFlutterEngine(engine);
        createEngineView();
        channel = new MethodChannel(engine.getDartExecutor().getBinaryMessenger(), "carino/engine");
        channel.setMethodCallHandler((call, result) -> {
            switch (call.method) {
                case "request": {
                    // Into the engine: an API request (answered later through CarinoFlutter.post).
                    String js = "window.__carinoFlutter && __carinoFlutter.request(" + NativeBridge.quote(String.valueOf(call.argument("json"))) + ")";
                    web.evaluateJavascript(js, null);
                    result.success(null);
                    break;
                }
                case "abort":
                    web.evaluateJavascript("window.__carinoFlutter && __carinoFlutter.abort(" + NativeBridge.quote(String.valueOf(call.argument("id"))) + ")", null);
                    result.success(null);
                    break;
                case "open":
                    // Shows a screen that isn't in Flutter yet, in the engine's own pages.
                    String path = call.argument("path");
                    if (isAppPath(path)) web.evaluateJavascript("window.dispatchEvent(new Event('carino-refresh')); window.__hn && __hn.open(" + NativeBridge.quote(path) + ")", null);
                    result.success(null);
                    break;
                case "back":
                    if (web.canGoBack()) web.goBack();
                    result.success(null);
                    break;
                case "restart":
                    // After a restore or "erase everything": the engine starts afresh.
                    web.loadUrl(ORIGIN + "/?flutter=1");
                    result.success(null);
                    break;
                case "startPath":
                    result.success(startPath(getIntent()));
                    break;
                default:
                    result.notImplemented();
            }
        });
        engine.getPlatformViewsController().getRegistry().registerViewFactory("carino/engine-view", new PlatformViewFactory(StandardMessageCodec.INSTANCE) {
            @NonNull
            @Override
            public PlatformView create(Context context, int viewId, Object args) {
                return new PlatformView() {
                    @Override
                    public View getView() {
                        return web;
                    }

                    @Override
                    public void dispose() {
                        // The engine lives as long as the activity; only Flutter's handle goes away.
                    }
                };
            }
        });
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void createEngineView() {
        if (web != null) return;
        web = new WebView(this);
        // Debug builds only: lets the emulator test drive the app.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        web.setBackgroundColor(getColor(R.color.surface));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setTextZoom(100);

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/", new AppAssets(this))
                .build();

        bridge = new NativeBridge(this);
        current = this;
        web.addJavascriptInterface(bridge, "CarinoNative");
        web.addJavascriptInterface(new FlutterLink(), "CarinoFlutter");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse r = loader.shouldInterceptRequest(request.getUrl());
                if (r != null) isolate(r);
                return r;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return false;
                openExternal(url);
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.println(m.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? Log.ERROR : Log.INFO, TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent pick = params.createIntent();
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(Intent.createChooser(pick, null), FILE_CHOOSER);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Only Carino's own bundled page can ask; allow the microphone for voice features.
                if (ORIGIN.equals(request.getOrigin().toString().replaceAll("/$", ""))) request.grant(request.getResources());
                else request.deny();
            }
        });

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }

        bridge.captureShare(getIntent());
        // "?flutter=1": the engine starts its Flutter link and the web screens stay out of the way
        // until one is opened.
        web.loadUrl(ORIGIN + "/?flutter=1");
    }

    /** Replies and events from the engine to Flutter. */
    private class FlutterLink {
        @JavascriptInterface
        public void post(String json) {
            main.post(() -> {
                if (channel != null) channel.invokeMethod("message", json);
            });
        }
    }

    /** A page to open from a notification or the widget, if any. */
    private static String startPath(Intent intent) {
        String path = intent == null ? null : intent.getStringExtra("path");
        return isAppPath(path) ? path : "/";
    }

    @Override
    protected void onNewIntent(@NonNull Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (bridge.captureShare(intent)) bridge.emit("window.__hn && __hn.shared()");
        String path = intent.getStringExtra("path");
        if (isAppPath(path) && channel != null) channel.invokeMethod("open", path);
    }

    /** A page inside the app ("/tasks"), never "//host" or anything with a scheme. */
    static boolean isAppPath(String path) {
        return path != null && path.startsWith("/") && !path.startsWith("//") && !path.contains("\\");
    }

    private static final String[] ALLOWED_SCHEMES = {"https", "http", "mailto", "tel", "sms", "geo"};

    /** The only kinds of link the app hands to other apps: web, email, phone, SMS and maps. */
    static boolean isAllowedExternal(Uri url) {
        String s = url == null ? null : url.getScheme();
        if (s == null) return false;
        s = s.toLowerCase(java.util.Locale.ROOT);
        for (String ok : ALLOWED_SCHEMES) if (ok.equals(s)) return true;
        return false;
    }

    void openExternal(Uri url) {
        if (!isAllowedExternal(url)) {
            Log.w(TAG, "Not opening link with scheme " + (url == null ? "null" : url.getScheme()));
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            Log.w(TAG, "No app can open " + url);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == LocalFolders.PICK) {
            if (bridge != null) bridge.folderPicked(resultCode == RESULT_OK && data != null ? data.getData() : null);
            return;
        }
        if (requestCode != FILE_CHOOSER || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                result = new Uri[data.getClipData().getItemCount()];
                for (int i = 0; i < result.length; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (bridge != null) bridge.onPermissionResult(requestCode, results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED);
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        visible = false;
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        if (bridge != null) bridge.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /**
     * Cross-origin isolation, so the on-phone AI (mobile/ondevice.ts) can use several processor
     * cores. "credentialless" still lets pictures from other sites load, just without cookies.
     */
    private static void isolate(WebResourceResponse r) {
        Map<String, String> h = new java.util.HashMap<>();
        if (r.getResponseHeaders() != null) h.putAll(r.getResponseHeaders());
        h.put("Cross-Origin-Opener-Policy", "same-origin");
        h.put("Cross-Origin-Embedder-Policy", "credentialless");
        r.setResponseHeaders(h);
    }
}
