-- 001_cc_features.sql
-- Call-centre login, richer dispositions, prepaid links + incentives, reporting.
-- Additive and idempotent: safe to re-run, does not drop or rewrite existing data
-- (except the queue re-assignment in section 6, which is audited in order_status_events).

-- 1. AGENTS (login accounts) ------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username       TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  is_backup      BOOLEAN NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  token_version  INTEGER NOT NULL DEFAULT 1,
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. NEW COLUMNS ON orders_master -------------------------------------------
ALTER TABLE orders_master ADD COLUMN IF NOT EXISTS callback_at        TIMESTAMPTZ;
ALTER TABLE orders_master ADD COLUMN IF NOT EXISTS callback_note      TEXT;
ALTER TABLE orders_master ADD COLUMN IF NOT EXISTS dnc                BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders_master ADD COLUMN IF NOT EXISTS dnc_by             TEXT;
ALTER TABLE orders_master ADD COLUMN IF NOT EXISTS dnc_at             TIMESTAMPTZ;
ALTER TABLE orders_master ADD COLUMN IF NOT EXISTS dnc_note           TEXT;
ALTER TABLE orders_master ADD COLUMN IF NOT EXISTS unreachable_at     TIMESTAMPTZ;
ALTER TABLE orders_master ADD COLUMN IF NOT EXISTS wrong_number_at    TIMESTAMPTZ;
ALTER TABLE orders_master ADD COLUMN IF NOT EXISTS cancel_reason_code TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_callback ON orders_master(callback_at) WHERE callback_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_dnc      ON orders_master(dnc) WHERE dnc = TRUE;
CREATE INDEX IF NOT EXISTS idx_orders_phone    ON orders_master(customer_phone);

-- 3. CALL LOG: every disposition / note, with agent name and timestamp ------
CREATE TABLE IF NOT EXISTS lead_call_log (
  id           BIGSERIAL PRIMARY KEY,
  order_id     UUID NOT NULL REFERENCES orders_master(id),
  agent_id     UUID REFERENCES agents(id),
  agent_name   TEXT NOT NULL,
  disposition  TEXT NOT NULL,
  reason_code  TEXT,
  note         TEXT,
  callback_at  TIMESTAMPTZ,
  meta         JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_log_order       ON lead_call_log(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_call_log_agent_time  ON lead_call_log(agent_name, created_at);
CREATE INDEX IF NOT EXISTS idx_call_log_disp_time   ON lead_call_log(disposition, created_at);

-- 4. PREPAID LINKS + INCENTIVES ---------------------------------------------
CREATE TABLE IF NOT EXISTS prepaid_links (
  id               BIGSERIAL PRIMARY KEY,
  order_id         UUID NOT NULL REFERENCES orders_master(id),
  agent_id         UUID REFERENCES agents(id),
  agent_name       TEXT NOT NULL,
  razorpay_link_id TEXT UNIQUE,
  short_url        TEXT,
  amount           NUMERIC(10,2) NOT NULL,
  status           TEXT NOT NULL DEFAULT 'created',
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at          TIMESTAMPTZ,
  payment_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_prepaid_links_order ON prepaid_links(order_id);

CREATE TABLE IF NOT EXISTS agent_incentives (
  id            BIGSERIAL PRIMARY KEY,
  order_id      UUID NOT NULL UNIQUE REFERENCES orders_master(id),
  link_id       BIGINT REFERENCES prepaid_links(id),
  agent_id      UUID REFERENCES agents(id),
  agent_name    TEXT NOT NULL,
  amount        NUMERIC(10,2) NOT NULL,
  payment_id    TEXT,
  credited_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_incentives_agent_time ON agent_incentives(agent_name, credited_at);

-- 5. QUEUE VIEWS -------------------------------------------------------------
-- CC fresh leads: no duplicates, no repeat customers (those belong to Aman),
-- no do-not-call, and callbacks only once their time has arrived.
-- New columns are appended at the end so CREATE OR REPLACE is allowed.
CREATE OR REPLACE VIEW v_cc_fresh_leads AS
SELECT
  id, shopify_order_id, order_name, customer_name, customer_phone,
  shipping_city, shipping_province, shipping_zip,
  total_price, payment_method, line_items,
  risk_score, risk_flags, address_is_short,
  call_attempts, last_call_at,
  lead_locked_by, lead_locked_at,
  utm_source, utm_campaign,
  created_at,
  EXTRACT(EPOCH FROM (NOW() - created_at))/60 AS age_minutes,
  shipping_address1, shipping_address2,
  callback_at, callback_note
FROM orders_master o
WHERE assigned_to = 'CC'
  AND confirmation_status = 'pending'
  AND order_status = 'new'
  AND is_duplicate = FALSE
  AND is_repeat_customer = FALSE
  AND dnc = FALSE
  AND (callback_at IS NULL OR callback_at <= NOW())
  AND NOT EXISTS (
    SELECT 1 FROM orders_master p
    WHERE p.customer_phone = o.customer_phone
      AND p.id <> o.id
      AND p.created_at < o.created_at
      AND COALESCE(p.order_status, 'new') <> 'cancelled'
  )
ORDER BY (callback_at IS NOT NULL) DESC, created_at ASC;

-- Callbacks that are scheduled for later (not yet in the main queue)
CREATE OR REPLACE VIEW v_cc_scheduled_callbacks AS
SELECT
  id, order_name, customer_name, customer_phone, shipping_city, shipping_zip,
  total_price, call_attempts, callback_at, callback_note
FROM orders_master
WHERE assigned_to = 'CC'
  AND confirmation_status = 'pending'
  AND order_status = 'new'
  AND dnc = FALSE
  AND callback_at IS NOT NULL
  AND callback_at > NOW()
ORDER BY callback_at ASC;

-- CC address-fix queue with the same exclusions as the fresh-leads queue
CREATE OR REPLACE VIEW v_cc_address_fix_queue AS
SELECT q.*
FROM v_address_fix_queue q
JOIN orders_master o ON o.id = q.id
WHERE o.assigned_to = 'CC'
  AND o.is_duplicate = FALSE
  AND o.is_repeat_customer = FALSE
  AND o.dnc = FALSE
  AND o.confirmation_status NOT IN ('wrong_number', 'unreachable', 'cancelled')
  AND NOT EXISTS (
    SELECT 1 FROM orders_master p
    WHERE p.customer_phone = o.customer_phone
      AND p.id <> o.id
      AND p.created_at < o.created_at
      AND COALESCE(p.order_status, 'new') <> 'cancelled'
  );

-- 6. MOVE EXISTING REPEAT ORDERS OUT OF THE CC QUEUE ------------------------
-- Pending CC leads that are repeat orders would otherwise vanish from every queue.
-- Reassign them to InHouse (Aman) and leave an audit trail.
WITH moved AS (
  UPDATE orders_master o SET assigned_to = 'InHouse'
  WHERE o.assigned_to = 'CC'
    AND o.confirmation_status = 'pending'
    AND o.order_status = 'new'
    AND o.is_duplicate = FALSE
    AND (
      o.is_repeat_customer = TRUE
      OR EXISTS (
        SELECT 1 FROM orders_master p
        WHERE p.customer_phone = o.customer_phone
          AND p.id <> o.id
          AND p.created_at < o.created_at
          AND COALESCE(p.order_status, 'new') <> 'cancelled'
      )
    )
  RETURNING o.id
)
INSERT INTO order_status_events (order_id, event_type, old_value, new_value, actor, notes)
SELECT id, 'reassigned', 'CC', 'InHouse', 'migration-001', 'Repeat order moved from call centre to Aman queue'
FROM moved;
