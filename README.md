# neurogrep

Hardware utilities and firmware that happen to live in one repo.

## Contents

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
