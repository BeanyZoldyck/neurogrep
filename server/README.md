# VeriCam server

Express API for VeriCam (Hack the Nest). Every integration is optional: unset env var -> logged + skipped, so `npm start` works with zero config (in-memory clips/events).

```sh
cd server && npm install && cp .env.example .env && npm start   # :8787
```

| Integration | Env | MLH track | What it does |
|---|---|---|---|
| MongoDB Atlas | `MONGODB_URI` | Best Use of MongoDB Atlas | Clip registry (db `vericam`, coll `clips`) |
| Tiger Data (Timescale) | `TIGER_DATABASE_URL` | Best Use of Tiger Data | `vericam_events` hypertable, hourly `time_bucket` stats |
| Solana | `SOLANA_SECRET_KEY`, `SOLANA_RPC` | Best Use of Solana | Anchors `vericam:v1:<uid>:<digest>` via SPL Memo (devnet) |
| Google Gemini | `GEMINI_API_KEY` | Best Use of Gemini API | `/api/twin` UGC twin frames, `/api/explain` judge text |
| Vultr | (deploy) | Best Use of Vultr | VPS host behind Caddy |
| Public S3 | `S3_BUCKET` (default `neurogrep-public-1794752476`) | share + public verify | Evidence JSON in a public-read bucket; writes need IAM keys |

Setup:
- **Mongo**: Atlas free cluster -> Network Access allow the VPS IP -> copy `mongodb+srv://...` URI.
- **Tiger**: create a Tiger Cloud service -> copy the connection string (`postgres://...?sslmode=require`). Table + hypertable are created on boot.
- **Solana**: `npm run solana:keygen` -> airdrop devnet SOL to the printed pubkey -> paste the JSON array into `SOLANA_SECRET_KEY`.
- **Gemini**: key from https://aistudio.google.com/apikey. Models via `GEMINI_IMAGE_MODEL` / `GEMINI_TEXT_MODEL`.

Endpoints: `GET /api/health`, `POST|GET /api/clips`, `POST /api/events`, `GET /api/events/stats`, `POST /api/twin`, `POST /api/explain`, `POST /api/share/videos`, `GET|POST /api/share/verify`, `POST /api/share/sweep`.

Deploy (Vultr): copy repo to `/opt/vericam`, `npm ci` in `server/`, create user `vericam`, then
`sudo cp vericam.service /etc/systemd/system/ && sudo systemctl enable --now vericam`. Caddy: `reverse_proxy /api/* localhost:8787`.

## Public S3 share and Tiger Data corroboration

The public bucket is `neurogrep-public-1794752476` in `us-east-1`. Public access block is off. The bucket policy allows anonymous `s3:GetObject` and does not allow `s3:ListBucket` or `s3:PutObject` (`s3/public-read-policy.json` matches that rule). Object URLs use the us-east-1 virtual-hosted form, with no region label in the host:

`https://neurogrep-public-1794752476.s3.amazonaws.com/<key>`

A missing key returns HTTP 403, because S3 hides existence when the caller cannot list. Verify treats 403 and 404 as "no object".

### What is verified

VeriCam commits 25 raw 160×120 RGBA frames, not an encoded video file. The web app saves that set as `vericam-rgba-v1` JSON. `verifyEvidence` in `mobile/core.mjs` recomputes the chain, and this service calls that function plus the same `initial` / `step` helpers for the per-frame hashes:

```
h0 = SHA256("VeriCam-v1:160x120:25:RGBA" || u8(uidLen) || uid || seed)
h_i = SHA256(h_{i-1} || u8(i) || frame_i)
```

The phone's downloaded evidence file is the object that goes in the bucket. The native card burn in `mobile/src/chain.ts` hashes raw rgb/yuv with a `u32le` frame index, so `.vcam` clips are a different byte chain. Upload the web evidence JSON.

On upload the server ignores any digest in the file, runs `verifyEvidence`, then writes two things: the evidence JSON at `videos/<uuid>.json`, and an append-only Tiger Data row with the digest, the 25 frame hashes, the SHA-256 of the object bytes, the key, and the public URL.

### Verdicts

`GET /api/share/verify?key=` or `?url=` (also `POST`) fetches that public URL with `fetch`. It does not sign the request and it does not list the bucket.

| Verdict | Meaning |
|---|---|
| `genuine` | The object bytes and the frame chain match the latest Tiger row for that key |
| `tampered` | A Tiger row exists, and the object is missing, unreadable, or its bytes or frame chain differ |
| `unknown` | No Tiger row. The response still includes the recomputed digest when the object parses |

URLs outside the configured public base are rejected. Redirects are not followed.

### Automation

Upload (IAM keys + `VERICAM_UPLOAD_KEY` + `TIGER_DATABASE_URL`):

