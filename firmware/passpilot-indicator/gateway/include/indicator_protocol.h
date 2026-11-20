#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>

namespace pp {
using Hmac = bool (*)(const uint8_t[32], const uint8_t*, size_t, uint8_t[32]);
// Deliberately accept only the three-field integer object in protocol v1.
// No allocations, duplicate keys, coercions, escaped keys or trailing JSON.
inline bool parseState(const char* text, size_t length, uint8_t& mask) {
    if (!text || !length || length > 512) return false;
    size_t i = 0;
    const auto space = [&]() { while (i < length && (text[i] == ' ' || text[i] == '\t' || text[i] == '\r' || text[i] == '\n')) ++i; };
    const auto character = [&](char c) { space(); if (i >= length || text[i] != c) return false; ++i; return true; };
    if (!character('{')) return false;
    unsigned seen = 0, values[3] = {};
    for (unsigned field = 0; field < 3; ++field) {
        if (!character('"')) return false;
        const size_t start = i;
        while (i < length && text[i] != '"') {
            if (text[i] == '\\' || static_cast<unsigned char>(text[i]) < 32) return false;
            ++i;
        }
        if (i == length) return false;
        const size_t keyLength = i++ - start;
        unsigned index;
        if (keyLength == 7 && std::memcmp(text + start, "version", 7) == 0) index = 0;
        else if (keyLength == 4 && std::memcmp(text + start, "mask", 4) == 0) index = 1;
        else if (keyLength == 13 && std::memcmp(text + start, "maxAgeSeconds", 13) == 0) index = 2;
        else return false;
        if ((seen & (1u << index)) || !character(':')) return false;
        seen |= 1u << index;
        space();
        if (i >= length || text[i] < '0' || text[i] > '9') return false;
        const bool zero = text[i] == '0';
        unsigned value = static_cast<unsigned>(text[i++] - '0');
        while (i < length && text[i] >= '0' && text[i] <= '9') {
            if (zero || value > 100) return false;
            value = value * 10 + static_cast<unsigned>(text[i++] - '0');
        }
        values[index] = value;
        if (!character(field < 2 ? ',' : '}')) return false;
    }
    space();
    if (i != length || seen != 7 || values[0] != 1 || values[1] > 7 || values[2] != 30) return false;
    mask = static_cast<uint8_t>(values[1]);
    return true;
}
inline int hexDigit(char c) {
    return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
}
inline bool decodeKey(const char* hex, uint8_t key[32]) {
    if (!hex || std::strlen(hex) != 64) return false;
    for (size_t i = 0; i < 32; ++i) {
        const int hi = hexDigit(hex[2 * i]), lo = hexDigit(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) return false;
        key[i] = static_cast<uint8_t>((hi << 4) | lo);
    }
    return true;
}
class FreshState {
    bool valid_ = false;
    uint32_t received_ = 0;
    uint8_t mask_ = 0;
public:
    bool accept(const char* text, size_t length, uint32_t now) {
        uint8_t parsed;
        if (!parseState(text, length, parsed)) return false;
        mask_ = parsed;
        received_ = now;
        valid_ = true;
        return true;
    }
    uint8_t remaining(uint32_t now) {
        const uint32_t elapsed = now - received_;
        if (!valid_ || elapsed >= 30000) { valid_ = false; return 0; }
        return static_cast<uint8_t>((30000 - elapsed) / 1000);
    }
    uint8_t mask() const { return mask_; }
};
class ChallengeParser {
    char line_[18] = {};
    size_t length_ = 0;
    bool discard_ = false;
public:
    bool feed(char c, uint8_t nonce[8]) {
        if (c == '\n') {
            const bool valid = !discard_ && length_ == 18 && line_[0] == 'H' && line_[1] == ',';
            reset();
            if (!valid) return false;
            for (size_t i = 0; i < 8; ++i) {
                const int hi = hexDigit(line_[2 + 2 * i]), lo = hexDigit(line_[3 + 2 * i]);
                if (hi < 0 || lo < 0) return false;
                nonce[i] = static_cast<uint8_t>((hi << 4) | lo);
            }
            return true;
        }
        if (!discard_) {
            if (length_ == sizeof(line_)) discard_ = true;
            else line_[length_++] = c;
        }
        return false;
    }
    void reset() { length_ = 0; discard_ = false; }
};
class Connection {
    bool ready_ = false;
    uint8_t nonce_[8] = {};
    uint32_t sequence_ = 0;
public:
    void reset() { ready_ = false; sequence_ = 0; }
    bool challenge(const uint8_t nonce[8]) {
        if (ready_ && std::memcmp(nonce_, nonce, 8) == 0) return false;
        std::memcpy(nonce_, nonce, 8);
        sequence_ = 0;
        ready_ = true;
        return true;
    }
    bool ready() const { return ready_; }
    bool frame(const uint8_t key[32], uint8_t mask, uint8_t ttl, Hmac hmac, uint8_t out[16]) {
        if (!ready_ || mask > 7 || ttl == 0 || ttl > 30 || !hmac || sequence_ == std::numeric_limits<uint32_t>::max()) return false;
        const uint32_t sequence = sequence_ + 1;
        uint8_t message[16];
        std::memcpy(message, nonce_, 8);
        uint8_t* header = message + 8;
        header[0] = 0x50; header[1] = 1;
        for (size_t i = 0; i < 4; ++i) header[2 + i] = static_cast<uint8_t>(sequence >> (24 - 8 * i));
        header[6] = mask; header[7] = ttl;
        uint8_t tag[32];
        if (!hmac(key, message, sizeof(message), tag)) return false;
        std::memcpy(out, header, 8);
        std::memcpy(out + 8, tag, 8);
        sequence_ = sequence;
        return true;
    }
};
}
