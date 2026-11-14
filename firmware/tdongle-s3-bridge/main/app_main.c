// T-Dongle-S3 as the Raspberry Pi's network interface.
//
// The dongle bridges layer-2 frames between its Wi-Fi station interface and a
// USB NCM network interface. The Pi sees a normal Ethernet adapter, gets a DHCP
// lease from the actual router, and keeps its own MAC/IP: no NAT, no double
// translation, no software on the Pi.
//
// Built on ESP-IDF's tusb_ncm example (esp_wifi_internal_tx + esp_tinyusb net).

#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#if CONFIG_APP_BRIDGE_MODE
#include "esp_private/wifi.h"
#include "tinyusb.h"
#include "tinyusb_net.h"
#endif

#include "st7735.h"
#include "ui.h"

// Same gitignored credentials file as the Arduino sketch; the fallback keeps the
// repo buildable without it.
#if __has_include("secrets.h")
#include "secrets.h"
#else
#define WIFI_SSID "YOUR_SSID"
#define WIFI_PASSWORD "YOUR_PASSWORD"
#endif

static const char *TAG = "bridge";

#define UI_PERIOD_MS 200

static volatile bool s_wifi_connected;
static volatile const char *s_fail_reason = "starting";
static volatile int8_t s_rssi = -127;
static volatile uint8_t s_chan;
static volatile bool s_host_has_ip;
static volatile uint8_t s_host_ip[4];
static volatile uint8_t s_host_mac[6];  // MAC we advertise for the NCM interface
static volatile uint32_t s_pkt_in;
static volatile uint32_t s_pkt_out;
static char s_ssid[33];

// ---------------------------------------------------------------- utilities

static const char *reason_text(uint8_t reason) {
  switch (reason) {
    case WIFI_REASON_NO_AP_FOUND:            return "no 2.4GHz AP";
    case WIFI_REASON_AUTH_FAIL:              return "auth failed";
    case WIFI_REASON_ASSOC_FAIL:             return "assoc failed";
    case WIFI_REASON_HANDSHAKE_TIMEOUT:      return "handshake timeout";
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT: return "bad password?";
    case WIFI_REASON_CONNECTION_FAIL:        return "connect failed";
    case WIFI_REASON_BEACON_TIMEOUT:         return "beacon timeout";
    case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY: return "security mismatch";
    default:                                 return "disconnected";
  }
}

#if CONFIG_APP_BRIDGE_MODE

// ------------------------------------------------------------- dhcp sniffing

// The ESP is a bridge, so it never holds an address itself. To show the Pi's IP
// we watch the DHCP replies crossing Wi-Fi -> USB and record yiaddr.
static void sniff_dhcp(const uint8_t *f, uint16_t len) {
  if (len < 14 + 20 + 8 + 20 + 4) return;
  if (f[12] != 0x08 || f[13] != 0x00) return;       // IPv4
  const uint8_t *ip = f + 14;
  if ((ip[0] >> 4) != 4) return;
  uint8_t ihl = (uint8_t)((ip[0] & 0x0F) * 4);
  if (ihl < 20 || ip[9] != 17) return;               // UDP
  const uint8_t *udp = ip + ihl;
  if (((udp[0] << 8) | udp[1]) != 67) return;        // DHCP server -> client
  if (((udp[2] << 8) | udp[3]) != 68) return;
  const uint8_t *dhcp = udp + 8;
  if (dhcp[0] != 2) return;                          // BOOTREPLY only
  // Only accept replies for *our* host: the LAN also carries broadcasts for
  // other devices, and showing their address would be actively misleading.
  if (memcmp(dhcp + 28, (const void *)s_host_mac, 6) != 0) return;
  if (dhcp[16] == 0 && dhcp[17] == 0 && dhcp[18] == 0 && dhcp[19] == 0) return;
  s_host_ip[0] = dhcp[16];
  s_host_ip[1] = dhcp[17];
  s_host_ip[2] = dhcp[18];
  s_host_ip[3] = dhcp[19];
  s_host_has_ip = true;
}

