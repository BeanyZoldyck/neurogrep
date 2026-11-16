# provenance

Hardware utilities and firmware that happen to live in one repo.

## Contents

- [`firmware/vericam`](firmware/vericam) — ESP32-CAM BLE/RC522 firmware and
  [`mobile`](mobile) HTTPS phone-camera app implementing the card commitment
  flow in `NEWPLAN.md`. See its README for wiring, flashing and verification.

- [`firmware/tdongle-s3`](firmware/tdongle-s3) - Arduino firmware for the LilyGo
  T-Dongle-S3: joins Wi-Fi and shows link state, IP, RSSI, channel and uptime on
  its 160x80 LCD. The `PI` indicator lights only once a USB host has enumerated
  the dongle.

- [`firmware/tdongle-s3-bridge`](firmware/tdongle-s3-bridge) - ESP-IDF firmware
  that turns the dongle into the Pi's actual network adapter: a USB-NCM gadget
  bridged at layer 2 to Wi-Fi, so the Pi gets its own DHCP lease from the router
  and needs no software installed. The screen shows the Pi's address, signal and
  forwarded packet rate.

Credentials live in a gitignored `secrets.h`; see the firmware README.

## Public video check

A shared clip is a `vericam-rgba-v1` evidence file: 25 raw 160×120 RGBA frames and the SHA-256 chain from [`mobile/core.mjs`](mobile/core.mjs). The server publishes that JSON to the public bucket and stores the recomputed proof in Tiger Data. Anyone can recompute it from the object URL with no AWS credentials:

`https://neurogrep-public-1794752476.s3.amazonaws.com/<key>`

The bucket allows anonymous `s3:GetObject` only. Listing is not public. Setup, the upload and sweep commands, and `npm run demo:share` are in [`server/README.md`](server/README.md).
