# VeriCam

Hardware-bound video capture. A MIFARE S50 card's Sector 1 state seeds a SHA-256 chain over 25 camera frames. The ESP32 burns the final digest back onto the card, but only if it arrives within 1100 ms of the card read. See `NEWPLAN.md`.

| Part | Path |
|---|---|
| ESP32-C3 + RC522 BLE firmware | `firmware/vericam-hsm/` (`./flash.sh`, needs arduino-cli + esp32 core + MFRC522 lib) |
| Mobile app — React Native (Expo dev build, native BLE + VisionCamera) | `mobile/` |
| Backend (Vultr) | `server/` |
| HTTPS proxy | `server/Caddyfile` |

Wiring: `SDA->7 SCK->4 MOSI->6 MISO->5 RST->3 3.3V->3V3 GND->GND`. The card must use the default key A (`FFFFFFFFFFFF`) on sector 1.

Chain: `h0 = SHA256("VeriCam-v1" || uid || block4..5)`, then `h_i = SHA256(h_{i-1} || u32le(i) || frame_i)`. The final hash goes to blocks 4 and 5. A clip stores its own seed, the pre-burn card state, so a verifier can recompute the chain.

No hardware? Use **Demo mode**: a virtual card held in local storage, with the same protocol and the same deadline.

## MLH Hack the Nest tracks

| Track | How VeriCam uses it |
|---|---|
| Best Use of Gemini API | `/api/twin` builds the UGC twin with a Gemini image model. `/api/explain` writes the judge-facing verdict. |
| Best Use of Solana | Each burned digest is anchored on devnet through an SPL Memo tx (`vericam:v1:<uid>:<digest>`). |
| Best Use of Tiger Data | Capture, burn and verify events go into a Timescale hypertable. `/api/events/stats` uses `time_bucket`. Published clips also get a `vericam_proofs` row (digest, per-frame hashes, public S3 URL) that a later check corroborates. |
| Best Use of Vultr | Vultr hosts the HTTPS API for the app (Caddy + systemd). |
| Best Use of MongoDB Atlas | Clip registry (`vericam.clips`). |
| DEV Writing Challenge | Draft in `DEV_POST.md`. |
| SpaceXSI / xAI raffle | Qualifies by building with Cursor + Grok Bot. That's a process requirement, not code. |
