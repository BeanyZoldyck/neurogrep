#!/usr/bin/env bash
# Compile + flash VeriCam-HSM to an ESP32-C3 (native USB).
set -eu
cd "$(dirname "$0")"
FQBN="esp32:esp32:esp32c3:CDCOnBoot=cdc"
PORT=${PORT:-/dev/ttyACM0}
arduino-cli lib install "MFRC522" >/dev/null
arduino-cli compile --upload -p "$PORT" -b "$FQBN" vericam_hsm
echo "flashed. serial: arduino-cli monitor -p $PORT -c baudrate=115200"
