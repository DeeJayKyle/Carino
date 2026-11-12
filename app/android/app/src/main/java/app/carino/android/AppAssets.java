package app.carino.android;

import android.content.Context;
import android.webkit.WebResourceResponse;

import androidx.webkit.WebViewAssetLoader;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Serves the bundled app from assets/www. Paths that aren't files (/tasks, /chat/new…) get
 * index.html, so the app's own router can show the page.
 */
class AppAssets implements WebViewAssetLoader.PathHandler {
    private static final Map<String, String> TYPES = new HashMap<>();
    static {
        TYPES.put("html", "text/html");
        TYPES.put("js", "text/javascript");
        TYPES.put("mjs", "text/javascript");
        TYPES.put("css", "text/css");
        TYPES.put("json", "application/json");
        TYPES.put("webmanifest", "application/manifest+json");
        TYPES.put("wasm", "application/wasm");
        TYPES.put("svg", "image/svg+xml");
        TYPES.put("png", "image/png");
        TYPES.put("jpg", "image/jpeg");
        TYPES.put("webp", "image/webp");
        TYPES.put("ico", "image/x-icon");
        TYPES.put("woff2", "font/woff2");
        TYPES.put("woff", "font/woff");
        TYPES.put("txt", "text/plain");
    }

    private final Context context;

    AppAssets(Context context) {
        this.context = context;
    }

    @Override
    public WebResourceResponse handle(String path) {
        String clean = path.replaceAll("^/+", "");
        if (clean.contains("..")) return null;
        String ext = clean.contains(".") ? clean.substring(clean.lastIndexOf('.') + 1).toLowerCase() : "";
        String type = TYPES.get(ext);
        if (type != null) {
            InputStream in = open("www/" + clean);
            if (in != null) return respond(type, in, ext.equals("html") ? "no-cache" : "public, max-age=31536000, immutable");
            if (clean.startsWith("assets/")) return null; // a missing script or style is an error, not a page
        }
        InputStream index = open("www/index.html");
        return index == null ? null : respond("text/html", index, "no-cache");
    }

    private InputStream open(String asset) {
        try {
            return context.getAssets().open(asset);
        } catch (IOException e) {
            return null;
        }
    }

    private static WebResourceResponse respond(String type, InputStream in, String cache) {
        WebResourceResponse r = new WebResourceResponse(type, type.startsWith("text/") || type.endsWith("json") ? "utf-8" : null, in);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", cache);
        headers.put("X-Content-Type-Options", "nosniff");
        r.setResponseHeaders(headers);
        return r;
    }
}
