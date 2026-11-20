#include <Arduino.h>
#include <HTTPClient.h>
#include <NimBLEDevice.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <atomic>
#include <ctime>
#include <esp_sntp.h>
#include <mbedtls/md.h>
#include "indicator_protocol.h"

#ifdef PP_HAS_LOCAL_CONFIG
#include "../include/config.h"
#else
#include "config.example.h"
#endif

namespace {
constexpr const char* SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
constexpr const char* RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
constexpr const char* TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
constexpr uint32_t POLL_MS = 5000;
constexpr uint32_t SEND_MS = 5000;
constexpr uint32_t RETRY_MS = 5000;

pp::FreshState state;
pp::Connection connection;
pp::ChallengeParser parser;
uint8_t bleKey[32];
bool configured = false;
bool clockSynchronized = false;
uint32_t lastPoll = 0, lastSend = 0, lastConnect = 0, connectedAt = 0;
bool sent = false;
NimBLEClient* client = nullptr;
NimBLERemoteCharacteristic* writer = nullptr;
struct Notification { uint8_t size; uint8_t data[20]; };
QueueHandle_t notifications = nullptr;
std::atomic<bool> notificationOverflow{false};

bool alphanumeric(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}

bool configurationValid() {
    if (!*PP_WIFI_SSID || std::strlen(PP_WIFI_SSID) > 32 || std::strlen(PP_WIFI_PASSWORD) > 63 ||
        !pp::decodeKey(PP_BLE_KEY_HEX, bleKey)) return false;
    const size_t nameLength = std::strlen(PP_LIGHT_NAME);
    if (nameLength < 10 || nameLength > 17 || std::strncmp(PP_LIGHT_NAME, "PP-Light-", 9) != 0) return false;
    for (size_t i = 9; i < nameLength; ++i) if (!alphanumeric(PP_LIGHT_NAME[i])) return false;
    if (std::strlen(PP_API_TOKEN) != 47 || std::strncmp(PP_API_TOKEN, "ppi_", 4) != 0) return false;
    for (size_t i = 4; i < 47; ++i) if (!alphanumeric(PP_API_TOKEN[i]) && PP_API_TOKEN[i] != '-' && PP_API_TOKEN[i] != '_') return false;
    // A single fixed HTTPS endpoint; forbid URL credentials, redirects and header injection.
    if (std::strncmp(PP_API_URL, "https://", 8) != 0 || std::strlen(PP_API_URL) > 255) return false;
    const char* path = std::strchr(PP_API_URL + 8, '/');
    if (!path || path == PP_API_URL + 8 || std::strcmp(path, "/api/passpilot/indicators/state") != 0) return false;
    for (const char* p = PP_API_URL + 8; p < path; ++p) {
        if (!alphanumeric(*p) && *p != '.' && *p != '-') return false;
    }
    return std::strstr(PP_ROOT_CA_PEM, "-----BEGIN CERTIFICATE-----") &&
           std::strstr(PP_ROOT_CA_PEM, "-----END CERTIFICATE-----");
}

bool clockValid() {
    const int64_t epoch = static_cast<int64_t>(std::time(nullptr));
    if (sntp_get_sync_status() == SNTP_SYNC_STATUS_COMPLETED) clockSynchronized = true;
    return clockSynchronized && epoch >= 1767225600LL && epoch < 4102444800LL;
}

bool hmac(const uint8_t key[32], const uint8_t* message, size_t length, uint8_t tag[32]) {
    const auto* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    return info && mbedtls_md_hmac(info, key, 32, message, length, tag) == 0;
}

// Self-test the actual mbedTLS adapter before any authenticated BLE writes.
bool cryptoSelfTest() {
    const uint8_t key[32] = {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31};
    const uint8_t message[16] = {0xa1,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,0xa8,0x50,1,0,0,0,1,1,30};
    const uint8_t expected[8] = {0x15,0x65,0x4c,0x3e,0xea,0x6a,0xd0,0x7a};
    uint8_t tag[32];
    return hmac(key, message, sizeof(message), tag) && std::memcmp(tag, expected, sizeof(expected)) == 0;
}

void receiveNotification(NimBLERemoteCharacteristic*, uint8_t* data, size_t length, bool) {
    // This runs on a NimBLE task. Transfer bounded chunks; parse only in loop().
    if (!length || length > 20) { notificationOverflow.store(true); return; }
    Notification item{};
    item.size = static_cast<uint8_t>(length);
    std::memcpy(item.data, data, length);
    if (xQueueSend(notifications, &item, 0) != pdTRUE) notificationOverflow.store(true);
}

void disconnectLight() {
    writer = nullptr;
    if (client) {
        if (client->isConnected()) client->disconnect();
        NimBLEDevice::deleteClient(client);
        client = nullptr;
    }
    connection.reset();
    parser.reset();
    sent = false;
    if (notifications) xQueueReset(notifications);
    notificationOverflow.store(false);
}

void pollServer() {
    // Anchor the freshness deadline before the request, so network/parse time
    // cannot silently add seconds to the API's thirty-second lease.
    const uint32_t requestedAt = millis();
    WiFiClientSecure tls;
    tls.setCACert(PP_ROOT_CA_PEM); // mbedTLS verifies the chain AND URL hostname.
    tls.setHandshakeTimeout(5);
    tls.setTimeout(3000);
    HTTPClient http;
    http.setConnectTimeout(3000);
    http.setTimeout(3000);
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    http.setReuse(false);
    http.useHTTP10(true); // Small state replies have a required Content-Length.
    if (!http.begin(tls, PP_API_URL)) return;
    const char* headers[] = {"Content-Type", "Content-Encoding"};
    http.collectHeaders(headers, 2);
    http.addHeader("Authorization", String("Bearer ") + PP_API_TOKEN);
    http.addHeader("Accept", "application/json");
    http.addHeader("Accept-Encoding", "identity");
    const int status = http.GET();
    const int length = http.getSize();
    const String type = http.header("Content-Type");
    const String encoding = http.header("Content-Encoding");
    if (status == HTTP_CODE_OK && length > 0 && length <= 512 &&
        (type == "application/json" || type.startsWith("application/json;")) &&
        (encoding.isEmpty() || encoding == "identity")) {
        char body[513];
        auto& stream = http.getStream();
        stream.setTimeout(3000);
        const size_t received = stream.readBytes(body, static_cast<size_t>(length));
        if (received == static_cast<size_t>(length)) {
            body[received] = '\0';
            if (state.accept(body, received, requestedAt)) Serial.println("State received");
            else Serial.println("State unavailable: invalid response");
        } else Serial.println("State unavailable: incomplete response");
    } else Serial.println("State unavailable: request failed");
    // No error branch changes state or its original deadline.
    http.end();
}

void connectLight() {
    auto* scan = NimBLEDevice::getScan();
    scan->setActiveScan(true); // CircuitPython may place the name in scan response.
    scan->setMaxResults(24); // Bound discovery memory in a crowded classroom.
    const auto results = scan->getResults(1500, false);
    for (int i = 0; i < results.getCount(); ++i) {
        const auto* device = results.getDevice(i);
        if (!device || !device->haveName() || device->getName() != PP_LIGHT_NAME ||
            !device->isAdvertisingService(NimBLEUUID(SERVICE))) continue;
        client = NimBLEDevice::createClient();
        if (!client) break;
        client->setConnectTimeout(3000);
        client->setConnectionParams(24, 40, 0, 200);
        if (client->connect(device)) {
            auto* service = client->getService(SERVICE);
            auto* tx = service ? service->getCharacteristic(TX) : nullptr;
            auto* rx = service ? service->getCharacteristic(RX) : nullptr;
            if (rx && rx->canWrite() && tx && tx->canNotify()) {
                connection.reset(); parser.reset(); xQueueReset(notifications);
                notificationOverflow.store(false);
                if (tx->subscribe(true, receiveNotification)) {
                    writer = rx;
                    connectedAt = millis();
                    sent = false;
                    Serial.println("Light connected");
                    break;
                }
            }
        }
        disconnectLight();
        break; // Retry later; never connect to a differently named UART device.
    }
    scan->clearResults();
}

void serviceLight() {
    if (!client || !client->isConnected()) {
        if (client) disconnectLight();
        if (state.remaining(millis()) && millis() - lastConnect >= RETRY_MS) {
            lastConnect = millis();
            connectLight();
        }
        return;
    }
    if (notificationOverflow.exchange(false)) { disconnectLight(); return; }
    Notification item{};
    uint8_t nonce[8];
    while (xQueueReceive(notifications, &item, 0) == pdTRUE) {
        for (size_t i = 0; i < item.size; ++i) {
            if (parser.feed(static_cast<char>(item.data[i]), nonce)) connection.challenge(nonce);
        }
    }
    const uint32_t now = millis();
    const uint8_t ttl = state.remaining(now);
    if (!ttl || (!connection.ready() && now - connectedAt > 10000)) { disconnectLight(); return; }
    if (writer && connection.ready() && (!sent || now - lastSend >= SEND_MS)) {
        uint8_t frame[16];
        if (!connection.frame(bleKey, state.mask(), ttl, hmac, frame) || !writer->writeValue(frame, sizeof(frame), true)) {
            disconnectLight();
            return;
        }
        lastSend = now;
        sent = true;
    }
}
}

void setup() {
    Serial.begin(115200);
    notifications = xQueueCreate(8, sizeof(Notification));
    configured = notifications && configurationValid() && cryptoSelfTest();
    if (!configured) { Serial.println("Unavailable: configure gateway before use"); return; }
    NimBLEDevice::init("PP-Gateway");
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(PP_WIFI_SSID, PP_WIFI_PASSWORD);
    configTime(0, 0, "time.google.com", "pool.ntp.org", "time.cloudflare.com");
    lastPoll = millis() - POLL_MS;
    lastConnect = millis() - RETRY_MS;
    Serial.println("Gateway ready; waiting for network and clock");
}

void loop() {
    if (!configured) { delay(100); return; }
    const uint32_t now = millis();
    if (WiFi.status() == WL_CONNECTED && clockValid() && now - lastPoll >= POLL_MS) {
        lastPoll = now;
        pollServer();
    }
    if (!state.remaining(millis())) {
        if (client) disconnectLight();
    } else serviceLight();
    delay(20);
}
