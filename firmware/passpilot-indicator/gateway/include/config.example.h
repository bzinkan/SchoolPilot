#pragma once
// Copy to ignored config.h with the local setup generator. Never commit secrets.
// Empty values compile but keep the device unavailable until configured/flashed.
constexpr const char* PP_WIFI_SSID = "";
constexpr const char* PP_WIFI_PASSWORD = "";
constexpr const char* PP_API_URL = "";  // https://<PassPilot API host>/api/passpilot/indicators/state
constexpr const char* PP_API_TOKEN = "";  // private ppi_ bearer credential
constexpr const char* PP_LIGHT_NAME = ""; // PP-Light- plus 1..8 alphanumeric characters
constexpr const char* PP_BLE_KEY_HEX = ""; // locally generated, 64 lowercase hex digits
// The trusted root CA for the API's real certificate chain, including PEM fences.
// Do not use a leaf certificate or disable verification if the chain changes.
constexpr const char* PP_ROOT_CA_PEM = "";
