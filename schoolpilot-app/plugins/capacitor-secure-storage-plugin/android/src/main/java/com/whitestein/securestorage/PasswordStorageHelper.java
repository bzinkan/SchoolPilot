package com.whitestein.securestorage;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.Key;
import java.security.KeyStore;
import java.util.Set;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class PasswordStorageHelper {

    static final String STORAGE_FORMAT_PREFIX = "sp-keystore-aes-gcm-v1:";

    private static final String PREFERENCES_FILE = "cap_sec";
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String KEY_ALGORITHM = KeyProperties.KEY_ALGORITHM_AES;
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int KEY_SIZE_BITS = 256;
    private static final int GCM_TAG_BITS = 128;
    private static final int EXPECTED_IV_BYTES = 12;

    private final SharedPreferences preferences;
    private final KeyStore keyStore;
    private final String keyAlias;
    private final String aadNamespace;

    PasswordStorageHelper(Context context) throws SecureStorageException {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            throw new SecureStorageException("Secure storage requires Android 7.0 or newer.");
        }

        Context appContext = context.getApplicationContext();
        preferences = appContext.getSharedPreferences(PREFERENCES_FILE, Context.MODE_PRIVATE);
        keyAlias = appContext.getPackageName() + "_cap_sec_aes_gcm_v1";
        aadNamespace = appContext.getPackageName() + ":";

        try {
            keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
            keyStore.load(null);
            ensureKeyExists();
        } catch (Exception exception) {
            throw new SecureStorageException("Android Keystore initialization failed.", exception);
        }
    }

    synchronized void setData(String storageKey, byte[] data) throws SecureStorageException {
        if (data == null) {
            throw new SecureStorageException("Secure storage data is required.");
        }

        final String encoded;
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, requireKey());
            cipher.updateAAD(aadFor(storageKey));
            byte[] ciphertext = cipher.doFinal(data);
            byte[] iv = cipher.getIV();
            if (iv == null || iv.length != EXPECTED_IV_BYTES) {
                throw new SecureStorageException("Android Keystore returned an invalid encryption IV.");
            }

            ByteBuffer payload = ByteBuffer.allocate(1 + iv.length + ciphertext.length);
            payload.put((byte) iv.length);
            payload.put(iv);
            payload.put(ciphertext);
            encoded = STORAGE_FORMAT_PREFIX + Base64.encodeToString(payload.array(), Base64.NO_WRAP);
        } catch (SecureStorageException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new SecureStorageException("Secure storage encryption failed.", exception);
        }

        if (!preferences.edit().putString(storageKey, encoded).commit()) {
            throw new SecureStorageException("Encrypted value could not be persisted.");
        }
    }

    synchronized byte[] getData(String storageKey) throws SecureStorageException {
        SecretKey key = requireKey();
        if (!preferences.contains(storageKey)) {
            return null;
        }

        final String encoded;
        try {
            encoded = preferences.getString(storageKey, null);
        } catch (ClassCastException exception) {
            removeUnreadableValue(storageKey);
            return null;
        }
        if (encoded == null || !encoded.startsWith(STORAGE_FORMAT_PREFIX)) {
            removeUnreadableValue(storageKey);
            return null;
        }

        final byte[] payload;
        try {
            payload = Base64.decode(encoded.substring(STORAGE_FORMAT_PREFIX.length()), Base64.NO_WRAP);
        } catch (IllegalArgumentException exception) {
            removeUnreadableValue(storageKey);
            return null;
        }
        if (payload.length < 1 + EXPECTED_IV_BYTES + (GCM_TAG_BITS / 8)) {
            removeUnreadableValue(storageKey);
            return null;
        }

        ByteBuffer buffer = ByteBuffer.wrap(payload);
        int ivLength = buffer.get() & 0xff;
        if (ivLength != EXPECTED_IV_BYTES || buffer.remaining() <= ivLength) {
            removeUnreadableValue(storageKey);
            return null;
        }

        byte[] iv = new byte[ivLength];
        buffer.get(iv);
        byte[] ciphertext = new byte[buffer.remaining()];
        buffer.get(ciphertext);

        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
            cipher.updateAAD(aadFor(storageKey));
            return cipher.doFinal(ciphertext);
        } catch (AEADBadTagException exception) {
            // Authentication failure proves the stored envelope is corrupt or
            // belongs to a retired format/key. Never publish it.
            removeUnreadableValue(storageKey);
            return null;
        } catch (Exception exception) {
            throw new SecureStorageException("Secure storage decryption failed.", exception);
        }
    }

    synchronized boolean contains(String storageKey) throws SecureStorageException {
        requireKey();
        return preferences.contains(storageKey);
    }

    synchronized String[] keys() throws SecureStorageException {
        requireKey();
        Set<String> keySet = preferences.getAll().keySet();
        return keySet.toArray(new String[0]);
    }

    synchronized void remove(String storageKey) throws SecureStorageException {
        requireKey();
        if (!preferences.edit().remove(storageKey).commit()) {
            throw new SecureStorageException("Encrypted value could not be removed.");
        }
    }

    synchronized void clear() throws SecureStorageException {
        requireKey();
        if (!preferences.edit().clear().commit()) {
            throw new SecureStorageException("Encrypted values could not be cleared.");
        }
    }

    synchronized void assertAvailable() throws SecureStorageException {
        requireKey();
    }

    private void ensureKeyExists() throws Exception {
        if (keyStore.containsAlias(keyAlias)) {
            requireKey();
            return;
        }

        KeyGenerator keyGenerator = KeyGenerator.getInstance(KEY_ALGORITHM, KEYSTORE_PROVIDER);
        KeyGenParameterSpec specification = new KeyGenParameterSpec.Builder(
            keyAlias,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(KEY_SIZE_BITS)
            .setRandomizedEncryptionRequired(true)
            .build();
        keyGenerator.init(specification);
        keyGenerator.generateKey();
        requireKey();
    }

    private SecretKey requireKey() throws SecureStorageException {
        try {
            Key key = keyStore.getKey(keyAlias, null);
            if (!(key instanceof SecretKey)) {
                throw new SecureStorageException("Android Keystore key is unavailable.");
            }
            return (SecretKey) key;
        } catch (SecureStorageException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new SecureStorageException("Android Keystore key access failed.", exception);
        }
    }

    private byte[] aadFor(String storageKey) {
        return (aadNamespace + storageKey).getBytes(StandardCharsets.UTF_8);
    }

    private void removeUnreadableValue(String storageKey) throws SecureStorageException {
        if (!preferences.edit().remove(storageKey).commit() || preferences.contains(storageKey)) {
            throw new SecureStorageException("Unreadable secure value could not be removed.");
        }
    }
}
