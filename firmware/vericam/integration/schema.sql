-- Tiger Data / PostgreSQL. Regular table: durable idempotency across retries.
CREATE TABLE IF NOT EXISTS vericam_events (
    device_id text NOT NULL,
    boot_id text NOT NULL,
    sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 4294967295),
    received_at timestamptz NOT NULL DEFAULT now(),
    state bytea NOT NULL CHECK (octet_length(state) = 54),
    raw_body bytea NOT NULL,
    signature bytea NOT NULL CHECK (octet_length(signature) = 32),
    PRIMARY KEY (device_id, boot_id, sequence)
);
-- After verifying the HMAC with the registered device's key, use parameterized:
-- INSERT INTO vericam_events(device_id,boot_id,sequence,state,raw_body,signature)
-- VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING;
-- Respond 2xx only after commit (including an already-persisted identical event).
