package com.whitestein.securestorage;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "SecureStoragePlugin")
public final class SecureStoragePluginPlugin extends Plugin {

    private PasswordStorageHelper passwordStorageHelper;
    private Exception initializationFailure;

    @Override
    public void load() {
        super.load();
        try {
            passwordStorageHelper = new PasswordStorageHelper(getContext());
        } catch (Exception exception) {
            initializationFailure = exception;
            passwordStorageHelper = null;
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        try {
            String key = requireKey(call);
            String value = call.getString("value");
            if (value == null) {
                throw new SecureStorageException("A secure storage value is required.");
            }
            requireStorage().setData(key, value.getBytes(StandardCharsets.UTF_8));
            call.resolve(success());
        } catch (Exception exception) {
            reject(call, "write", exception);
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        try {
            byte[] buffer = requireStorage().getData(requireKey(call));
            if (buffer == null) {
                call.reject("Item with given key does not exist", "SECURE_STORAGE_ITEM_NOT_FOUND");
                return;
            }
            JSObject result = new JSObject();
            result.put("value", new String(buffer, StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception exception) {
            reject(call, "read", exception);
        }
    }

    @PluginMethod
    public void keys(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("value", JSArray.from(requireStorage().keys()));
            call.resolve(result);
        } catch (Exception exception) {
            reject(call, "list", exception);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            String key = requireKey(call);
            PasswordStorageHelper storage = requireStorage();
            if (!storage.contains(key)) {
                call.reject("Item with given key does not exist", "SECURE_STORAGE_ITEM_NOT_FOUND");
                return;
            }
            storage.remove(key);
            call.resolve(success());
        } catch (Exception exception) {
            reject(call, "remove", exception);
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        try {
            requireStorage().clear();
            call.resolve(success());
        } catch (Exception exception) {
            reject(call, "clear", exception);
        }
    }

    @PluginMethod
    public void getPlatform(PluginCall call) {
        try {
            requireStorage().assertAvailable();
            JSObject result = new JSObject();
            result.put("value", "android");
            call.resolve(result);
        } catch (Exception exception) {
            reject(call, "initialize", exception);
        }
    }

    private PasswordStorageHelper requireStorage() throws SecureStorageException {
        if (passwordStorageHelper == null) {
            throw new SecureStorageException("Secure storage is unavailable.", initializationFailure);
        }
        return passwordStorageHelper;
    }

    private static String requireKey(PluginCall call) throws SecureStorageException {
        String key = call.getString("key");
        if (key == null || key.trim().isEmpty()) {
            throw new SecureStorageException("A secure storage key is required.");
        }
        return key;
    }

    private static JSObject success() {
        JSObject result = new JSObject();
        result.put("value", true);
        return result;
    }

    private static void reject(PluginCall call, String operation, Exception exception) {
        call.reject("Secure storage " + operation + " failed.", "SECURE_STORAGE_FAILED", exception);
    }
}
