package app.carino.android;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.UriMatcher;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

/**
 * Serves Carino's sticker packs to WhatsApp, following WhatsApp's published third-party sticker
 * format: pack details at /metadata, a pack's stickers at /stickers/<id>, and each image at
 * /stickers_asset/<id>/<file>. Packs live in files/stickers/<id>/ (pack.json plus the images),
 * written by StickerPacks. Read-only: nothing can be changed through it.
 */
public class StickerProvider extends ContentProvider {
    private static final int METADATA = 1, METADATA_ONE = 2, STICKERS = 3, ASSET = 4;
    private UriMatcher matcher;

    static String authority(android.content.Context c) {
        return c.getPackageName() + ".stickers";
    }

    @Override
    public boolean onCreate() {
        String a = authority(getContext());
        matcher = new UriMatcher(UriMatcher.NO_MATCH);
        matcher.addURI(a, "metadata", METADATA);
        matcher.addURI(a, "metadata/*", METADATA_ONE);
        matcher.addURI(a, "stickers/*", STICKERS);
        matcher.addURI(a, "stickers_asset/*/*", ASSET);
        return true;
    }

    private File root() {
        return new File(getContext().getFilesDir(), "stickers");
    }

    private JSONObject pack(String id) {
        try {
            if (!id.matches("[A-Za-z0-9_-]{1,64}")) return null;
            File f = new File(new File(root(), id), "pack.json");
            if (!f.exists()) return null;
            return new JSONObject(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    private static final String[] PACK_COLUMNS = {
            "sticker_pack_identifier", "sticker_pack_name", "sticker_pack_publisher", "sticker_pack_icon",
            "android_play_store_link", "ios_app_download_link", "sticker_pack_publisher_email",
            "sticker_pack_publisher_website", "sticker_pack_privacy_policy_website", "sticker_pack_license_agreement_website",
            "image_data_version", "whatsapp_will_not_cache_stickers", "animated_sticker_pack",
    };

    private void addPackRow(MatrixCursor c, String id, JSONObject p) {
        c.addRow(new Object[]{id, p.optString("name"), p.optString("publisher", "Carino"), p.optString("tray"),
                "", "", "", "", "", "", String.valueOf(p.optInt("version", 1)), 0, 0});
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        int m = matcher.match(uri);
        if (m == METADATA) {
            MatrixCursor c = new MatrixCursor(PACK_COLUMNS);
            File[] dirs = root().listFiles();
            if (dirs != null) for (File d : dirs) {
                JSONObject p = pack(d.getName());
                if (p != null) addPackRow(c, d.getName(), p);
            }
            return c;
        }
        if (m == METADATA_ONE) {
            MatrixCursor c = new MatrixCursor(PACK_COLUMNS);
            String id = uri.getLastPathSegment();
            JSONObject p = pack(id);
            if (p != null) addPackRow(c, id, p);
            return c;
        }
        if (m == STICKERS) {
            MatrixCursor c = new MatrixCursor(new String[]{"sticker_file_name", "sticker_emoji", "sticker_accessibility_text"});
            JSONObject p = pack(uri.getLastPathSegment());
            JSONArray list = p == null ? new JSONArray() : p.optJSONArray("stickers");
            if (list != null) for (int i = 0; i < list.length(); i++) {
                JSONObject s = list.optJSONObject(i);
                if (s != null) c.addRow(new Object[]{s.optString("file"), s.optString("emoji", "😀"), s.optString("label", "")});
            }
            return c;
        }
        throw new IllegalArgumentException("Unknown address");
    }

    @Override
    public AssetFileDescriptor openAssetFile(Uri uri, String mode) throws FileNotFoundException {
        if (matcher.match(uri) != ASSET || !"r".equals(mode)) throw new FileNotFoundException();
        List<String> seg = uri.getPathSegments();
        String id = seg.get(1), name = seg.get(2);
        if (!id.matches("[A-Za-z0-9_-]{1,64}") || !name.matches("[A-Za-z0-9_.-]{1,80}") || name.contains("..")) throw new FileNotFoundException();
        File f = new File(new File(root(), id), name);
        if (!f.exists()) throw new FileNotFoundException();
        return new AssetFileDescriptor(ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY), 0, f.length());
    }

    @Override
    public String getType(Uri uri) {
        int m = matcher.match(uri);
        if (m == ASSET) return uri.getLastPathSegment().endsWith(".png") ? "image/png" : "image/webp";
        return "vnd.android.cursor.dir/vnd." + authority(getContext());
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }
}