static esp_err_t usb_recv_cb(void *buffer, uint16_t len, void *ctx) {
  if (s_wifi_connected) {
    s_pkt_in++;
    esp_wifi_internal_tx(ESP_IF_WIFI_STA, buffer, len);
  }
  return ESP_OK;
}

static void free_tx(void *eb, void *ctx) { esp_wifi_internal_free_rx_buffer(eb); }

static esp_err_t pkt_wifi2usb(void *buffer, uint16_t len, void *eb) {
  s_pkt_out++;
  sniff_dhcp((const uint8_t *)buffer, len);
  if (tinyusb_net_send_sync(buffer, len, eb, portMAX_DELAY) != ESP_OK) {
    esp_wifi_internal_free_rx_buffer(eb);
  }
  return ESP_OK;
}

// -------------------------------------------------------------------- wifi

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data) {
  if (base != WIFI_EVENT) return;

  if (id == WIFI_EVENT_STA_CONNECTED) {
    esp_wifi_internal_reg_rxcb(ESP_IF_WIFI_STA, pkt_wifi2usb);
    s_wifi_connected = true;
    s_fail_reason = NULL;
    ESP_LOGI(TAG, "sta connected");
  } else if (id == WIFI_EVENT_STA_DISCONNECTED) {
    wifi_event_sta_disconnected_t *d = (wifi_event_sta_disconnected_t *)data;
    esp_wifi_internal_reg_rxcb(ESP_IF_WIFI_STA, NULL);
    s_wifi_connected = false;
    s_fail_reason = reason_text(d->reason);
    ESP_LOGW(TAG, "sta disconnected, reason %d", d->reason);
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_wifi_connect();
  }
}

static void wifi_start(void) {
  ESP_ERROR_CHECK(esp_event_loop_create_default());

  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&cfg));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                             wifi_event_handler, NULL));
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));

  wifi_config_t wc = {0};
  strncpy((char *)wc.sta.ssid, WIFI_SSID, sizeof(wc.sta.ssid) - 1);
  strncpy((char *)wc.sta.password, WIFI_PASSWORD, sizeof(wc.sta.password) - 1);
  wc.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
  ESP_ERROR_CHECK(esp_wifi_start());
  esp_wifi_connect();
}

static volatile bool s_usb_attached;

static void usb_event_cb(tinyusb_event_t *ev, void *arg) {
  if (ev->id == TINYUSB_EVENT_ATTACHED) s_usb_attached = true;
  else if (ev->id == TINYUSB_EVENT_DETACHED) s_usb_attached = false;
}

static void bridge_start(void) {
  // esp_tinyusb 3.x config (the 2.x `external_phy` field is gone).
  const tinyusb_config_t tusb_cfg = {
      .port = TINYUSB_PORT_FULL_SPEED_0,
      .phy = {.skip_setup = false},
      .task = {.size = 4096, .priority = 5, .xCoreID = 0},
      .descriptor = {0},
      .pm_lock_enable = false,
      .event_cb = usb_event_cb,
      .event_arg = NULL,
  };
  ESP_ERROR_CHECK(tinyusb_driver_install(&tusb_cfg));

  tinyusb_net_config_t net_cfg = {
      .on_recv_callback = usb_recv_cb,
      .free_tx_buffer = free_tx,
      .on_init_callback = NULL,
      .user_context = NULL,
  };
  esp_read_mac(net_cfg.mac_addr, ESP_MAC_WIFI_STA);
  memcpy((void *)s_host_mac, net_cfg.mac_addr, 6);
  ESP_ERROR_CHECK(tinyusb_net_init(&net_cfg));

  wifi_start();
  ESP_LOGI(TAG, "bridge running");
}

#endif  // CONFIG_APP_BRIDGE_MODE

// --------------------------------------------------------------------- ui

#if !CONFIG_APP_BRIDGE_MODE
// Verification build: no USB OTG, so the USB-Serial/JTAG console is free. Lets
// capture.py pull the live canvas and prove the panel driver renders correctly.
static volatile int s_demo = 1;

static inline uint8_t fb_byte(const uint16_t *fb, size_t k) {
  uint16_t sv = fb[k >> 1];
  uint16_t c = (uint16_t)((sv >> 8) | (sv << 8));  // back to native RGB565
  return (k & 1) ? (uint8_t)(c >> 8) : (uint8_t)(c & 0xFF);
}

