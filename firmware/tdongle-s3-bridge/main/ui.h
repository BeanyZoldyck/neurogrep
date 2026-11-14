#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct {
  char ssid[33];
  bool wifi_connected;
  bool host_present;   // USB host has configured (enumerated) the device
  bool host_has_ip;    // we saw a DHCP reply for the host
  uint8_t host_ip[4];
  int8_t rssi;
  uint8_t channel;
  uint32_t uptime_ms;
  const char *fail_reason;  // NULL when the station is connected
  uint32_t pkt_per_s;       // packets forwarded to the host in the last second
} ui_state_t;

void ui_init(void);
void ui_draw(const ui_state_t *s);
