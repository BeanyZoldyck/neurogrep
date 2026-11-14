// T-Dongle-S3 headless status panel for a Raspberry Pi
//
// Runs from flash on any 5 V source. On the Pi it doubles as a "is the Pi up?"
// light: the PI indicator only lights once the Pi's kernel has enumerated the
// dongle's USB (no SOF before that).
//
// Hardware: LilyGo T-Dongle-S3 (ESP32-S3, 16 MB, no PSRAM)
//   ST7735S 160x80: SCLK=5 MOSI=3 CS=4 DC=2 RST=1 BL=38 (backlight ACTIVE LOW)
//   APA102:         DI=40 CI=39 (BGR, 1 LED)
//   Native USB-Serial/JTAG on GPIO19/20 is the "host present" detector.

#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <WiFi.h>

// Credentials live in a gitignored secrets.h; the fallback lets the repo build.
#if __has_include("secrets.h")
#include "secrets.h"
#else
#define WIFI_SSID "YOUR_SSID"
#define WIFI_PASSWORD "YOUR_PASSWORD"
#endif

#define PIN_SCLK 5
#define PIN_MOSI 3
#define PIN_CS   4
#define PIN_DC   2
#define PIN_RST  1
#define PIN_BL   38

#define PIN_LED_DI 40
#define PIN_LED_CI 39

#define W 160
#define H 80

#define CONNECT_BUDGET_MS 15000
#define SCAN_BUDGET_MS 7000
#define RETRY_MIN_MS 3000
#define RETRY_MAX_MS 30000

// RGB565 palette
#define C_BG_TOP 0x0884
#define C_BG_BOT 0x0042
#define C_OK     0x072E  // #00E676 green
#define C_BAD    0xF9C6  // #FF3B30 red
#define C_WARN   0xFE20  // #FFC400 amber
#define C_WHITE  0xFFFF
#define C_DIM    0x8C73
#define C_DARK   0x2104
#define C_LINE   0x2A69

Adafruit_ST7735 tft(&SPI, PIN_CS, PIN_DC, PIN_RST);
GFXcanvas16 canvas(W, H);

static int8_t sineTab[256];
static uint16_t grad[32];
static uint8_t rowPhase[H];

enum State { ST_SCAN, ST_CONNECT, ST_ONLINE, ST_FAIL };

static State st = ST_SCAN;
static uint32_t stateAt = 0;
static uint32_t connectStart = 0;
static uint32_t connectMs = 0;
static uint32_t nextRetryAt = 0;
static uint32_t retryDelay = RETRY_MIN_MS;
static uint32_t attempts = 0;
static int16_t scanTotal = 0;
static bool ssidSeen = false;
static bool scanRunning = false;
static char failLine[24] = "";
static char failSub[24] = "";
static bool hostPresent = false;

// ---------------------------------------------------------------- utilities

static inline uint16_t mix565(uint16_t a, uint16_t b, uint8_t t /*0..255*/) {
  uint16_t ar = (a >> 11) & 0x1F, ag = (a >> 5) & 0x3F, ab = a & 0x1F;
  uint16_t br = (b >> 11) & 0x1F, bg = (b >> 5) & 0x3F, bb = b & 0x1F;
  uint16_t r = (ar * (255 - t) + br * t) / 255;
  uint16_t g = (ag * (255 - t) + bg * t) / 255;
  uint16_t bl = (ab * (255 - t) + bb * t) / 255;
  return (r << 11) | (g << 5) | bl;
}

// Backlight is active low: 0 = full brightness (matches LilyGo's own driver).
static inline void setBacklight(uint8_t level) { ledcWrite(PIN_BL, 255 - level); }

