# React / Vultr / Tiger Data handoff

## Architecture

React (HTTPS) ↔ Web Bluetooth ↔ ESP32 ↔ RC522/S50.
ESP32 → venue Wi-Fi → HTTPS ingestion API behind Vultr reverse proxy → Tiger Data.
React → backend API/SSE/WebSocket for persisted live events.

The 1,100 ms card operation stays local over BLE; Internet latency is outside
that deadline. Wi-Fi is for outbound events, not public inbound ESP32 access.
No port forwarding or cloud-to-venue route is required. The firmware does not
serve the React application or initialize the onboard camera.

## Firmware provisioning

`include/secrets.h` is gitignored. Copy `secrets.h.example` there on another
machine. Set Wi-Fi SSID/password. Optional cloud delivery needs all three:

- `VERICAM_EVENT_URL`: final HTTPS POST endpoint, e.g. `https://host/api/device-events`.
- `VERICAM_EVENT_KEY`: a unique random secret of at least 32 characters.
- `VERICAM_ROOT_CA`: the PEM root certificate for that server's certificate chain
  (a C++ raw string literal can hold multiline PEM).

Rebuild/flash after provisioning. Credentials are embedded in firmware, not
hardware-protected. The shared secret authenticates transport events; it is not
a camera-attestation or asymmetric signing key. Never put it in React assets.
Without a configured endpoint/key/CA, BLE works and Wi-Fi joins, but cloud
delivery is explicitly disabled. TLS certificate verification is mandatory.
The network must support 2.4 GHz and the SSID is case-sensitive. SNTP must be
reachable to initialize the clock before TLS delivery; events wait in the
bounded queue until the clock is initialized.

## React BLE contract

Use service/command/state UUIDs and packet layout from the parent README.
`mobile/core.mjs` is a UI-independent reference for constants, state parsing,
hashing and preserved-frame evidence verification; it can be copied into the
separate React project. `mobile/app.mjs` demonstrates the transaction order.

Connect from a user gesture with `navigator.bluetooth.requestDevice`, filter
on the service UUID, get the write/read characteristics, and use
`writeValueWithResponse`. Poll `readValue()` for matching session/status; do not
overlap GATT calls. Subscribe to `gattserverdisconnected` to clear UI state.
Use a new random four-byte session per transaction. Begin B waits for a card;
status 2 yields initial UID/seed; commit C sends three ordered packets; status 3
is the only successful commitment. Check returned digest and elapsed time.
R reads a fresh card without writing. X cancels the matching session. Error
0x80 means reader absent; other error definitions are in the parent README.

The ESP32 accepts a 32-byte digest; the React client must implement the agreed
frame hashing and preserve the initial seed. A card match and an authenticated
device event are separate checks. The React application should show both local
commit status and cloud persistence status, never infer the latter from BLE.

## Backend event contract

POST JSON, `Content-Type: application/json`, `X-VeriCam-Signature: <64 lowercase hex>`.
Signature is HMAC-SHA256 over the **exact raw request body**, using the device key.
Body fields: `version:1`, `device` (12 hex device ID, printed at boot), `boot`
(32 hex random boot nonce), `sequence` (positive uint32), `state` (108 hex,
the unchanged 54-byte BLE state). Do not assume device ID matches the displayed
BLE MAC: it is derived from eFuse bytes. Provision using the printed ID.

Events are emitted for commit success (3), read completion (4), and errors
(0x80–0x87). No camera frames or Wi-Fi credentials are sent. The event has no
trusted wall-clock timestamp; store server receive time and device elapsed time.

Implement the ingestion route with a 1 KB body limit, retain the raw body,
look up the provisioned key by device ID, then call `verifyEvent` from the
reference module. Reject unknown devices, bad signatures and invalid payloads.
Persist with `schema.sql` using parameterized queries. Deduplicate by
device/boot/sequence; a replay must not create a new live capture event. Only
publish to authorized React subscribers after the database commit. Keep the
database DSN and per-device keys on the server. The reference verifier alone
does not implement device enrollment, database persistence or subscriber auth.

Firmware queues up to 16 events in RAM, independently of the RFID loop. It
reconnects Wi-Fi, attempts HTTPS delivery up to three times, and logs drops.
Offline buffering is bounded and lost on reboot; this is best-effort live
telemetry, not a durable audit log. Respond 2xx only after durable ingestion.

On Vultr, proxy `/api/*` to the backend over loopback and terminate HTTPS at
the public hostname (the existing Caddy example illustrates hosting). Tiger
Data is reached by the backend using its TLS Postgres DSN, never by the ESP32
or browser. Deployment requires the actual hostname, backend access and DB
connection configuration; none are assumed here.

Test reference verification with:
`node --test firmware/vericam/integration/verify-event.test.mjs`.
