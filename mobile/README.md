# VeriCam mobile (Expo dev build)

React Native app: BLE link to `VeriCam-HSM` (or a virtual S50 card),
25-frame / 850 ms SHA-256 capture chain burned to the card, UGC twin, and judge verification.

## Build

```sh
npm install
npx expo prebuild
npx expo run:android   # or: npx expo run:ios
```

**Why a dev build (not Expo Go):** BLE (`react-native-ble-plx`), VisionCamera frame processors
(`react-native-vision-camera` v4 + `react-native-worklets-core`) and native SHA-256
(`react-native-quick-crypto` / Nitro) are native modules that Expo Go does not ship.

## Notes

- Chain is byte-identical to the web app: `seed = SHA256("VeriCam-v1"||uid||cardState32)`,
  `h_i = SHA256(h_{i-1}||u32le(i)||frameBytes)`. Code: `src/chain.ts`. BLE protocol: `src/hsm.ts`.
- Mobile frames are raw `rgb` (or `yuv`, toggle on Capture tab) buffers from `frame.toArrayBuffer()`,
  not canvas RGBA, so mobile clips verify against mobile-recomputed chains, not web ones.
- Clips persist in `documentDirectory/clips/clip{A,B}.vcam` (web `.vcam` layout + per-frame sizes and
  `pixelFormat` in the header); thumbnails are `takeSnapshot()` JPEGs. Virtual card: `vcam-card.json`.
- Twin = deterministic ±1 LSB re-quantization of A's frames ("local resynthesis"); the API button
  additionally sends A's thumbnail JPEG to `/api/twin` for the displayed thumbnail.
- API base: `app.json` → `extra.apiBase`, editable on the Link tab. All backend calls fail soft.
