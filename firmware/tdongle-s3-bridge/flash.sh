#!/usr/bin/env bash
# Build and flash the USB-NCM Wi-Fi bridge.
#
# NOTE: once this firmware is running, the USB pins belong to the OTG controller,
# so esptool can no longer reset the chip over CDC. To reflash, hold BOOT (GPIO0)
# while plugging the dongle in, then run this script.
set -eu
cd "$(dirname "$0")"

. "$HOME/esp-idf/export.sh" >/dev/null 2>&1

PORT=${PORT:-/dev/ttyACM0}

if [ "${1:-}" = "display" ]; then
  # Display-only verification image: keeps the USB-Serial/JTAG console so the
  # framebuffer can be dumped over serial (see capture.py).
  idf.py -B build-display -DSDKCONFIG=build-display/sdkconfig \
         -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.display" \
         -p "$PORT" build flash
else
  idf.py -B build -p "$PORT" build flash
fi
