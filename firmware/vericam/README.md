# VeriCam ESP32-CAM + mobile app

Implements the phone-camera / BLE / S50 commitment flow from `NEWPLAN.md`.
Target: classic ESP32 AI-Thinker ESP32-CAM, not ESP32-C3. The phone captures
the images; the ESP32's camera is not initialized. Wi-Fi credentials live in
gitignored `include/secrets.h` (copy `secrets.h.example` when building elsewhere).
See [React/backend integration](integration/README.md) for outbound signed HTTPS
events, Vultr reverse proxy and Tiger Data contracts.

## RC522 wiring (confirm board model first)

Disconnect power while wiring. Remove the microSD card: these pins share the SD
interface. Use an RC522 SPI reader and a disposable, factory-key MIFARE Classic
1K / S50 card. The app overwrites sector 1 data blocks 4 and 5 only, never trailer
block 7. Existing non-default keys are not supported.

| RC522 | AI-Thinker ESP32-CAM GPIO |
|---|---|
| SDA / SS | 13 |
| SCK | 14 |
| MOSI | 15 |
| MISO | 12 |
| RST | 2 |
| 3.3V | 3V3 (never 5V) |
| GND | GND |
| IRQ | unconnected |

GPIO12 is a boot strap: the reader must not pull it high during reset. If the
board fails to boot, disconnect the reader and inspect its MISO pull-ups. GPIO2
is also a boot strap; disconnect the reader during flashing if necessary.
Power the ESP32-CAM through its USB base or a suitable regulated 5V input;
all SPI signals are 3.3V. Do not use the C3 pin mapping in the original plan.

## Build and flash

Install PlatformIO in a Python virtual environment, then:

```sh
pio run -d firmware/vericam
pio run -d firmware/vericam -t upload --upload-port /dev/ttyUSB0
pio device monitor -b 115200 -p /dev/ttyUSB0
```

If auto-reset does not enter the loader, connect GPIO0 to GND, reset, flash,
then remove that jumper and reset. Serial prints the RC522 version (00/FF means
absent). BLE still advertises without a reader, enabling phone connection tests.

## Mobile hosting and use

Copy `mobile/index.html`, `mobile/app.mjs`, and `mobile/core.mjs` to your HTTPS
site's document root. These three static files require no build step. The app is
split into modules for testing rather than the plan's single inline HTML file.
Use `mobile/Caddyfile.example` for a Vultr host with DNS pointing to it and ports
80/443 open. No Vultr credentials or hostname are stored in this repo.

For desktop development: `python3 -m http.server 8000 --directory mobile` and
open `http://localhost:8000`. A phone accessing a LAN IP still needs HTTPS.
Use Chrome on Android, or an iOS browser that exposes Web Bluetooth and camera
APIs (test Bluefy on the actual phone); Safari does not expose Web Bluetooth.

1. Connect to **VeriCam-HSM**, start the camera and grant permissions.
2. Tap Capture, then hold the S50 card at the reader. Remove and re-tap between
   operations because completed transactions halt the card.
3. The phone hashes 25 distinct browser-presented 160×120 RGBA frames. Firmware
   enforces 1,100 ms from card selection to write/readback completion. Slower
   camera/BLE/browser combinations fail instead of claiming success.
4. Download the evidence JSON (about 2.6 MB). It contains the initial card state,
   UID, exact pixels, timing metadata and digest. It is not an encoded MP4.
5. Load that JSON later, press Verify and tap the same card: the pixels are
   rehashed and compared with freshly read physical bytes and UID.
6. Load a comparison video and compare its 25 presented decoded frames against
   the card using the original evidence's UID/seed. Decoding is not a canonical
   video hashing scheme; even a lossy encoding of the original can mismatch.

The optional generation hook POSTs the evidence JSON to an explicitly supplied
same-origin URL and expects a `video/*` response. Implement provider credentials
and generation on your server; there is no assumed provider or fabricated twin.

## Protocol v1

Service `f3641400-00b0-4240-ba50-05ca45bf8abc`; write command characteristic
`f3641401-00b0-4240-ba50-05ca45bf8abc`; read state characteristic
`f3641402-00b0-4240-ba50-05ca45bf8abc`. Reads use GATT long reads; writes fit the
default 23-byte ATT MTU. No pairing PIN. One client/transaction at a time.

- Begin/read: ASCII B/R + 4 random session bytes. Wait up to 15 seconds for card.
- Commit: ASCII C + session + offset byte + 14 digest bytes. Offsets 0,14,28;
  last packet padded with zeroes. Strict ordering, current session only.
- Cancel: ASCII X + session. Disconnect cancels active state and clears queue.
- State: version (1), status, UID length, operation, session[4], elapsed uint32
  little-endian, UID[10] zero-padded, card bytes[32]. Total 54 bytes.
- Status: 0 idle, 1 waiting, 2 seed ready, 3 written/read-back, 4 read complete;
  0x80 absent reader, 81 unsupported card, 82 auth/read error, 83 expired,
  84 no card, 85 packet order error, 86 partial/failed write, 87 late write.

H0 = SHA256(UTF8("VeriCam-v1:160x120:25:RGBA") || UID-length-u8 || UID || seed32).
Hi+1 = SHA256(Hi || frame-index-u8 || frame-RGBA), indices 0..24.
Only H25 is stored on the card. Original seed must be kept in the evidence.

## Scope of the result

This proves consistency with mutable card bytes, not human/scene authenticity.
The browser receives processed camera pixels, not raw CMOS data. There is no
trusted camera path, device signing key, distance bounding or measured BLE range.
MIFARE Classic/default keys and BLE do not provide a tamper-resistant HSM. A
modified client can commit an arbitrary digest. Timing alone cannot rule out
synthetic/precomputed frames. Two block writes are non-atomic: interruption or a
late write can change the card even when the operation reports failure. The app
only reports a successful commitment after matching readback within the window.

Run `node --test mobile/core.test.mjs` for deterministic chain/parser checks.
Physical acceptance still needs the phone and RC522: test successful capture,
reloaded evidence, modified frames, wrong card, early removal, slow capture and
disconnect/reconnect. Measure real phone timings before using the 1.1s target.
