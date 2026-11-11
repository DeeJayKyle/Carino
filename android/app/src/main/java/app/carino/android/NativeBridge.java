package app.carino.android;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * What the app's JavaScript can ask Android for (mobile/native.ts). Only the bundled page can
 * call it: the WebView never loads other sites.
 */
class NativeBridge {
    private static final int MIC_PERMISSION = 7;
    private static final int LOCATION_PERMISSION = 8;
    private static final int BACKGROUND_LOCATION_PERMISSION = 9;
    private static final int MAX_SHARED_BYTES = 25 * 1024 * 1024;

    private final MainActivity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, HttpURLConnection> open = new ConcurrentHashMap<>();
    private final Map<String, Boolean> aborted = new ConcurrentHashMap<>();
    private volatile String shared;
    private SpeechRecognizer recognizer;
    private String pendingListenLang;
    private TextToSpeech tts;
    private boolean ttsReady;
    private String pendingSpeech;
    private String pendingSpeechLang;

    NativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    static String quote(String s) {
        return JSONObject.quote(s);
    }

    /** Runs JavaScript in the page. Safe to call from any thread. */
    void emit(String js) {
        main.post(() -> {
            if (!activity.isDestroyed()) activity.web.evaluateJavascript(js, null);
        });
    }

    // ---- HTTP --------------------------------------------------------------------------------

    @JavascriptInterface
    public void httpStart(String id, String requestJson) {
        pool.execute(() -> runHttp(id, requestJson));
    }

    @JavascriptInterface
    public void httpAbort(String id) {
        aborted.put(id, true);
        HttpURLConnection c = open.remove(id);
        if (c != null) pool.execute(c::disconnect);
    }

