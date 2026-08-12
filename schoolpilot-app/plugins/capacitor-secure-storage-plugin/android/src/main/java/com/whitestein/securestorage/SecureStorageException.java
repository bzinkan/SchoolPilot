package com.whitestein.securestorage;

final class SecureStorageException extends Exception {

    SecureStorageException(String message) {
        super(message);
    }

    SecureStorageException(String message, Throwable cause) {
        super(message, cause);
    }
}
