**One-Line Technical Proof:**
The system binds the physical S50 card’s Sector 1 EEPROM state (read via less than 4 cm NFC and relayed over less than 5 m Web Bluetooth) into a rolling SHA-256 hash chain across 25 live CMOS sensor frames and burns the resulting digest back onto the card within a ~1.1-second active RF session window—a physical and temporal bottleneck too short for cloud V2V/UGC synthesis to return frames and byte-level deterministic so any post-capture synthetic twin fails the card's EEPROM comparison.

---

### Final Execution Plan

1. **Hardware Node (ESP32-C3 + RC522):**
* Wire the RC522 to the ESP32-C3 (`SDA->7`, `SCK->4`, `MOSI->6`, `MISO->5`, `RST->3`, `3.3V->3V3`, `GND->GND`) and flash the `VeriCam-HSM` BLE firmware.
* Power the rig on-site via USB or a battery pack. The ESP32 stays within local BLE range (less than 5 meters) of the recording phone.


2. **Mobile Web App & Vultr Proxy:**
* Host the single-file `index.html` over HTTPS via your **Vultr** reverse proxy (required to unlock both `navigator.mediaDevices.getUserMedia` and `crypto.subtle` alongside Web Bluetooth).
* Open the URL on your phone (via **Bluefy** on iOS or **Chrome** on Android) and connect to the `VeriCam-HSM` BLE peripheral.


3. **Capture & Hardware Commitment (On-Site Lock):**
* Hold the physical S50 card against the RC522 reader for ~1.2 seconds while pointing the phone camera at the scene.
* **T = 0 ms:** The ESP32 reads the card's UID and current 32-byte Sector 1 EEPROM state and pushes it to the phone over BLE.
* **T = 0–850 ms:** The web app captures 25 raw CMOS frames, chaining each frame's pixel buffer with the card's initial EEPROM state using SHA-256.
* **T = 900–1100 ms:** Before the card leaves the 4 cm RF field, the phone sends the final 256-bit rolling hash back over BLE, and the ESP32 burns it directly into Blocks 4 and 5 of the S50 card.


4. **The Live Judge Verification (Real vs. UGC Twin):**
* Once the on-site clip (**Video A**) is recorded and burned to the card, generate/load the visually identical **UGC Twin** (**Video B**) via your API hook in the side-by-side arena.
* **Test 1 (Authentic):** Select **Video A** on the phone and tap the physical S50 card on the RC522 reader $\rightarrow$ **PASS (`✅ HARDWARE VERIFIED`)** because the recomputed rolling frame hash matches the physical bytes on Sector 1 of the card.
* **Test 2 (Synthetic/UGC):** Select **Video B (UGC Twin)** and tap the *exact same* S50 card $\rightarrow$ **FAIL (`❌ UGC / SYNTHETIC INJECTION REJECTED`)** because the UGC model could not execute inside the 1.1-second RF write window during inception, and its synthesized pixel tensors produce a divergent hash chain that clashes with the card's burned EEPROM state.