static void dump_frame(void) {
  static const char b64[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const uint16_t *fb = lcd_fb();
  const size_t total = (size_t)LCD_W * LCD_H * 2;

  printf("FBEGIN %u\n", (unsigned)total);
  for (size_t i = 0; i < total; i += 3) {
    uint32_t v = (uint32_t)fb_byte(fb, i) << 16;
    if (i + 1 < total) v |= (uint32_t)fb_byte(fb, i + 1) << 8;
    if (i + 2 < total) v |= fb_byte(fb, i + 2);
    putchar(b64[(v >> 18) & 0x3F]);
    putchar(b64[(v >> 12) & 0x3F]);
    putchar((i + 1 < total) ? b64[(v >> 6) & 0x3F] : '=');
    putchar((i + 2 < total) ? b64[v & 0x3F] : '=');
  }
  printf("\nFEND\n");
}

static void console_task(void *arg) {
  setvbuf(stdin, NULL, _IONBF, 0);
  while (1) {
    int c = getchar();
    if (c == EOF) {
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    if (c == 'd') dump_frame();
    else if (c == '1' || c == '2') s_demo = c - '0';
  }
}
#endif

static void ui_task(void) {
  uint32_t last_pkt = 0, last_ms = 0;
  uint32_t rate = 0;

  while (1) {
    uint32_t ms = xTaskGetTickCount() * portTICK_PERIOD_MS;
    if (ms - last_ms >= 1000) {
      uint32_t now_pkt = s_pkt_out;
      rate = now_pkt - last_pkt;
      last_pkt = now_pkt;
      last_ms = ms;
    }

#if CONFIG_APP_BRIDGE_MODE
    wifi_ap_record_t ap;
    if (s_wifi_connected && esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
      s_rssi = ap.rssi;
      s_chan = ap.primary;
    }
#endif

    ui_state_t s = {0};
    strncpy(s.ssid, s_ssid, sizeof(s.ssid) - 1);
    s.wifi_connected = s_wifi_connected;
    s.fail_reason = s_fail_reason;
    s.rssi = s_rssi;
    s.channel = s_chan;
    s.uptime_ms = ms;
    s.pkt_per_s = rate;
    s.host_has_ip = s_host_has_ip;
    memcpy(s.host_ip, (const void *)s_host_ip, 4);
#if CONFIG_APP_BRIDGE_MODE
    s.host_present = s_usb_attached;
#else
    // Display-only build: synthetic state so the layout can be verified.
    bool online = (s_demo == 1);
    s.wifi_connected = online;
    s.fail_reason = online ? NULL : "auth failed";
    s.rssi = -62;
    s.channel = 6;
    s.pkt_per_s = 12;
    s.host_present = online;
    s.host_has_ip = online;
    s.host_ip[0] = 192; s.host_ip[1] = 168; s.host_ip[2] = 1; s.host_ip[3] = 57;
#endif
    ui_draw(&s);
    vTaskDelay(pdMS_TO_TICKS(UI_PERIOD_MS));
  }
}

void app_main(void) {
  esp_err_t ret = nvs_flash_init();
  if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ret = nvs_flash_init();
  }
  ESP_ERROR_CHECK(ret);

  strncpy(s_ssid, WIFI_SSID, sizeof(s_ssid) - 1);

  ESP_ERROR_CHECK(lcd_init());
  ui_init();
  lcd_backlight(0);

  // First frame before anything slow happens, then fade up: the screen coming
  // alive is the "board has power" signal.
  ui_state_t boot = {0};
  strncpy(boot.ssid, s_ssid, sizeof(boot.ssid) - 1);
  boot.fail_reason = "starting";
  ui_draw(&boot);
  for (int lvl = 0; lvl <= 255; lvl += 5) {
    lcd_backlight((uint8_t)lvl);
    vTaskDelay(pdMS_TO_TICKS(6));
  }
  lcd_backlight(255);

#if CONFIG_APP_BRIDGE_MODE
  bridge_start();
#else
  xTaskCreate(console_task, "console", 4096, NULL, 3, NULL);
#endif

  ui_task();
}
