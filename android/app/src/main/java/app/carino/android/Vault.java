package app.carino.android;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.ByteBuffer;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Seals Carino's master key with a key held by the Android Keystore. That key never leaves the
 * Keystore (it can't be read or exported, even by Carino), and it isn't part of any backup, so a
 * copy of the app's storage on another device can't open the saved credentials.
 */
final class Vault {
    private static final String ALIAS = "carino_vault_v1";

    private Vault() {}

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry e = ks.getEntry(ALIAS, null);
        if (e instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) e).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return g.generateKey();
    }

    /** base64 in, base64(iv | ciphertext+tag) out. */
    static String seal(String plainB64) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = c.getIV();
        byte[] body = c.doFinal(Base64.decode(plainB64, Base64.NO_WRAP));
        return Base64.encodeToString(ByteBuffer.allocate(iv.length + body.length).put(iv).put(body).array(), Base64.NO_WRAP);
    }

    static String open(String sealedB64) throws Exception {
        byte[] all = Base64.decode(sealedB64, Base64.NO_WRAP);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, 12));
        return Base64.encodeToString(c.doFinal(all, 12, all.length - 12), Base64.NO_WRAP);
    }
}