```sh
curl -fsS -X POST http://127.0.0.1:8787/api/share/videos \
  -H "authorization: Bearer $VERICAM_UPLOAD_KEY" \
  -H 'content-type: application/json' \
  --data-binary @vericam-evidence.json
```

`npm run share:upload -- vericam-evidence.json` calls the same function. The CLI reads `VERICAM_UPLOAD_KEY` from the environment.

Verify needs no AWS credentials. With Tiger configured it returns genuine / tampered / unknown. Without Tiger it still GETs the object and reports `unknown`.

```sh
npm run share:verify -- --key videos/<uuid>.json
npm run share:verify -- --url https://neurogrep-public-1794752476.s3.amazonaws.com/videos/<uuid>.json
```

Exit codes: `0` genuine, `1` unknown, `2` tampered, `3` usage or config error.

Sweep walks keys already stored in Tiger and public-GETs each one. It lists the bucket only when `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are set, via `ListObjectsV2`. If that call fails, the Tiger keys are still checked. `POST /api/share/sweep` requires the upload key so the catalog is not public. `npm run share:sweep` is the operator command. Set `SHARE_SWEEP_INTERVAL_MS` (at least `10000`) to run it inside the server process. Cron:

```
*/10 * * * * cd /opt/vericam/server && npm run share:sweep
```

Sweep exit codes: `0` all genuine, `1` any unknown, `2` any tampered.

### Schema

`sql/001_vericam_proofs.sql` runs on boot.

- `vericam_proofs` hypertable on `time`: `video_id`, `object_key`, `public_url`, `uid`, `seed`, `digest`, `payload_sha256`, `frame_hashes` (jsonb, one SHA-256 per frame), `verdict` (`genuine` at publish), `label`.
- `vericam_proof_checks` hypertable on `time`: each corroboration and its verdict. Hourly counts use `time_bucket('1 hour', time)` (see the comment in the SQL file).

`create_hypertable` is skipped with a log line when the server is pointed at plain Postgres, and the tables still work. Apply by hand with `psql "$TIGER_DATABASE_URL" -f sql/001_vericam_proofs.sql`. Do not apply `firmware/vericam/integration/schema.sql` to this database: it creates a different `vericam_events` shape than `lib/tiger.js`.

### Credentials to fill in

Copy `.env.example` to `.env`. The bucket name, region, and public base URL are already set. Leave them. Supply:

| Variable | What the owner provides |
|---|---|
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | IAM user that can `s3:PutObject`, `s3:GetObject`, and `s3:ListBucket` on this bucket (`s3/uploader-iam-policy.json`). Required for upload and for a sweep that lists. Public verify works with both empty. |
| `VERICAM_UPLOAD_KEY` | A long random string you invent. Clients send `Authorization: Bearer`. |
| `TIGER_DATABASE_URL` | Tiger Cloud Postgres URL, `postgres://…?sslmode=require`. `DATABASE_URL` is the fallback name. |

Do not commit `.env`. Do not add `s3:PutObject` or `s3:ListBucket` for `Principal: "*"`.

### Offline demo and tests

```sh
cd server && npm install && npm test && npm run demo:share
```

`npm run demo:share` publishes a synthetic evidence file through the HTTP API, then shows `genuine`, `tampered` (pixel change in frame 3), and `unknown`. The sweep in that demo has no list credentials, so it only walks the in-memory records. It does not contact the public bucket.

`npm test` mocks S3 with `aws-sdk-client-mock` (the Node equivalent of moto: `PutObject` / `ListObjectsV2` are asserted, and verify is asserted not to call them) and runs the proof SQL on `pg-mem`. `mobile/core.test.mjs` still covers `verifyEvidence`.

Live path, after the three secrets above are in `.env`:

```sh
npm run share:sample -- /tmp/vericam-evidence.json   # synthetic chain, for a pipeline demo
npm run share:upload -- /tmp/vericam-evidence.json
npm run share:verify -- --key videos/<uuid>.json
curl -I "https://neurogrep-public-1794752476.s3.amazonaws.com/videos/<uuid>.json"
```

A real clip is the evidence JSON the web app downloads, not the synthetic sample.

### S3-compatible stores

Set `S3_ENDPOINT` and `S3_PUBLIC_BASE_URL`. `S3_FORCE_PATH_STYLE` defaults to true when an endpoint is set (MinIO, moto). R2's public URL is not the API host, so set `S3_PUBLIC_BASE_URL` to the `r2.dev` or custom origin. Leave `S3_OBJECT_ACL` empty when a bucket policy grants `GetObject`. Set `S3_OBJECT_ACL=public-read` only for a store that still uses object ACLs. Moto example: `S3_ENDPOINT=http://127.0.0.1:5000`, `S3_PUBLIC_BASE_URL=http://127.0.0.1:5000/neurogrep-public-1794752476`, test keys `testing` / `testing`.