static void apa102(uint8_t r, uint8_t g, uint8_t b, uint8_t brightness) {
  uint8_t frame[9] = {0, 0, 0, 0, (uint8_t)(0xE0 | (brightness & 0x1F)), b, g, r, 0xFF};
  for (int i = 0; i < 8; i++) {
    for (int bit = 7; bit >= 0; bit--) {
      digitalWrite(PIN_LED_DI, (frame[i] >> bit) & 1);
      digitalWrite(PIN_LED_CI, HIGH);
      digitalWrite(PIN_LED_CI, LOW);
    }
  }
  digitalWrite(PIN_LED_DI, LOW);
  digitalWrite(PIN_LED_CI, LOW);
}

static void textShadow(int16_t x, int16_t y, const char *s, uint8_t size, uint16_t colour) {
  canvas.setTextSize(size);
  canvas.setTextColor(C_BG_BOT);
  canvas.setCursor(x + 1, y + 1);
  canvas.print(s);
  canvas.setTextColor(colour);
  canvas.setCursor(x, y);
  canvas.print(s);
}

static void textCentered(int16_t y, const char *s, uint8_t size, uint16_t colour) {
  int16_t w = (int16_t)strlen(s) * 6 * size;
  textShadow((W - w) / 2, y, s, size, colour);
}

static void drawSignalBars(int16_t x, int16_t baseline, int8_t rssi) {
  int level = 0;
  if (rssi > -60) level = 4;
  else if (rssi > -70) level = 3;
  else if (rssi > -80) level = 2;
  else if (rssi > -90) level = 1;
  for (int i = 0; i < 4; i++) {
    int16_t h = 4 + i * 3;
    uint16_t c = (i < level) ? C_OK : C_DARK;
    canvas.fillRect(x + i * 5, baseline - h, 3, h, c);
  }
}

// ------------------------------------------------------------------ drawing

static void drawBackground(uint32_t ms) {
  uint8_t drift = (uint8_t)(ms / 90);
  for (int y = 0; y < H; y++) {
    uint8_t s = (uint8_t)((sineTab[(uint8_t)(rowPhase[y] + drift)] + 128));
    canvas.drawFastHLine(0, y, W, grad[(s * 31) >> 8]);
  }
}

static void drawHeader() {
  textShadow(4, 3, WIFI_SSID, 1, C_DIM);

  // PI indicator: lights only when a real USB host has enumerated us.
  uint16_t box = hostPresent ? C_OK : C_DARK;
  canvas.fillRect(132, 4, 5, 5, box);
  textShadow(140, 3, "PI", 1, hostPresent ? C_WHITE : C_DIM);
}

static void drawBig(const char *word, uint16_t colour) {
  textCentered(16, word, 3, colour);
}

