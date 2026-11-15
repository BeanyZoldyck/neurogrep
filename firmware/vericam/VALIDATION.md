# Bench validation · 2026-11-15

- Connected USB serial device identified as ESP32-D0WD-V3 revision 3.1.
- PlatformIO esp32cam build passed: 39,268 bytes RAM, 1,133,681 bytes flash.
- Firmware uploaded successfully; flash hashes verified by esptool.
- Serial boot: `VeriCam ready; RC522 version: 0x00` (reader disconnected).
- Real BLE scan discovered `VeriCam-HSM`; connected with Bleak, read the
  54-byte v1 state, wrote a read command and received correlated error 0x80.
- Node tests passed for independent hash-chain reproduction, frame reordering,
  invalid evidence and state parsing with a nonzero DataView offset.
- Chromium localhost smoke check loaded the app/module, confirmed capture is
  disabled before connection and exercised Web Crypto hashing.

Pending: board silkscreen/pinout confirmation, RC522 wiring, real card read /
write / readback, phone BLE/camera permissions and 25-frame timing, HTTPS host
deployment, and a configured generation backend. No end-to-end hardware
commitment or mobile-browser compatibility result is claimed yet.

## Wi-Fi / backend handoff update

- User confirmed ESP32-CAM and HiLetgo RC522/S50 kit.
- Added Wi-Fi reconnect and independent-task HTTPS event delivery with HMAC-SHA256,
  mandatory CA validation, bounded retries and RAM queue.
- Updated build/upload passed; final image uses 59,920 bytes RAM and 1,692,249
  bytes flash. Firmware boot confirmed after flashing.
- Corrected SSID casing to the observed `HackTheNest`. Device joined successfully:
  IP `164.76.13.128`, RSSI -71 dBm. Device ID `28562f710cf0`.
- BLE hardware smoke test passed with the Wi-Fi-enabled firmware.
- Three Node tests passed, including rejection of altered event bytes/wrong key.
- Wi-Fi credentials are in ignored `include/secrets.h`, not tracked source.
- RC522 still reports 0x00. Card testing awaits wiring. HTTPS endpoint, device
  event key and CA remain unconfigured; no Vultr/Tiger Data delivery is claimed.
