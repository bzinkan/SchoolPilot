"""Circuit Playground Bluefruit #4333, CircuitPython 10.3.2.

Copy this file and indicator.py to CIRCUITPY after installing the pinned libraries.
settings.toml is generated locally; never put credentials in this source file.
"""

import os
import time

import board
import neopixel

from indicator import Indicator, MAX_READ, color_for_status, load_config


pixels = neopixel.NeoPixel(board.NEOPIXEL, 10, brightness=0.10, auto_write=False)


def display(status, category, now):
    pixels.fill(color_for_status(status, category, now))
    pixels.show()


def fault():
    # Deliberately omit exception text: it must never reveal local settings.
    print("PassPilot light unavailable. Check the installation, then press RESET.")
    while True:
        display("unavailable", 1, time.monotonic())
        time.sleep(0.05)


def run():
    from adafruit_ble import BLERadio
    from adafruit_ble.advertising.standard import ProvideServicesAdvertisement
    from adafruit_ble.services.nordic import UARTService

    key, suffix, category = load_config(os.getenv)
    light = Indicator(key, category_bit=category)
    ble = BLERadio()
    ble.name = "PP-Light-" + suffix
    uart = UARTService()
    advertisement = ProvideServicesAdvertisement(uart)
    # The 128-bit service UUID is in the advertising packet. BLERadio adds the
    # full device name to a scan response; the gateway therefore scans actively.
    peer = None
    advertising = False
    next_challenge = 0.0

    while True:
        now = time.monotonic()
        if peer is not None and not peer.connected:
            light.disconnect()
            uart.reset_input_buffer()
            peer = None
            advertising = False
            display("unavailable", category, now)

        if peer is None and ble.connected:
            peer = ble.connections[0]
            advertising = False
            uart.reset_input_buffer()
            # nRF52840's hardware-backed os.urandom is required. Never substitute
            # random, a timestamp, a fixed value, or a persisted old nonce.
            light.connect(os.urandom(8))
            next_challenge = now

        if peer is None:
            if not advertising:
                ble.start_advertising(advertisement, interval=0.25)
                advertising = True
        else:
            # Bounded reads handle both fragmented writes and queued frames.
            waiting = uart.in_waiting
            if waiting:
                received = uart.read(min(waiting, MAX_READ))
                if received:
                    light.feed(received, time.monotonic())
            if not light.authenticated and now >= next_challenge:
                uart.write(light.challenge())
                next_challenge = time.monotonic() + 2.0

        display(light.status(time.monotonic()), category, time.monotonic())
        time.sleep(0.05)


try:
    run()
except Exception:
    fault()