    private void runHttp(String id, String requestJson) {
        HttpURLConnection c = null;
        String q = quote(id);
        try {
            JSONObject req = new JSONObject(requestJson);
            c = (HttpURLConnection) new URL(req.getString("url")).openConnection();
            open.put(id, c);
            c.setInstanceFollowRedirects(!"manual".equals(req.optString("redirect")));
            c.setConnectTimeout(20_000);
            c.setReadTimeout(180_000);
            c.setUseCaches(false);
            c.setRequestMethod(req.getString("method"));
            JSONArray headers = req.getJSONArray("headers");
            for (int i = 0; i < headers.length(); i++) {
                JSONArray h = headers.getJSONArray(i);
                c.setRequestProperty(h.getString(0), h.getString(1));
            }
            String body = req.optString("body", "");
            if (!body.isEmpty()) {
                byte[] bytes = Base64.decode(body, Base64.NO_WRAP);
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = c.getOutputStream()) {
                    out.write(bytes);
                }
            }
            int status = c.getResponseCode();
            JSONArray resHeaders = new JSONArray();
            for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                if (e.getKey() == null) continue;
                for (String v : e.getValue()) resHeaders.put(new JSONArray().put(e.getKey()).put(v));
            }
            emit("__hn.head(" + q + "," + status + "," + quote(resHeaders.toString()) + ")");
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in != null) {
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (aborted.containsKey(id)) break;
                    emit("__hn.chunk(" + q + ",\"" + Base64.encodeToString(buf, 0, n, Base64.NO_WRAP) + "\")");
                }
                in.close();
            }
            emit("__hn.end(" + q + ")");
        } catch (Exception e) {
            if (!aborted.containsKey(id)) emit("__hn.error(" + q + "," + quote(String.valueOf(e.getMessage())) + ")");
        } finally {
            open.remove(id);
            aborted.remove(id);
            if (c != null) c.disconnect();
        }
    }

    // ---- Notifications -----------------------------------------------------------------------

    @JavascriptInterface
    public void notify(String json) {
        try {
            JSONObject n = new JSONObject(json);
            Notifier.show(activity, n.getString("tag"), n.getString("title"), n.optString("body"), n.optString("url", "/"));
        } catch (Exception ignored) {
        }
    }

    @JavascriptInterface
    public void setAlarms(String json) {
        Alarms.replace(activity, json);
    }

    // ---- Smarter reminders -------------------------------------------------------------------

    @JavascriptInterface
    public void setPlaceAlerts(String json) {
        PlaceAlerts.replace(activity, json);
    }

    /** Snooze / Done pressed on notifications and places arrived at, since the last call. */
    @JavascriptInterface
    public String takeReminderEvents() {
        return ReminderEvents.take(activity);
    }

    /** "always" (rings while closed), "while-open", or "no". */
    @JavascriptInterface
    public String placesPermission() {
        if (!PlaceAlerts.allowed(activity)) return "no";
        return Build.VERSION.SDK_INT < 29 || backgroundLocation() ? "always" : "while-open";
    }

    /** Asks for location (then "all the time"); the answer arrives as a "carino-location" event. */
    @JavascriptInterface
    public void askPlacesPermission() {
        main.post(() -> {
            if (!PlaceAlerts.allowed(activity)) {
                activity.requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_PERMISSION);
            } else if (Build.VERSION.SDK_INT >= 29 && !backgroundLocation()) {
                activity.requestPermissions(new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION}, BACKGROUND_LOCATION_PERMISSION);
            } else {
                locationResult();
            }
        });
    }

    private boolean backgroundLocation() {
        return Build.VERSION.SDK_INT < 29 || activity.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void locationResult() {
        PlaceAlerts.rearm(activity);
        emit("dispatchEvent(new CustomEvent('carino-location', { detail: " + quote(placesPermission()) + " }))");
    }

    // ---- Speech ------------------------------------------------------------------------------

    @JavascriptInterface
    public void listen(String lang) {
        main.post(() -> {
            if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                pendingListenLang = lang;
                activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MIC_PERMISSION);
                return;
            }
            startListening(lang);
        });
    }

    void onPermissionResult(int requestCode, boolean granted) {
        if (requestCode == LOCATION_PERMISSION) {
            // Step 2 (Android 10+): "Allow all the time", so place reminders ring while Carino is closed.
            if (granted && Build.VERSION.SDK_INT >= 29 && !backgroundLocation()) {
                activity.requestPermissions(new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION}, BACKGROUND_LOCATION_PERMISSION);
            } else {
                locationResult();
            }
            return;
        }
        if (requestCode == BACKGROUND_LOCATION_PERMISSION) {
            locationResult();
            return;
        }
        if (requestCode != MIC_PERMISSION || pendingListenLang == null) return;
        String lang = pendingListenLang;
        pendingListenLang = null;
        if (granted) startListening(lang);
        else speech("{\"error\":\"not-allowed\",\"end\":true}");
    }

    private void speech(String json) {
        emit("__hn.speech(" + quote(json) + ")");
    }

    private void startListening(String lang) {
        if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
            speech("{\"error\":\"This phone has no speech recognition. Install or enable Google's voice typing.\",\"end\":true}");
            return;
        }
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(activity);
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle b) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float v) {}
                @Override public void onBufferReceived(byte[] b) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onEvent(int t, Bundle b) {}

                @Override
                public void onError(int error) {
                    String code = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ? "no-speech"
                            : error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ? "not-allowed"
                            : error == SpeechRecognizer.ERROR_NETWORK || error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT ? "network" : "error " + error;
                    try {
                        speech(new JSONObject().put("error", code).put("end", true).toString());
                    } catch (Exception ignored) {
                    }
                }

                @Override
                public void onPartialResults(Bundle b) {
                    ArrayList<String> r = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (r != null && !r.isEmpty()) {
                        try {
                            speech(new JSONObject().put("partial", r.get(0)).toString());
                        } catch (Exception ignored) {
                        }
                    }
                }

                @Override
                public void onResults(Bundle b) {
                    ArrayList<String> r = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    try {
                        JSONObject o = new JSONObject().put("end", true);
                        if (r != null && !r.isEmpty()) o.put("final", r.get(0));
                        speech(o.toString());
                    } catch (Exception ignored) {
                    }
                }
            });
        }
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500);
        recognizer.startListening(i);
    }

    @JavascriptInterface
    public void stopListening() {
        main.post(() -> {
            if (recognizer != null) recognizer.stopListening();
        });
    }

    @JavascriptInterface
    public void speak(String text, String lang) {
        main.post(() -> {
            if (tts == null) {
                pendingSpeech = text;
                pendingSpeechLang = lang;
                tts = new TextToSpeech(activity, status -> {
                    ttsReady = status == TextToSpeech.SUCCESS;
                    tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        @Override public void onStart(String id) {}
                        @Override public void onDone(String id) { emit("__hn.spoke()"); }
                        @Override public void onError(String id) { emit("__hn.spoke()"); }
                    });
                    if (pendingSpeech != null) say(pendingSpeech, pendingSpeechLang);
                    pendingSpeech = null;
                });
                return;
            }
            say(text, lang);
        });
    }

    private void say(String text, String lang) {
        if (!ttsReady) {
            emit("__hn.spoke()");
            return;
        }
        tts.setLanguage(Locale.forLanguageTag(lang));
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "carino");
    }

    @JavascriptInterface
    public void stopSpeaking() {
        main.post(() -> {
            if (tts != null) tts.stop();
        });
    }

    // ---- Files and sharing -------------------------------------------------------------------

    /** Saves to the phone's Downloads folder and returns a message for the user. */
    @JavascriptInterface
    public String saveFile(String name, String mime, String base64) {
        String safe = name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_");
        byte[] bytes = Base64.decode(base64, Base64.NO_WRAP);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                ContentResolver cr = activity.getContentResolver();
                Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new Exception("no Downloads folder");
                try (OutputStream out = cr.openOutputStream(uri)) {
                    out.write(bytes);
                }
                return "Saved to Downloads: " + safe;
            }
            File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            File f = new File(dir, safe);
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(bytes);
            }
            return "Saved: " + f.getAbsolutePath();
        } catch (Exception e) {
            return "Could not save " + safe + ": " + e.getMessage();
        }
    }

    @JavascriptInterface
    public void shareText(String text) {
        Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
        main.post(() -> activity.startActivity(Intent.createChooser(send, null)));
    }

    /** Shares a file through Android's share sheet (WhatsApp, Telegram, messages…). */
    @JavascriptInterface
    public void shareFile(String name, String mime, String base64, String text) {
        try {
            File dir = new File(activity.getCacheDir(), "shared");
            dir.mkdirs();
            File f = new File(dir, name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_"));
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(Base64.decode(base64, Base64.NO_WRAP));
            }
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".files", f);
            Intent send = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (text != null && !text.isEmpty()) send.putExtra(Intent.EXTRA_TEXT, text);
            main.post(() -> activity.startActivity(Intent.createChooser(send, null)));
        } catch (Exception e) {
            emit("console.error(" + quote("Sharing failed: " + e.getMessage()) + ")");
        }
    }

    /** Keeps what another app shared until the page takes it. Returns true if there was something. */
    boolean captureShare(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return false;
        try {
            JSONObject o = new JSONObject();
            o.put("title", nz(intent.getStringExtra(Intent.EXTRA_SUBJECT)));
            o.put("text", nz(intent.getStringExtra(Intent.EXTRA_TEXT)));
            o.put("url", "");
            JSONArray files = new JSONArray();
            List<Uri> uris = new ArrayList<>();
            if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) uris.addAll(list);
            } else {
                Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u != null) uris.add(u);
            }
            for (Uri u : uris) {
                JSONObject f = readShared(u);
                if (f != null) files.put(f);
            }
            o.put("files", files);
            shared = o.toString();
            intent.setAction(Intent.ACTION_MAIN); // don't take it again after a rotation
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private JSONObject readShared(Uri uri) throws Exception {
        ContentResolver cr = activity.getContentResolver();
        String name = "shared";
        try (Cursor c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception ignored) {
        }
        try (InputStream in = cr.openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_SHARED_BYTES) return null;
            }
            return new JSONObject().put("name", name).put("type", nz(cr.getType(uri))).put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
        }
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    @JavascriptInterface
    public String takeShared() {
        String s = shared;
        shared = null;
        return s == null ? "" : s;
    }

    @JavascriptInterface
    public void openExternal(String url) {
        main.post(() -> activity.openExternal(Uri.parse(url)));
    }

    /** Gets ready to catch a sign-in coming back from the browser. Returns an error, or "". */
    @JavascriptInterface
    public String oauthListen() {
        return SignInListener.start(this);
    }

    /** Keeps answering messages while the app is in the background (an ongoing notification). */
    @JavascriptInterface
    public void keepListening(boolean on) {
        if (on == Listening.running) return;
        main.post(() -> Listening.set(activity, on));
    }

    @JavascriptInterface
    public String appInfo() {
        try {
            return new JSONObject().put("version", BuildConfig.VERSION_NAME).put("flavor", "android").toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    void shutdown() {
        pool.shutdownNow();
        if (recognizer != null) recognizer.destroy();
        if (tts != null) tts.shutdown();
    }
}
