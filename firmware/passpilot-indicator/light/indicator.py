"""Small CircuitPython/CPython state machine for the PassPilot light protocol.

No board, Bluetooth, Wi-Fi or student data dependencies. The hardware loop supplies
fresh nonces and monotonic timestamps. See ../PROTOCOL.md for the wire contract.
"""

import binascii
import hashlib


FRAME_SIZE = 16
MAX_READ = 64
COLORS = {1: (0, 0, 255), 2: (255, 255, 0), 4: (255, 0, 0)}


def load_config(getenv):
    """Read only the three local settings, without including secrets in errors."""
    encoded = getenv("PP_LIGHT_KEY_HEX")
    suffix = getenv("PP_LIGHT_SUFFIX")
    category = getenv("PP_LIGHT_CATEGORY_BIT", 1)
    if not isinstance(encoded, str) or len(encoded) != 64:
        raise ValueError("Light configuration is invalid")
    if any(c not in "0123456789abcdefABCDEF" for c in encoded):
        raise ValueError("Light configuration is invalid")
    if not isinstance(suffix, str) or not 1 <= len(suffix) <= 8:
        raise ValueError("Light configuration is invalid")
    if any(c not in "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" for c in suffix):
        raise ValueError("Light configuration is invalid")
    if isinstance(category, str) and category in ("1", "2", "4"):
        category = int(category)
    if type(category) is not int or category not in COLORS:
        raise ValueError("Light configuration is invalid")
    return binascii.unhexlify(encoded), suffix, category


def color_for_status(status, category_bit, now):
    """Unavailable is a two-second white pulse; global brightness is set by code.py."""
    if status == "clear":
        return (0, 0, 0)
    if status == "occupied":
        return COLORS[category_bit]
    phase = now % 2.0
    wave = phase if phase <= 1.0 else 2.0 - phase
    level = 12 + int(108 * wave)
    return (level, level, level)


class Indicator:
    def __init__(self, key, category_bit=1):
        if not isinstance(key, (bytes, bytearray)) or len(key) != 32:
            raise ValueError("A 32-byte light key is required")
        if category_bit not in COLORS:
            raise ValueError("Light category must be 1, 2 or 4")
        # HMAC-SHA256 block size is 64. Our protocol key is always 32 bytes.
        block = bytes(key) + bytes(32)
        self._inner_pad = bytes(b ^ 0x36 for b in block)
        self._outer_pad = bytes(b ^ 0x5C for b in block)
        self.category_bit = category_bit
        self.disconnect()

    @property
    def buffered_bytes(self):
        return len(self._buffer)

    @property
    def authenticated(self):
        return self.sequence != 0

    def disconnect(self):
        self._nonce = None
        self._buffer = bytearray()
        self.sequence = 0
        self.mask = 0
        self._deadline = None

    def connect(self, nonce):
        if not isinstance(nonce, (bytes, bytearray)) or len(nonce) != 8:
            raise ValueError("An 8-byte random challenge is required")
        self.disconnect()
        self._nonce = bytes(nonce)

    def challenge(self):
        if self._nonce is None:
            return None
        return b"H," + binascii.hexlify(self._nonce) + b"\n"

    def status(self, now):
        if self._nonce is None or self._deadline is None or now >= self._deadline:
            return "unavailable"
        return "occupied" if self.mask & self.category_bit else "clear"

    def _tag(self, header):
        # CircuitPython's native API is new("sha256", data), not sha256(data).
        inner = hashlib.new("sha256", self._inner_pad + self._nonce + header).digest()
        return hashlib.new("sha256", self._outer_pad + inner).digest()[:8]

    def _accept(self, frame, now):
        sequence = (frame[2] << 24) | (frame[3] << 16) | (frame[4] << 8) | frame[5]
        mask, ttl = frame[6], frame[7]
        if sequence <= self.sequence or mask > 7 or not 1 <= ttl <= 30:
            return False
        expected = self._tag(frame[:8])
        mismatch = 0
        for i in range(8):
            mismatch |= frame[i + 8] ^ expected[i]
        if mismatch:
            return False
        self.sequence = sequence
        self.mask = mask
        self._deadline = now + ttl
        return True

    def feed(self, data, now):
        """Handle one <=64-byte UART read; retain at most 15 partial-frame bytes.

        Garbage and invalid frames slide by a byte to find the next authenticated
        frame. Oversized reads are dropped completely, never extending freshness.
        The board adapter reads at most MAX_READ, independent of BLE write sizes.
        """
        if self._nonce is None:
            return 0
        if len(data) > MAX_READ:
            self._buffer = bytearray()
            return 0
        self._buffer.extend(data)
        accepted = 0
        offset = 0
        length = len(self._buffer)
        # CircuitPython allows slicing bytearray but does not support deletion.
        while length - offset >= 2:
            if self._buffer[offset] != 0x50 or self._buffer[offset + 1] != 1:
                offset += 1
                continue
            if length - offset < FRAME_SIZE:
                break
            if self._accept(bytes(self._buffer[offset:offset + FRAME_SIZE]), now):
                offset += FRAME_SIZE
                accepted += 1
            else:
                offset += 1
        # A single leftover byte is useful only when it could begin a frame.
        if length - offset == 1 and self._buffer[offset] != 0x50:
            offset += 1
        if offset:
            self._buffer = self._buffer[offset:]
        return accepted
