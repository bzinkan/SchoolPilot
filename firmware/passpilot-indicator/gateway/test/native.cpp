#include "indicator_protocol.h"
#include <cassert>
#include <cstring>
#include <iostream>
#include <string>

static bool checkedHmac(const uint8_t key[32], const uint8_t* message, size_t length, uint8_t tag[32]) {
    assert(key[0] == 0 && key[31] == 31);
    assert(length == 16);
    const uint8_t nonce[] = {0xa1,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,0xa8};
    assert(std::memcmp(message, nonce, 8) == 0);
    assert(message[8] == 0x50 && message[9] == 1);
    // Independent Python stdlib HMAC-SHA256 fixture for the first frame.
    const uint8_t known[] = {0x15,0x65,0x4c,0x3e,0xea,0x6a,0xd0,0x7a};
    std::memset(tag, 0, 32);
    std::memcpy(tag, known, 8);
    return true;
}

int main() {
    uint8_t mask = 99;
    const char* good = "{\"version\":1,\"mask\":1,\"maxAgeSeconds\":30}";
    assert(pp::parseState(good, std::strlen(good), mask) && mask == 1);
    for (const auto* bad : {"{}", "{\"version\":2,\"mask\":0,\"maxAgeSeconds\":30}",
         "{\"version\":1,\"mask\":8,\"maxAgeSeconds\":30}",
         "{\"version\":1,\"mask\":-1,\"maxAgeSeconds\":30}",
         "{\"version\":1,\"mask\":true,\"maxAgeSeconds\":30}",
         "{\"version\":1,\"mask\":\"1\",\"maxAgeSeconds\":30}",
         "{\"version\":1,\"mask\":1.0,\"maxAgeSeconds\":30}",
         "{\"version\":1,\"mask\":0,\"maxAgeSeconds\":31}",
         "{\"version\":1,\"mask\":0,\"maxAgeSeconds\":30,\"x\":1}",
         "{\"version\":1,\"mask\":0,\"mask\":1,\"maxAgeSeconds\":30}",
         "{\"version\":1,\"mask\":0,\"maxAgeSeconds\":30} garbage",
         "{\"version\":1,\"mask\":01,\"maxAgeSeconds\":30}"}) {
        mask = 99;
        assert(!pp::parseState(bad, std::strlen(bad), mask) && mask == 99);
    }
    const std::string padded(513, ' ');
    assert(!pp::parseState(padded.c_str(), padded.size(), mask));
    const char* reordered = " \n{ \"maxAgeSeconds\" : 30, \"mask\":7, \"version\":1 }\r\n";
    assert(pp::parseState(reordered, std::strlen(reordered), mask) && mask == 7);
    for (unsigned value = 0; value <= 7; ++value) {
        const std::string text = "{\"version\":1,\"mask\":" + std::to_string(value) + ",\"maxAgeSeconds\":30}";
        assert(pp::parseState(text.c_str(), text.size(), mask) && mask == value);
    }

    pp::FreshState state;
    assert(state.remaining(100) == 0);
    assert(state.accept(good, std::strlen(good), 100));
    assert(state.mask() == 1 && state.remaining(100) == 30);
    assert(state.remaining(101) == 29 && state.remaining(25100) == 5);
    assert(!state.accept("invalid", 7, 25100));
    assert(state.remaining(29100) == 1 && state.remaining(29101) == 0);
    assert(state.remaining(30100) == 0 && state.remaining(99999) == 0);
    assert(state.remaining(100) == 0); // Expired state cannot resurrect on a full millis wrap.
    assert(state.accept(good, std::strlen(good), 0xfffffff0));
    assert(state.remaining(0xfffffff0) == 30 && state.remaining(9984) == 20);
    assert(state.remaining(29984) == 0);

    uint8_t key[32];
    assert(pp::decodeKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", key));
    assert(!pp::decodeKey("bad", key));
    assert(!pp::decodeKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1F", key));
    uint8_t nonce[8];
    pp::ChallengeParser parser;
    const char* challenge = "H,a1a2a3a4a5a6a7a8\n";
    for (size_t i = 0; i < 18; ++i) assert(!parser.feed(challenge[i], nonce));
    assert(parser.feed('\n', nonce));
    assert(nonce[0] == 0xa1 && nonce[7] == 0xa8);
    for (const auto* bad : {"H,A1a2a3a4a5a6a7a8\n", "H,a1a2\n", "H,a1a2a3a4a5a6a7a8extra\n"}) {
        for (const char* p = bad; *p; ++p) assert(!parser.feed(*p, nonce));
    }
    bool completed = false;
    for (const char* p = challenge; *p; ++p) completed = parser.feed(*p, nonce) || completed;
    assert(completed);
    pp::Connection connection;
    uint8_t frame[16];
    assert(!connection.frame(key, 1, 30, checkedHmac, frame));
    assert(connection.challenge(nonce) && connection.ready());
    assert(connection.frame(key, 1, 30, checkedHmac, frame));
    const uint8_t expected[] = {0x50,1,0,0,0,1,1,30,0x15,0x65,0x4c,0x3e,0xea,0x6a,0xd0,0x7a};
    assert(std::memcmp(frame, expected, 16) == 0);
    assert(!connection.challenge(nonce)); // Repeated greeting must not reset sequence.
    assert(connection.frame(key, 1, 25, checkedHmac, frame));
    assert(frame[5] == 2 && frame[7] == 25);
    for (unsigned sequence = 3; sequence <= 256; ++sequence) {
        assert(connection.frame(key, 1, 25, checkedHmac, frame));
    }
    assert(frame[2] == 0 && frame[3] == 0 && frame[4] == 1 && frame[5] == 0);
    assert(!connection.frame(key, 8, 30, checkedHmac, frame));
    assert(!connection.frame(key, 1, 0, checkedHmac, frame));
    assert(!connection.frame(key, 1, 31, checkedHmac, frame));
    connection.reset();
    assert(!connection.ready());
    assert(state.remaining(29984) == 0); // BLE lifecycle never refreshes HTTP state.
    std::cout << "Gateway protocol/state tests passed\n";
}
