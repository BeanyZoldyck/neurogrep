# neurogrep

Hardware utilities and firmware that happen to live in one repo.

## Contents

- [`firmware/tdongle-s3`](firmware/tdongle-s3) - LilyGo T-Dongle-S3 firmware that
  joins Wi-Fi and shows the result on its 160x80 LCD. Built to act as the status
  display for a headless Raspberry Pi 5: the `PI` indicator lights only once the
  Pi has enumerated the dongle's USB, and the screen reports link state, IP,
  RSSI, channel and uptime.

Credentials live in a gitignored `secrets.h`; see the firmware README.
