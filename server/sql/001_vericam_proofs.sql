-- Tiger Data / Timescale (plain Postgres works if create_hypertable is absent).
-- Applied on server boot. Safe to re-run.
--
-- vericam_proofs: one append-only row per authenticated publish.
-- The digest and frame_hashes are recomputed by mobile/core.mjs verifyEvidence,
-- not copied from the client. payload_sha256 is SHA-256 of the exact object bytes.
--
-- vericam_proof_checks: one row per corroboration (genuine / tampered / unknown).
--
-- Hourly counts once Timescale is present:
--   SELECT time_bucket('1 hour', time) AS bucket, verdict, count(*)
--   FROM vericam_proof_checks
--   WHERE time > now() - interval '24 hours'
--   GROUP BY 1, 2 ORDER BY 1;

CREATE TABLE IF NOT EXISTS vericam_proofs (
  time            timestamptz NOT NULL DEFAULT now(),
  video_id        text        NOT NULL,
  object_key      text        NOT NULL,
  public_url      text        NOT NULL,
  uid             text        NOT NULL,
  seed            text        NOT NULL,
  digest          text        NOT NULL,
  payload_sha256  text        NOT NULL,
  width           int         NOT NULL,
  height          int         NOT NULL,
  frame_count     int         NOT NULL,
  frame_hashes    jsonb       NOT NULL,
  verdict         text        NOT NULL CHECK (verdict = 'genuine'),
  label           text,
  PRIMARY KEY (time, video_id)
);

CREATE INDEX IF NOT EXISTS vericam_proofs_object_key_time
  ON vericam_proofs (object_key, time DESC);

CREATE INDEX IF NOT EXISTS vericam_proofs_public_url_time
  ON vericam_proofs (public_url, time DESC);

CREATE TABLE IF NOT EXISTS vericam_proof_checks (
  time                   timestamptz NOT NULL DEFAULT now(),
  check_id               text        NOT NULL,
  object_key             text        NOT NULL,
  public_url             text        NOT NULL,
  video_id               text,
  verdict                text        NOT NULL CHECK (verdict IN ('genuine', 'tampered', 'unknown')),
  reason                 text,
  digest                 text,
  recorded_digest        text,
  first_divergent_frame  int,
  PRIMARY KEY (time, check_id)
);

CREATE INDEX IF NOT EXISTS vericam_proof_checks_object_key_time
  ON vericam_proof_checks (object_key, time DESC);

SELECT create_hypertable('vericam_proofs', 'time', if_not_exists => true);
SELECT create_hypertable('vericam_proof_checks', 'time', if_not_exists => true);
