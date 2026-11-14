// Status screen: the whole point of the device. Everything is drawn into the
// LCD canvas and pushed in one blit.

#include "ui.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "st7735.h"

#define C_BG_TOP 0x0884
#define C_BG_BOT 0x0042
#define C_OK     0x072E
#define C_BAD    0xF9C6
#define C_WARN   0xFE20
#define C_WHITE  0xFFFF
#define C_DIM    0x8C73
#define C_DARK   0x2104

static int8_t s_sin[256];
static uint16_t s_grad[32];
static uint8_t s_row_phase[LCD_H];

static uint16_t mix565(uint16_t a, uint16_t b, uint8_t t) {
  uint16_t ar = (a >> 11) & 0x1F, ag = (a >> 5) & 0x3F, ab = a & 0x1F;
  uint16_t br = (b >> 11) & 0x1F, bg = (b >> 5) & 0x3F, bb = b & 0x1F;
  uint16_t r = (ar * (255 - t) + br * t) / 255;
  uint16_t g = (ag * (255 - t) + bg * t) / 255;
  uint16_t bl = (ab * (255 - t) + bb * t) / 255;
  return (r << 11) | (g << 5) | bl;
}

void ui_init(void) {
  for (int i = 0; i < 256; i++)
    s_sin[i] = (int8_t)lroundf(127.0f * sinf(2.0f * (float)M_PI * i / 256.0f));
  for (int i = 0; i < 32; i++) s_grad[i] = mix565(C_BG_TOP, C_BG_BOT, (uint8_t)(i * 8));
  for (int y = 0; y < LCD_H; y++) s_row_phase[y] = (uint8_t)((y * 410) >> 8);
}

static void draw_background(uint32_t ms) {
  uint8_t drift = (uint8_t)(ms / 90);
  for (int y = 0; y < LCD_H; y++) {
    uint8_t v = (uint8_t)(s_sin[(uint8_t)(s_row_phase[y] + drift)] + 128);
    lcd_hline(0, y, LCD_W, s_grad[(v * 31) >> 8]);
  }
}

static void draw_signal_bars(int x, int baseline, int8_t rssi) {
  int level = 0;
  if (rssi > -60) level = 4;
  else if (rssi > -70) level = 3;
  else if (rssi > -80) level = 2;
  else if (rssi > -90) level = 1;
  for (int i = 0; i < 4; i++) {
    int h = 4 + i * 3;
    lcd_fill(x + i * 5, baseline - h, 3, h, (i < level) ? C_OK : C_DARK);
  }
}

void ui_draw(const ui_state_t *s) {
  char buf[40];

  draw_background(s->uptime_ms);

  // Header: SSID on the left, PI (USB host enumerated) on the right.
  lcd_text_shadow(4, 3, s->ssid[0] ? s->ssid : "no ssid", 1, C_DIM);
  lcd_fill(130, 4, 6, 6, s->host_present ? C_OK : C_DARK);
  lcd_text_shadow(139, 3, "PI", 1, s->host_present ? C_WHITE : C_DIM);

  // Headline.
  if (s->wifi_connected) {
    lcd_text_centered(16, "ONLINE", 3, C_OK);
  } else {
    lcd_text_centered(16, "OFFLINE", 3, C_BAD);
  }

  // Host / bridge detail.
  if (s->wifi_connected) {
    if (!s->host_present) {
      lcd_text_centered(44, "no USB host", 1, C_DIM);
    } else if (s->host_has_ip) {
      snprintf(buf, sizeof(buf), "PI %u.%u.%u.%u", s->host_ip[0], s->host_ip[1],
               s->host_ip[2], s->host_ip[3]);
      lcd_text_centered(44, buf, 1, C_WHITE);
    } else {
      lcd_text_centered(44, "PI waiting for DHCP", 1, C_DIM);
    }
    snprintf(buf, sizeof(buf), "CH %u %ddBm %lu/s", s->channel, s->rssi,
             (unsigned long)s->pkt_per_s);
    lcd_text_centered(54, buf, 1, C_DIM);
    draw_signal_bars(138, 62, s->rssi);
  } else {
    lcd_text_centered(44, s->fail_reason ? s->fail_reason : "connecting", 1, C_WHITE);
    lcd_text_centered(54, "retrying", 1, C_DIM);
  }

  // Uptime and the one-second sweep (stops if the loop ever hangs).
  uint32_t sec = s->uptime_ms / 1000;
  snprintf(buf, sizeof(buf), "UP %02u:%02u:%02u", (unsigned)(sec / 3600),
           (unsigned)((sec / 60) % 60), (unsigned)(sec % 60));
  lcd_text_centered(65, buf, 1, C_DIM);

  lcd_fill(0, 76, LCD_W, 4, C_BG_BOT);
  uint16_t bar = (uint16_t)((s->uptime_ms % 1000) * LCD_W / 1000);
  lcd_fill(0, 78, bar, 2, s->wifi_connected ? C_OK : C_WARN);

  lcd_flush();
}
