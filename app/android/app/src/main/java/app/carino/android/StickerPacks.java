package app.carino.android;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Saves a sticker pack Carino made and asks WhatsApp to add it (the user confirms in WhatsApp). */
class StickerPacks {
    static final int ADD_PACK = 51;

    /** pack: {id, name, tray: base64 png, stickers: [{data: base64 webp, emoji}]} */
    static String add(Activity a, JSONObject pack) throws Exception {
        String id = pack.getString("id");
        if (!id.matches("[A-Za-z0-9_-]{1,64}")) throw new IllegalArgumentException("Bad pack id");
        JSONArray list = pack.getJSONArray("stickers");
        if (list.length() < 3 || list.length() > 30) throw new IllegalArgumentException("A pack needs 3 to 30 stickers");
        File dir = new File(new File(a.getFilesDir(), "stickers"), id);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        write(new File(dir, "tray.png"), Base64.decode(pack.getString("tray"), Base64.DEFAULT));
        JSONArray meta = new JSONArray();
        for (int i = 0; i < list.length(); i++) {
            JSONObject s = list.getJSONObject(i);
            String file = "s" + (i + 1) + ".webp";
            write(new File(dir, file), Base64.decode(s.getString("data"), Base64.DEFAULT));
            meta.put(new JSONObject().put("file", file).put("emoji", s.optString("emoji", "😀")));
        }
        JSONObject json = new JSONObject().put("name", pack.getString("name")).put("publisher", "Carino").put("tray", "tray.png").put("version", 1).put("stickers", meta);
        write(new File(dir, "pack.json"), json.toString().getBytes(StandardCharsets.UTF_8));

        Intent intent = new Intent("com.whatsapp.intent.action.ENABLE_STICKER_PACK");
        intent.putExtra("sticker_pack_id", id);
        intent.putExtra("sticker_pack_authority", StickerProvider.authority(a));
        intent.putExtra("sticker_pack_name", pack.getString("name"));
        try {
            a.startActivityForResult(intent, ADD_PACK);
            return "started";
        } catch (ActivityNotFoundException e) {
            return "no_whatsapp";
        }
    }

    private static void write(File f, byte[] data) throws Exception {
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(data);
        }
    }
}
