---
title: "VeriCam: proving a video was shot here, now, with a $3 NFC card"
tags: hackathon, security, esp32, reactnative
---

Generative video can produce a pixel-perfect twin of any clip. Metadata can be forged and watermarks can be stripped. We wanted a proof that only physical presence can produce.

**The idea:** the camera's frames get hashed into a chain that starts from the bytes on a physical MIFARE S50 card. The finished hash goes back onto the same card while it is still sitting in the reader's 4 cm RF field. The burn window is about 1.1 seconds.

## How it works
1. An ESP32-C3 with an RC522 reader exposes a BLE service called `VeriCam-HSM`.
2. You tap the card. The ESP32 reads its UID and Sector 1 blocks 4–5 and pushes them to the phone.
3. The phone captures 25 frames in 850 ms. For each frame: `h = SHA256(h || i || pixels)`.
4. The phone sends the final digest back. The ESP32 burns it to blocks 4–5 only if it arrives inside the window, then reads it back to confirm.
5. To verify, tap the card again. The app recomputes the chain over the clip and compares the result byte for byte with the card.

A twin of the clip that looks the same but has different pixels gives a different chain, so it gets rejected.

## Stack
ESP32-C3 + RC522 · React Native (Expo, ble-plx, VisionCamera) · Vultr + Caddy · MongoDB Atlas (clip registry) · Tiger Data (event hypertable) · Solana devnet memo anchoring · Gemini (twin generation + verdict explanations).

## What we learned
- MIFARE Classic keeps its Crypto1 session open as long as the card stays powered. The firmware therefore holds the session through the BLE round trip and writes without re-authenticating.
- Raw pixel buffers are the only deterministic thing to hash. Encoded video is not reproducible byte for byte.

## Honest limits
The card proves that the digest was written within roughly a second of the card read, by someone holding that card. It does not by itself prove what the camera was pointed at. A live injected feed during capture would still chain fine. Next steps are attested camera pipelines and secure-element keys.
