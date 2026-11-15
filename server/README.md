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

Setup:
- **Mongo**: Atlas free cluster -> Network Access allow the VPS IP -> copy `mongodb+srv://...` URI.
- **Tiger**: create a Tiger Cloud service -> copy the connection string (`postgres://...?sslmode=require`). Table + hypertable are created on boot.
- **Solana**: `npm run solana:keygen` -> airdrop devnet SOL to the printed pubkey -> paste the JSON array into `SOLANA_SECRET_KEY`.
- **Gemini**: key from https://aistudio.google.com/apikey. Models via `GEMINI_IMAGE_MODEL` / `GEMINI_TEXT_MODEL`.

Endpoints: `GET /api/health`, `POST|GET /api/clips`, `POST /api/events`, `GET /api/events/stats`, `POST /api/twin`, `POST /api/explain`.

Deploy (Vultr): copy repo to `/opt/vericam`, `npm ci` in `server/`, create user `vericam`, then
`sudo cp vericam.service /etc/systemd/system/ && sudo systemctl enable --now vericam`. Caddy: `reverse_proxy /api/* localhost:8787`.
