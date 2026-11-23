-- 002_callyzer.sql
-- Callyzer call tracking integration: stores real phone call data from BPO partner.
-- Additive and idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION normphone(p TEXT) RETURNS TEXT AS $$
  SELECT RIGHT(REGEXP_REPLACE(COALESCE(p,''), '[^0-9]', '', 'g'), 10);
$$ LANGUAGE SQL IMMUTABLE;

CREATE TABLE IF NOT EXISTS callyzer_calls (
  id                 BIGSERIAL PRIMARY KEY,
  callyzer_call_id   TEXT UNIQUE,
  emp_name           TEXT,
  emp_number         TEXT,
  client_number      TEXT NOT NULL,
  client_number_norm TEXT NOT NULL,
  call_type          TEXT,            -- incoming / outgoing / missed / rejected
  call_method        TEXT,            -- PhoneCall / WhatsAppCall
  call_mode          TEXT,            -- Voice / Video
  call_duration      INTEGER DEFAULT 0,
  call_date          DATE,
  call_time          TIME,
  call_recording_url TEXT,
  order_id           UUID REFERENCES orders_master(id),
  raw_data           JSONB NOT NULL DEFAULT '{}',
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_callyzer_client_norm ON callyzer_calls(client_number_norm);
CREATE INDEX IF NOT EXISTS idx_callyzer_date        ON callyzer_calls(call_date DESC);
CREATE INDEX IF NOT EXISTS idx_callyzer_order       ON callyzer_calls(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_callyzer_emp         ON callyzer_calls(emp_name, call_date);

-- Sync tracking
CREATE TABLE IF NOT EXISTS callyzer_sync_log (
  id         BIGSERIAL PRIMARY KEY,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  from_date  TEXT,
  to_date    TEXT,
  calls_fetched INTEGER DEFAULT 0,
  calls_new     INTEGER DEFAULT 0,
  calls_matched INTEGER DEFAULT 0,
  error      TEXT
);
