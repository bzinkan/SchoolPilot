"""Behavioral tests; run on the workstation, without the Bluefruit attached."""

import hashlib
import hmac
import importlib.util
from pathlib import Path
import unittest


LIGHT = Path(__file__).resolve().parents[1] / "light" / "indicator.py"
KEY = bytes(range(32))
NONCE = bytes.fromhex("a1a2a3a4a5a6a7a8")


def command(sequence=1, mask=1, ttl=30, nonce=NONCE, key=KEY, version=1):
    """Independent sender, using CPython's standard HMAC implementation."""
    header = bytes((0x50, version)) + sequence.to_bytes(4, "big") + bytes((mask, ttl))
    return header + hmac.new(key, nonce + header, hashlib.sha256).digest()[:8]


class LightProtocolTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("passpilot_light_indicator", LIGHT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.light = self.module.Indicator(KEY, category_bit=1)
        self.light.connect(NONCE)

    def test_literal_cross_language_frame_authenticates_and_expires_at_deadline(self):
        frame = bytes.fromhex("500100000001011e15654c3eea6ad07a")
        self.assertEqual(self.light.feed(frame, 10.0), 1)
        self.assertEqual(self.light.status(39.999), "occupied")
        self.assertEqual(self.light.status(40.0), "unavailable")

    def test_no_valid_state_at_startup_even_when_connected(self):
        self.assertEqual(self.module.Indicator(KEY).status(0), "unavailable")
        self.assertEqual(self.light.status(0), "unavailable")
        self.assertEqual(self.light.challenge(), b"H,a1a2a3a4a5a6a7a8\n")
        self.assertEqual(len(self.light.challenge()), 19)
        self.assertFalse(self.light.authenticated)

    def test_clear_requires_authentication_and_selected_category_only(self):
        self.assertEqual(self.light.feed(command(mask=6), 0), 1)
        self.assertEqual(self.light.status(1), "clear")
        for category, mask in ((2, 2), (4, 4)):
            light = self.module.Indicator(KEY, category_bit=category)
            light.connect(NONCE)
            light.feed(command(mask=mask), 0)
            self.assertEqual(light.status(1), "occupied")

    def test_every_split_of_frame_is_reassembled(self):
        frame = command()
        for split in range(1, 16):
            with self.subTest(split=split):
                self.light.connect(NONCE)
                self.assertEqual(self.light.feed(frame[:split], 0), 0)
                self.assertEqual(self.light.status(0), "unavailable")
                self.assertEqual(self.light.feed(frame[split:], 1), 1)
                self.assertEqual(self.light.status(2), "occupied")

    def test_bytewise_fragments_and_concatenated_commands(self):
        for byte in command():
            self.light.feed(bytes((byte,)), 0)
        self.assertEqual(self.light.status(1), "occupied")
        self.assertEqual(self.light.feed(command(2, 0) + command(3, 1), 2), 2)
        self.assertEqual(self.light.status(3), "occupied")
        self.assertEqual(self.light.sequence, 3)

    def test_forgery_replay_and_decreasing_sequence_cannot_extend_deadline(self):
        self.light.feed(command(2, 1, 5), 10)
        forged = bytearray(command(3, 0))
        forged[-1] ^= 1
        for invalid in (bytes(forged), command(2, 0), command(1, 0)):
            self.assertEqual(self.light.feed(invalid, 14), 0)
            self.assertEqual(self.light.status(14), "occupied")
            self.assertEqual(self.light.sequence, 2)
        self.assertEqual(self.light.status(15), "unavailable")

    def test_signed_invalid_fields_never_refresh_or_consume_sequence(self):
        self.light.feed(command(1, 0, 5), 10)
        for invalid in (command(2, 8), command(2, 1, 0), command(2, 1, 31),
                        command(2, 1, 255), command(2, version=2), command(0)):
            with self.subTest(frame=invalid.hex()[:16]):
                self.assertEqual(self.light.feed(invalid, 14), 0)
                self.assertEqual(self.light.sequence, 1)
                self.assertEqual(self.light.status(15), "unavailable")
        self.assertEqual(self.light.feed(command(2, 1, 1), 16), 1)
        self.assertEqual(self.light.status(16), "occupied")
        self.assertEqual(self.light.status(17), "unavailable")

    def test_disconnect_immediately_invalidates_and_old_nonce_is_rejected(self):
        self.light.feed(command(), 0)
        self.light.disconnect()
        self.assertEqual(self.light.status(1), "unavailable")
        self.assertEqual(self.light.feed(command(2), 1), 0)
        next_nonce = b"12345678"
        self.light.connect(next_nonce)
        self.assertFalse(self.light.authenticated)
        self.assertEqual(self.light.feed(command(), 2), 0)
        self.assertEqual(self.light.status(2), "unavailable")
        self.assertEqual(self.light.feed(command(nonce=next_nonce), 3), 1)
        self.assertEqual(self.light.sequence, 1)

    def test_garbage_resynchronizes_without_unbounded_buffer(self):
        self.assertEqual(self.light.feed(b"garbage\x50\x02\xff" + command(), 0), 1)
        self.assertEqual(self.light.status(1), "occupied")
        self.light.feed(b"\x50\x01" * 32, 20)
        self.assertLess(self.light.buffered_bytes, 16)
        self.assertEqual(self.light.status(30), "unavailable")
        self.assertEqual(self.light.feed(command(2, 0), 31), 1)
        self.assertEqual(self.light.status(31), "clear")

    def test_oversized_read_is_dropped_and_cannot_refresh_state(self):
        self.light.feed(command(ttl=5), 0)
        self.assertEqual(self.light.feed(command(2, 0) * 5, 4), 0)
        self.assertEqual(self.light.buffered_bytes, 0)
        self.assertEqual(self.light.status(5), "unavailable")

    def test_key_and_nonce_and_category_are_validated(self):
        for key in (b"", bytes(31), bytes(33)):
            with self.assertRaises(ValueError):
                self.module.Indicator(key)
        for category in (0, 3, 8):
            with self.assertRaises(ValueError):
                self.module.Indicator(KEY, category_bit=category)
        for nonce in (b"", bytes(7), bytes(9)):
            with self.assertRaises(ValueError):
                self.light.connect(nonce)

    def test_local_configuration_accepts_only_a_complete_secret_and_safe_name(self):
        config = {"PP_LIGHT_KEY_HEX": KEY.hex(), "PP_LIGHT_SUFFIX": "a1b2c3d4"}
        self.assertEqual(self.module.load_config(config.get), (KEY, "a1b2c3d4", 1))
        config["PP_LIGHT_CATEGORY_BIT"] = 4
        self.assertEqual(self.module.load_config(config.get)[2], 4)
        for name, bad in (("PP_LIGHT_KEY_HEX", "g" * 64), ("PP_LIGHT_KEY_HEX", "a" * 63),
                          ("PP_LIGHT_SUFFIX", "light 1"), ("PP_LIGHT_SUFFIX", "é"),
                          ("PP_LIGHT_SUFFIX", "toolong123"), ("PP_LIGHT_CATEGORY_BIT", 3),
                          ("PP_LIGHT_CATEGORY_BIT", True)):
            invalid = dict(config)
            invalid[name] = bad
            with self.subTest(name=name, bad=bad):
                with self.assertRaises(ValueError) as error:
                    self.module.load_config(invalid.get)
                self.assertNotIn(KEY.hex(), str(error.exception))

    def test_unavailable_pulses_white_and_category_colors_are_exact(self):
        self.assertEqual(self.module.color_for_status("clear", 1, 0), (0, 0, 0))
        for category, expected in ((1, (0, 0, 255)), (2, (255, 255, 0)), (4, (255, 0, 0))):
            self.assertEqual(self.module.color_for_status("occupied", category, 0), expected)
        low = self.module.color_for_status("unavailable", 1, 0)
        high = self.module.color_for_status("unavailable", 1, 1)
        self.assertEqual(low[0], low[1])
        self.assertEqual(high[0], high[2])
        self.assertGreater(high[0], low[0])


if __name__ == "__main__":
    unittest.main()
