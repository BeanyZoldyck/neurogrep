#!/usr/bin/env bash
# Compile, flash and verify the T-Dongle-S3 status panel.
set -eu
cd "$(dirname "$0")"

FQBN="esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=huge_app,CDCOnBoot=cdc,USBMode=hwcdc,PSRAM=disabled,FlashMode=qio,CPUFreq=240,UploadSpeed=921600"
PORT=${PORT:-/dev/ttyACM0}

arduino-cli compile --upload -p "$PORT" -b "$FQBN" tdongle_wifi

sleep 3
python3 capture.py "$PORT" dump.txt
python3 decode_frame.py dump.txt screen.png
echo "wrote screen.png - open it to see what the glass shows"
