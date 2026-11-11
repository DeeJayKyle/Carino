package app.carino.android;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.UUID;

/**
 * Folders the user picked in Android's own folder picker (one at a time; each can be revoked).
 * Paths are names inside the picked folder, walked from its top: there's no way to name anything
 * outside it. Changes are only made after the user approved them in the app; a delete first keeps a
 * checked copy in Carino's private storage so it can be undone.
 */
final class LocalFolders {
    private LocalFolders() {}

    static final int PICK = 31;

    static Intent pickIntent() {
        return new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
    }

    /** Keeps the permission across restarts; returns {root, label}. */
    static JSONObject picked(Context ctx, Uri tree) throws Exception {
        ctx.getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        String docId = DocumentsContract.getTreeDocumentId(tree);
        String label = docId.contains(":") ? docId.substring(docId.lastIndexOf(':') + 1) : docId;
        if (label.contains("/")) label = label.substring(label.lastIndexOf('/') + 1);
        return new JSONObject().put("root", tree.toString()).put("label", label.isEmpty() ? "Phone storage" : label);
    }

    static void forget(Context ctx, String root) {
        try {
            ctx.getContentResolver().releasePersistableUriPermission(Uri.parse(root), Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception ignored) {
        }
    }

    private static String[] parts(String rel) throws Exception {
        if (rel == null || rel.isEmpty()) return new String[0];
        String[] p = rel.split("/");
        for (String s : p) if (s.isEmpty() || s.equals(".") || s.equals("..")) throw new Exception("That path is outside the folder.");
        return p;
    }

    private static Uri tree(Context ctx, String root) throws Exception {
        Uri t = Uri.parse(root);
        boolean granted = false;
        for (android.content.UriPermission p : ctx.getContentResolver().getPersistedUriPermissions()) if (p.getUri().equals(t)) granted = true;
        if (!granted) throw new Exception("That folder wasn't chosen for Carino.");
        return t;
    }

    /** The document id of a child by name, or null. */
    private static String child(ContentResolver cr, Uri tree, String parentId, String name) {
        Uri kids = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        try (Cursor c = cr.query(kids, new String[]{Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            while (c != null && c.moveToNext()) if (name.equals(c.getString(1))) return c.getString(0);
        }
        return null;
    }

    private static String resolve(Context ctx, Uri tree, String rel, boolean create) throws Exception {
        ContentResolver cr = ctx.getContentResolver();
        String id = DocumentsContract.getTreeDocumentId(tree);
        for (String name : parts(rel)) {
            String next = child(cr, tree, id, name);
            if (next == null) {
                if (!create) throw new Exception("Not found: " + rel);
                Uri made = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, id), Document.MIME_TYPE_DIR, name);
                if (made == null) throw new Exception("Couldn't make the folder " + name);
                next = DocumentsContract.getDocumentId(made);
            }
            id = next;
        }
        return id;
    }

    static JSONArray list(Context ctx, String root, String rel) throws Exception {
        Uri t = tree(ctx, root);
        String id = resolve(ctx, t, rel, false);
        JSONArray out = new JSONArray();
        Uri kids = DocumentsContract.buildChildDocumentsUriUsingTree(t, id);
        try (Cursor c = ctx.getContentResolver().query(kids, new String[]{Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED}, null, null, null)) {
            while (c != null && c.moveToNext()) {
                String name = c.getString(0);
                if (name == null || name.startsWith(".")) continue;
                out.put(new JSONObject().put("rel", rel.isEmpty() ? name : rel + "/" + name).put("name", name)
                        .put("dir", Document.MIME_TYPE_DIR.equals(c.getString(1))).put("size", c.getLong(2)).put("mtime", String.valueOf(c.getLong(3))));
            }
        }
        return out;
    }

    private static byte[] readAll(InputStream in, long max) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        long total = 0;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > max) throw new Exception("That file is too large to read.");
            b.write(buf, 0, n);
        }
        return b.toByteArray();
    }

    private static Uri doc(Uri t, String id) {
        return DocumentsContract.buildDocumentUriUsingTree(t, id);
    }

    static byte[] read(Context ctx, String root, String rel, long max) throws Exception {
        Uri t = tree(ctx, root);
        try (InputStream in = ctx.getContentResolver().openInputStream(doc(t, resolve(ctx, t, rel, false)))) {
            return readAll(in, max);
        }
    }

    static String sha256(byte[] b) throws Exception {
        StringBuilder s = new StringBuilder();
        for (byte x : MessageDigest.getInstance("SHA-256").digest(b)) s.append(String.format("%02x", x));
        return s.toString();
    }

    private static String parentOf(String rel) {
        int i = rel.lastIndexOf('/');
        return i < 0 ? "" : rel.substring(0, i);
    }

    private static String nameOf(String rel) {
        return rel.substring(rel.lastIndexOf('/') + 1);
    }

    static void rename(Context ctx, String root, String rel, String toRel) throws Exception {
        Uri t = tree(ctx, root);
        ContentResolver cr = ctx.getContentResolver();
        parts(toRel);
        try {
            resolve(ctx, t, toRel, false);
            throw new IllegalStateException("There is already a file at " + toRel + ".");
        } catch (IllegalStateException e) {
            throw e;
        } catch (Exception ignored) {
            // Good: nothing there yet.
        }
        String id = resolve(ctx, t, rel, false);
        Uri d = doc(t, id);
        if (!parentOf(rel).equals(parentOf(toRel))) {
            String from = resolve(ctx, t, parentOf(rel), false);
            String to = resolve(ctx, t, parentOf(toRel), true);
            d = DocumentsContract.moveDocument(cr, d, doc(t, from), doc(t, to));
            if (d == null) throw new Exception("Couldn't move " + rel);
        }
        if (!nameOf(rel).equals(nameOf(toRel)) && DocumentsContract.renameDocument(cr, d, nameOf(toRel)) == null) throw new Exception("Couldn't rename " + rel);
    }

    static String deleteWithRecovery(Context ctx, String root, String rel, String sha) throws Exception {
        byte[] b = read(ctx, root, rel, 200L * 1024 * 1024);
        if (!sha256(b).equals(sha)) throw new Exception(rel + " changed since it was checked. Look again before deleting it.");
        File dir = new File(ctx.getFilesDir(), "recovery");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("No room for a safety copy.");
        File copy = new File(dir, UUID.randomUUID() + ".bin");
        try (OutputStream o = new FileOutputStream(copy)) {
            o.write(b);
        }
        try (InputStream in = new FileInputStream(copy)) {
            if (!sha256(readAll(in, Long.MAX_VALUE)).equals(sha)) {
                copy.delete();
                throw new Exception("The safety copy didn't check out, so nothing was deleted.");
            }
        }
        Uri t = tree(ctx, root);
        if (!DocumentsContract.deleteDocument(ctx.getContentResolver(), doc(t, resolve(ctx, t, rel, false)))) throw new Exception("Couldn't delete " + rel);
        return copy.getAbsolutePath();
    }

    static void restore(Context ctx, String root, String rel, String recovery, String sha) throws Exception {
        File copy = new File(recovery);
        File dir = new File(ctx.getFilesDir(), "recovery");
        if (!copy.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator)) throw new Exception("That isn't one of Carino's saved copies.");
        byte[] b;
        try (InputStream in = new FileInputStream(copy)) {
            b = readAll(in, Long.MAX_VALUE);
        }
        if (!sha256(b).equals(sha)) throw new Exception("The saved copy is damaged; it can't be restored.");
        Uri t = tree(ctx, root);
        String parent = resolve(ctx, t, parentOf(rel), true);
        String ext = MimeTypeMap.getFileExtensionFromUrl(nameOf(rel));
        String mime = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        Uri made = DocumentsContract.createDocument(ctx.getContentResolver(), doc(t, parent), mime == null ? "application/octet-stream" : mime, nameOf(rel));
        if (made == null) throw new Exception("Couldn't put the file back.");
        try (OutputStream o = ctx.getContentResolver().openOutputStream(made)) {
            o.write(b);
        }
        copy.delete();
    }

    /** Writes a new file (approved in the app first); never replaces one that's there. */
    static void write(Context ctx, String root, String rel, byte[] data) throws Exception {
        Uri t = tree(ctx, root);
        parts(rel);
        try {
            resolve(ctx, t, rel, false);
            throw new IllegalStateException("There is already a file at " + rel + ".");
        } catch (IllegalStateException e) {
            throw e;
        } catch (Exception ignored) {
            // Good: nothing there yet.
        }
        String parent = resolve(ctx, t, parentOf(rel), true);
        String ext = MimeTypeMap.getFileExtensionFromUrl(nameOf(rel));
        String mime = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        Uri made = DocumentsContract.createDocument(ctx.getContentResolver(), doc(t, parent), mime == null ? "application/octet-stream" : mime, nameOf(rel));
        if (made == null) throw new Exception("Couldn't create " + rel);
        try (OutputStream o = ctx.getContentResolver().openOutputStream(made)) {
            o.write(data);
        }
    }

    /** Opens a file with the app the user normally uses for it (never an app package). */
    static void open(Context ctx, String root, String rel) throws Exception {
        if (rel.toLowerCase().endsWith(".apk")) throw new Exception("Carino doesn't open app packages.");
        Uri t = tree(ctx, root);
        Uri d = doc(t, resolve(ctx, t, rel, false));
        String mime = ctx.getContentResolver().getType(d);
        Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(d, mime == null ? "*/*" : mime)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(Intent.createChooser(i, nameOf(rel)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    static String b64(byte[] b) {
        return Base64.encodeToString(b, Base64.NO_WRAP);
    }
}