static void drawStatus(uint32_t ms) {
  char buf[32];

  switch (st) {
    case ST_SCAN:
      drawBig("SCANNING", C_WARN);
      textCentered(44, "2.4GHz only (no 5GHz)", 1, C_DIM);
      snprintf(buf, sizeof(buf), "%u APs so far", (unsigned)scanTotal);
      textCentered(54, buf, 1, C_DIM);
      break;

    case ST_CONNECT: {
      drawBig("TRYING", C_WARN);
      textCentered(44, WIFI_SSID, 1, C_WHITE);
      uint32_t el = (millis() - connectStart) / 1000;
      snprintf(buf, sizeof(buf), "%us / %us", (unsigned)el,
               (unsigned)(CONNECT_BUDGET_MS / 1000));
      textCentered(54, buf, 1, C_DIM);
      break;
    }

    case ST_ONLINE: {
      drawBig("ONLINE", C_OK);
      IPAddress ip = WiFi.localIP();
      snprintf(buf, sizeof(buf), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
      textCentered(44, buf, 1, C_WHITE);

      int8_t rssi = WiFi.RSSI();
      snprintf(buf, sizeof(buf), "CH %d  %ddBm", WiFi.channel(), rssi);
      textCentered(54, buf, 1, C_DIM);
      drawSignalBars(136, 62, rssi);
      break;
    }

    case ST_FAIL:
      drawBig("OFFLINE", C_BAD);
      textCentered(44, failLine, 1, C_WHITE);
      textCentered(54, failSub, 1, C_DIM);
      break;
  }
}

static void drawFooter(uint32_t ms) {
  char buf[24];
  uint32_t s = ms / 1000;
  snprintf(buf, sizeof(buf), "UP %02u:%02u:%02u", (unsigned)(s / 3600),
           (unsigned)((s / 60) % 60), (unsigned)(s % 60));
  textCentered(65, buf, 1, C_DIM);

  // One pass per second: proves the firmware is alive without a screen reader.
  canvas.fillRect(0, 76, W, 4, C_BG_BOT);
  uint16_t bar = (uint16_t)((ms % 1000) * W / 1000);
  canvas.fillRect(0, 78, bar, 2, (st == ST_ONLINE) ? C_OK : C_WARN);
}

static void push() { tft.drawRGBBitmap(0, 0, canvas.getBuffer(), W, H); }

// ----------------------------------------------------------------- wifi fsm

static void startScan() {
  st = ST_SCAN;
  stateAt = millis();
  scanTotal = 0;
  ssidSeen = false;
  scanRunning = true;
  WiFi.scanNetworks(true, false);  // async, no hidden networks
}

static void startConnect() {
  st = ST_CONNECT;
  connectStart = millis();
  attempts++;
  WiFi.disconnect(true, false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

static void fail(const char *line, const char *sub) {
  st = ST_FAIL;
  stateAt = millis();
  strncpy(failLine, line, sizeof(failLine) - 1);
  failLine[sizeof(failLine) - 1] = 0;
  strncpy(failSub, sub, sizeof(failSub) - 1);
  failSub[sizeof(failSub) - 1] = 0;
  nextRetryAt = millis() + retryDelay;
  retryDelay = min<uint32_t>(retryDelay * 2, RETRY_MAX_MS);
}

static void serviceWifi() {
  uint32_t now = millis();

  switch (st) {
    case ST_SCAN: {
      int16_t n = WiFi.scanComplete();
      if (n >= 0) {
        scanTotal = n;
        int8_t best = -127;
        for (int i = 0; i < n; i++) {
          if (WiFi.SSID(i) == WIFI_SSID) {
            ssidSeen = true;
            if (WiFi.RSSI(i) > best) best = WiFi.RSSI(i);
          }
        }
        WiFi.scanDelete();
        scanRunning = false;
        startConnect();
      } else if (n == WIFI_SCAN_FAILED) {
        scanRunning = false;
        startConnect();
      } else if (now - stateAt > SCAN_BUDGET_MS) {
        scanRunning = false;
        startConnect();
      }
      break;
    }

    case ST_CONNECT: {
      wl_status_t s = WiFi.status();
      if (s == WL_CONNECTED) {
        st = ST_ONLINE;
        stateAt = now;
        connectMs = now - connectStart;
        retryDelay = RETRY_MIN_MS;
        Serial.printf("{\"event\":\"online\",\"ip\":\"%s\",\"rssi\":%d,\"ch\":%d,\"ms\":%u}\n",
                      WiFi.localIP().toString().c_str(), (int)WiFi.RSSI(),
                      WiFi.channel(), (unsigned)connectMs);
      } else if (now - connectStart > CONNECT_BUDGET_MS) {
        const char *why = "timeout";
        const char *sub = "AP seen, join failed";
        if (!ssidSeen) {
          why = "no 2.4GHz AP";
          sub = "SSID not visible on 2.4G";
        } else if (s == WL_NO_SSID_AVAIL) {
          why = "no 2.4GHz AP";
          sub = "SSID not visible";
        } else if (s == WL_CONNECT_FAILED) {
          why = "auth failed";
          sub = "password or MAC filter";
        }
        fail(why, sub);
        Serial.printf("{\"event\":\"fail\",\"status\":%d,\"ssidSeen\":%d}\n",
                      (int)s, (int)ssidSeen);
      }
      break;
    }

    case ST_ONLINE:
      if (WiFi.status() != WL_CONNECTED) {
        // Link dropped: rejoin straight away, no scan needed.
        startConnect();
      }
      break;

    case ST_FAIL:
      if (now >= nextRetryAt) startConnect();
      break;
  }
}

// ---------------------------------------------------------------- serial aid

static void dumpFrame() {
  static const char b64[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const uint8_t *p = (const uint8_t *)canvas.getBuffer();
  const size_t n = (size_t)W * H * 2;
  Serial.printf("FBEGIN %u\n", (unsigned)n);
  char out[4];
  for (size_t i = 0; i < n; i += 3) {
    size_t rem = n - i;
    uint32_t v = (uint32_t)p[i] << 16;
    if (rem > 1) v |= (uint32_t)p[i + 1] << 8;
    if (rem > 2) v |= p[i + 2];
    out[0] = b64[(v >> 18) & 0x3F];
    out[1] = b64[(v >> 12) & 0x3F];
    out[2] = (rem > 1) ? b64[(v >> 6) & 0x3F] : '=';
    out[3] = (rem > 2) ? b64[v & 0x3F] : '=';
    Serial.write((const uint8_t *)out, 4);
  }
  Serial.print("\nFEND\n");
}

// ---------------------------------------------------------------------- main

void setup() {
  ledcAttach(PIN_BL, 5000, 8);
  setBacklight(0);

  pinMode(PIN_LED_DI, OUTPUT);
  pinMode(PIN_LED_CI, OUTPUT);
  digitalWrite(PIN_LED_CI, LOW);
  digitalWrite(PIN_LED_DI, LOW);

  for (int i = 0; i < 256; i++)
    sineTab[i] = (int8_t)lroundf(127.0f * sinf(2.0f * (float)M_PI * i / 256.0f));
  for (int i = 0; i < 32; i++) grad[i] = mix565(C_BG_TOP, C_BG_BOT, (uint8_t)(i * 8));
  for (int y = 0; y < H; y++) rowPhase[y] = (uint8_t)((y * 410) >> 8);

  SPI.begin(PIN_SCLK, -1, PIN_MOSI, PIN_CS);
  tft.initR(INITR_MINI160x80_PLUGIN);
  tft.setRotation(1);
  tft.setSPISpeed(40000000);
  tft.fillScreen(C_BG_BOT);
  canvas.setTextWrap(false);

  Serial.begin(115200);
  Serial.println("{\"event\":\"boot\"}");

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  startScan();

  for (int lvl = 0; lvl <= 255; lvl += 5) {
    setBacklight(lvl);
    delay(6);
  }
  setBacklight(255);
  apa102(0, 30, 60, 3);
}

void loop() {
  uint32_t ms = millis();

  while (Serial.available()) {
    uint8_t c = Serial.read();
    if (c == 'd') dumpFrame();
  }

  hostPresent = Serial.isConnected();
  serviceWifi();

  drawBackground(ms);
  drawHeader();
  drawStatus(ms);
  drawFooter(ms);
  push();

  // LED mirrors link state: green on, amber trying, red offline.
  static uint32_t lastLed = 0;
  if (ms - lastLed > 200) {
    lastLed = ms;
    uint8_t lvl = (uint8_t)((sineTab[(ms / 24) & 255] + 128) >> 4);  // 0..15
    if (st == ST_ONLINE) apa102(0, 40 + lvl * 6, 15, 4);
    else if (st == ST_FAIL) apa102(60 + lvl * 6, 0, 0, 4);
    else apa102(60 + lvl * 6, 40 + lvl * 3, 0, 4);
  }

  static uint32_t lastStatus = 0;
  if (st == ST_ONLINE && ms - lastStatus > 10000) {
    lastStatus = ms;
    Serial.printf("{\"event\":\"status\",\"rssi\":%d,\"ch\":%d,\"up\":%u}\n",
                  (int)WiFi.RSSI(), WiFi.channel(), (unsigned)(ms / 1000));
  }
}
