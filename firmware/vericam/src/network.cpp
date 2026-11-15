#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <mbedtls/md.h>
#include <time.h>
#include "secrets.h"
#include "network.h"

namespace {
struct Event { uint8_t state[54]; uint32_t sequence; };
QueueHandle_t events;
uint32_t sequence = 0;
String deviceId, bootId;
bool deliveryEnabled;
String hex(const uint8_t *data, size_t size) {
  static const char digits[] = "0123456789abcdef";
  String result; result.reserve(size * 2);
  for (size_t i=0; i<size; ++i) { result += digits[data[i] >> 4]; result += digits[data[i] & 15]; }
  return result;
}
void worker(void *) {
  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
    if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED)
      Serial.printf("Wi-Fi association lost/failed; reason=%u\n", info.wifi_sta_disconnected.reason);
  });
  WiFi.persistent(false); WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true);
  WiFi.begin(VERICAM_WIFI_SSID, VERICAM_WIFI_PASSWORD);
  bool wasConnected = false;
  uint32_t lastRetry = millis();
  Event pending{}; bool havePending = false; uint8_t attempts = 0;
  for (;;) {
    bool connected = WiFi.status() == WL_CONNECTED;
    if (connected && !wasConnected) {
      Serial.printf("Wi-Fi connected: %s; RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
      configTime(0, 0, "pool.ntp.org", "time.google.com");
    }
    if (!connected && wasConnected) Serial.println("Wi-Fi disconnected; reconnecting");
    wasConnected = connected;
    if (!connected && millis() - lastRetry >= 15000) { WiFi.reconnect(); lastRetry = millis(); }
    // Certificate validation needs an initialized clock; never bypass TLS checks.
    if (!deliveryEnabled || !connected || time(nullptr) < 1704067200) { vTaskDelay(pdMS_TO_TICKS(250)); continue; }
    if (!havePending) {
      if (xQueueReceive(events, &pending, pdMS_TO_TICKS(250)) != pdTRUE) continue;
      havePending = true; attempts = 0;
    }
    // Sign the exact UTF-8 request body. Boot nonce + sequence are the idempotency key.
    String body = "{\"version\":1,\"device\":\"" + deviceId + "\",\"boot\":\"" + bootId +
      "\",\"sequence\":" + String(pending.sequence) + ",\"state\":\"" + hex(pending.state, 54) + "\"}";
    uint8_t mac[32];
    int result = mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
      reinterpret_cast<const uint8_t *>(VERICAM_EVENT_KEY), strlen(VERICAM_EVENT_KEY),
      reinterpret_cast<const uint8_t *>(body.c_str()), body.length(), mac);
    if (result != 0) { Serial.println("Event signing failed"); havePending = false; continue; }
    WiFiClientSecure tls; tls.setCACert(VERICAM_ROOT_CA); tls.setHandshakeTimeout(5);
    HTTPClient http; http.setConnectTimeout(5000); http.setTimeout(5000);
    int code = -1;
    if (http.begin(tls, VERICAM_EVENT_URL)) {
      http.addHeader("Content-Type", "application/json");
      http.addHeader("X-VeriCam-Signature", hex(mac, sizeof(mac)));
      code = http.POST(body); http.end();
    }
    if (code >= 200 && code < 300) { Serial.printf("Event %lu delivered\n", (unsigned long)pending.sequence); havePending = false; }
    else if (++attempts >= 3) { Serial.printf("Event %lu delivery failed (%d); dropped after 3 attempts\n", (unsigned long)pending.sequence, code); havePending = false; }
    else { vTaskDelay(pdMS_TO_TICKS(1000 * attempts)); }
  }
}
}
void networkStart() {
  uint64_t mac = ESP.getEfuseMac(); deviceId = hex(reinterpret_cast<uint8_t *>(&mac), 6);
  uint8_t nonce[16]; esp_fill_random(nonce, sizeof(nonce)); bootId = hex(nonce, sizeof(nonce));
  events = xQueueCreate(16, sizeof(Event));
  deliveryEnabled = String(VERICAM_EVENT_URL).startsWith("https://") && strlen(VERICAM_EVENT_KEY) >= 32 && strlen(VERICAM_ROOT_CA) > 0;
  Serial.printf("Device ID: %s; HTTPS event delivery: %s\n", deviceId.c_str(), deliveryEnabled ? "configured" : "not configured");
  // Separate task: TLS/network delays never block the RFID deadline loop.
  if (!events || xTaskCreate(worker, "vericam-network", 8192, nullptr, 1, nullptr) != pdPASS) {
    Serial.println("Network initialization failed"); deliveryEnabled = false;
  }
}
void networkEvent(const uint8_t *state) {
  if (!deliveryEnabled || !events) return;
  Event event{}; memcpy(event.state, state, 54); event.sequence = ++sequence;
  if (xQueueSend(events, &event, 0) != pdTRUE) Serial.println("Event queue full; event dropped");
}
