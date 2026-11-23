-- ============================================================
-- Jaadu Diet CRM — PostgreSQL Schema
-- Run once on Railway Postgres to create all tables & functions
-- ============================================================

-- EXTENSION
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. ORDERS MASTER
-- ============================================================
CREATE TABLE IF NOT EXISTS orders_master (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shopify_order_id      BIGINT UNIQUE NOT NULL,
  shopify_order_number  TEXT,
  order_name            TEXT,

  -- Customer
  customer_name         TEXT,
  customer_email        TEXT,
  customer_phone        TEXT NOT NULL,
  customer_phone_alt    TEXT,

  -- Address
  shipping_address1     TEXT,
  shipping_address2     TEXT,
  shipping_city         TEXT,
  shipping_province     TEXT,
  shipping_zip          TEXT,
  shipping_country      TEXT DEFAULT 'IN',
  address_is_short      BOOLEAN DEFAULT FALSE,
  address_fixed         BOOLEAN DEFAULT FALSE,
  address_locked        BOOLEAN DEFAULT FALSE,

  -- Product & Pricing
  line_items            JSONB DEFAULT '[]',
  subtotal              NUMERIC(10,2) DEFAULT 0,
  cod_surcharge         NUMERIC(10,2) DEFAULT 0,
  total_price           NUMERIC(10,2) DEFAULT 0,
  prepaid_amount        NUMERIC(10,2) DEFAULT 0,
  payment_method        TEXT DEFAULT 'COD',  -- COD / PREPAID
  converted_to_prepaid  BOOLEAN DEFAULT FALSE,
  razorpay_payment_id   TEXT,
  payu_txn_id           TEXT,

  -- Routing & Assignment
  route_percent         INTEGER,
  assigned_to           TEXT DEFAULT 'unassigned', -- InHouse / CC / unassigned
  assigned_agent        TEXT,
  lead_locked_by        TEXT,
  lead_locked_at        TIMESTAMPTZ,

  -- Risk
  risk_score            INTEGER DEFAULT 0,
  risk_flags            JSONB DEFAULT '[]',
  is_blacklisted        BOOLEAN DEFAULT FALSE,
  is_duplicate          BOOLEAN DEFAULT FALSE,
  duplicate_of_order    BIGINT,

  -- Status & Lifecycle
  order_status          TEXT DEFAULT 'new',
  confirmation_status   TEXT DEFAULT 'pending',
  call_attempts         INTEGER DEFAULT 0,
  last_call_at          TIMESTAMPTZ,
  confirmed_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  cancellation_reason   TEXT,

  -- Shipping
  awb_number            TEXT,
  courier_name          TEXT,
  shiprocket_order_id   TEXT,
  nimbus_order_id       TEXT,
  shipped_at            TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  dispatch_batch_date   DATE,
  dispatch_batch_slot   TEXT, -- same_day / next_day

  -- NDR & RTO
  ndr_status            TEXT,
  ndr_count             INTEGER DEFAULT 0,
  ndr_last_reason       TEXT,
  ndr_last_at           TIMESTAMPTZ,
  rto_status            TEXT,
  rto_initiated_at      TIMESTAMPTZ,
  rto_delivered_at      TIMESTAMPTZ,
  rto_qc_status         TEXT,
  rto_qc_notes          TEXT,

  -- COD Remittance
  cod_remitted          BOOLEAN DEFAULT FALSE,
  cod_remittance_amount NUMERIC(10,2),
  cod_remittance_date   DATE,
  cod_remittance_utr    TEXT,

  -- Weight Dispute
  weight_dispute        BOOLEAN DEFAULT FALSE,
  weight_billed_gm      INTEGER,
  weight_actual_gm      INTEGER,
  weight_dispute_status TEXT,

  -- Replenishment
  is_repeat_customer    BOOLEAN DEFAULT FALSE,
  repeat_order_number   INTEGER DEFAULT 1,
  replenish_eligible    BOOLEAN DEFAULT FALSE,
  replenish_due_date    DATE,
  loyalty_discount_pct  NUMERIC(4,2) DEFAULT 0,

  -- Sheet Sync
  synced_to_sheet       BOOLEAN DEFAULT FALSE,
  synced_at             TIMESTAMPTZ,

  -- Channel Attribution
  utm_source            TEXT,
  utm_medium            TEXT,
  utm_campaign          TEXT,
  landing_page          TEXT,
  referring_site        TEXT,

  -- Timestamps
  shopify_created_at    TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_orders_status ON orders_master(order_status);
CREATE INDEX idx_orders_confirmation ON orders_master(confirmation_status);
CREATE INDEX idx_orders_assigned ON orders_master(assigned_to);
CREATE INDEX idx_orders_phone ON orders_master(customer_phone);
CREATE INDEX idx_orders_created ON orders_master(created_at);
CREATE INDEX idx_orders_dispatch ON orders_master(dispatch_batch_date);
CREATE INDEX idx_orders_awb ON orders_master(awb_number);

-- ============================================================
-- 2. ORDER STATUS EVENTS (audit trail)
-- ============================================================
CREATE TABLE IF NOT EXISTS order_status_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID REFERENCES orders_master(id),
  event_type      TEXT NOT NULL,
  old_value       TEXT,
  new_value       TEXT,
  actor           TEXT,
  notes           TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_order ON order_status_events(order_id);
CREATE INDEX idx_events_type ON order_status_events(event_type);

-- ============================================================
-- 3. RISK BLACKLISTS
-- ============================================================
CREATE TABLE IF NOT EXISTS risk_pincodes_blacklist (
  pincode     TEXT PRIMARY KEY,
  reason      TEXT,
  added_by    TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS risk_customers_blacklist (
  phone       TEXT PRIMARY KEY,
  reason      TEXT,
  added_by    TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 4. MANUAL REFUNDS QUEUE
-- ============================================================
CREATE TABLE IF NOT EXISTS manual_refunds_queue (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID REFERENCES orders_master(id),
  refund_amount   NUMERIC(10,2) NOT NULL,
  refund_reason   TEXT,
  refund_method   TEXT, -- bank_transfer / razorpay / payu
  bank_details    JSONB,
  status          TEXT DEFAULT 'pending', -- pending / approved / processed / rejected
  requested_by    TEXT,
  approved_by     TEXT,
  processed_at    TIMESTAMPTZ,
  utr_number      TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 5. INVENTORY MASTER (WMS)
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory_master (
  sku             TEXT PRIMARY KEY,
  product_name    TEXT NOT NULL,
  category        TEXT, -- FG / RAW / PKG
  unit            TEXT DEFAULT 'pcs',
  current_stock   INTEGER DEFAULT 0,
  reserved_stock  INTEGER DEFAULT 0,
  reorder_level   INTEGER DEFAULT 0,
  bom_components  JSONB DEFAULT '[]',
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_inward_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sku             TEXT REFERENCES inventory_master(sku),
  quantity        INTEGER NOT NULL,
  batch_number    TEXT,
  supplier        TEXT,
  inward_type     TEXT DEFAULT 'purchase', -- purchase / rto_restock / production
  notes           TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_outward_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sku             TEXT REFERENCES inventory_master(sku),
  quantity        INTEGER NOT NULL,
  order_id        UUID REFERENCES orders_master(id),
  outward_type    TEXT DEFAULT 'dispatch', -- dispatch / damage / sample
  awb_number      TEXT,
  notes           TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 6. RTO INVENTORY RECONCILIATION
-- ============================================================
CREATE TABLE IF NOT EXISTS rto_inventory_reconciliation (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID REFERENCES orders_master(id),
  awb_number      TEXT,
  received_at     TIMESTAMPTZ,
  qc_status       TEXT, -- pass / damaged / lost
  qc_notes        TEXT,
  restocked       BOOLEAN DEFAULT FALSE,
  restocked_skus  JSONB DEFAULT '[]',
  inspected_by    TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 7. 3PL MANIFEST HANDOVERS
-- ============================================================
CREATE TABLE IF NOT EXISTS three_pl_manifest_handovers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  manifest_id     TEXT UNIQUE,
  courier_name    TEXT NOT NULL,
  handover_date   DATE NOT NULL,
  order_count     INTEGER DEFAULT 0,
  total_weight_gm INTEGER DEFAULT 0,
  awb_list        JSONB DEFAULT '[]',
  status          TEXT DEFAULT 'created', -- created / handed_over / acknowledged
  pickup_scheduled_at TIMESTAMPTZ,
  picked_up_at    TIMESTAMPTZ,
  notes           TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 8. PACKAGING SCRAP LOGS
-- ============================================================
CREATE TABLE IF NOT EXISTS packaging_scrap_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sku             TEXT,
  scrap_type      TEXT, -- box_damaged / label_wasted / tape_excess / insert_damaged
  quantity        INTEGER DEFAULT 1,
  reason          TEXT,
  shift_date      DATE DEFAULT CURRENT_DATE,
  logged_by       TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 9. WEIGHT DISPUTES LEDGER
-- ============================================================
CREATE TABLE IF NOT EXISTS weight_disputes_ledger (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID REFERENCES orders_master(id),
  awb_number      TEXT,
  courier_name    TEXT,
  weight_charged_gm INTEGER,
  weight_actual_gm  INTEGER,
  weight_diff_gm    INTEGER,
  excess_charge     NUMERIC(10,2),
  dispute_status    TEXT DEFAULT 'open', -- open / escalated / resolved_favour / resolved_against
  resolution_notes  TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ
);

-- ============================================================
-- 10. COD REMITTANCES LEDGER
-- ============================================================
CREATE TABLE IF NOT EXISTS cod_remittances_ledger (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  courier_name    TEXT NOT NULL,
  remittance_date DATE NOT NULL,
  utr_number      TEXT,
  expected_amount NUMERIC(10,2),
  received_amount NUMERIC(10,2),
  discrepancy     NUMERIC(10,2) DEFAULT 0,
  order_count     INTEGER DEFAULT 0,
  awb_list        JSONB DEFAULT '[]',
  status          TEXT DEFAULT 'pending', -- pending / received / discrepancy / resolved
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 11. GOOGLE SHEET SYNC TRACKER (for WhatsApp/IVR confirmations)
-- ============================================================
CREATE TABLE IF NOT EXISTS sheet_sync_tracker (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sheet_id        TEXT NOT NULL,
  tab_name        TEXT NOT NULL,
  last_synced_row INTEGER DEFAULT 1,
  last_synced_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 12. AD EXCLUSION PINCODES
-- ============================================================
CREATE TABLE IF NOT EXISTS ad_exclusion_pincodes (
  pincode         TEXT PRIMARY KEY,
  total_shipped   INTEGER DEFAULT 0,
  total_rto       INTEGER DEFAULT 0,
  rto_rate        NUMERIC(5,2) DEFAULT 0,
  excluded_since  TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- FUNCTIONS (RPC equivalents)
-- ============================================================

-- Log status change
CREATE OR REPLACE FUNCTION log_status_change(
  p_order_id UUID,
  p_event_type TEXT,
  p_old_value TEXT,
  p_new_value TEXT,
  p_actor TEXT DEFAULT 'system',
  p_notes TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'
) RETURNS UUID AS $$
DECLARE
  v_event_id UUID;
BEGIN
  INSERT INTO order_status_events (order_id, event_type, old_value, new_value, actor, notes, metadata)
  VALUES (p_order_id, p_event_type, p_old_value, p_new_value, p_actor, p_notes, p_metadata)
  RETURNING id INTO v_event_id;

  UPDATE orders_master SET updated_at = NOW() WHERE id = p_order_id;
  RETURN v_event_id;
END;
$$ LANGUAGE plpgsql;

-- Check duplicate order (same phone within 48h, same product set)
CREATE OR REPLACE FUNCTION check_duplicate_order(
  p_phone TEXT,
  p_line_items JSONB,
  p_hours INTEGER DEFAULT 48
) RETURNS TABLE(is_duplicate BOOLEAN, duplicate_order_id BIGINT) AS $$
BEGIN
  RETURN QUERY
  SELECT
    TRUE,
    om.shopify_order_id
  FROM orders_master om
  WHERE om.customer_phone = p_phone
    AND om.created_at > NOW() - (p_hours || ' hours')::INTERVAL
    AND om.order_status NOT IN ('cancelled', 'returned')
    AND om.line_items::TEXT = p_line_items::TEXT
  ORDER BY om.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::BIGINT;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Evaluate risk score
CREATE OR REPLACE FUNCTION evaluate_risk(
  p_phone TEXT,
  p_pincode TEXT,
  p_address TEXT,
  p_total NUMERIC
) RETURNS TABLE(score INTEGER, flags JSONB) AS $$
DECLARE
  v_score INTEGER := 0;
  v_flags JSONB := '[]'::JSONB;
  v_phone_blacklisted BOOLEAN;
  v_pincode_blacklisted BOOLEAN;
  v_address_short BOOLEAN;
  v_prev_rto_count INTEGER;
BEGIN
  -- Check phone blacklist
  SELECT EXISTS(SELECT 1 FROM risk_customers_blacklist WHERE phone = p_phone) INTO v_phone_blacklisted;
  IF v_phone_blacklisted THEN
    v_score := v_score + 50;
    v_flags := v_flags || '["phone_blacklisted"]'::JSONB;
  END IF;

  -- Check pincode blacklist
  SELECT EXISTS(SELECT 1 FROM risk_pincodes_blacklist WHERE pincode = p_pincode) INTO v_pincode_blacklisted;
  IF v_pincode_blacklisted THEN
    v_score := v_score + 30;
    v_flags := v_flags || '["pincode_blacklisted"]'::JSONB;
  END IF;

  -- Short address: <25 chars OR <4 words OR missing premise tokens
  v_address_short := (
    LENGTH(COALESCE(p_address, '')) < 25
    OR array_length(string_to_array(COALESCE(p_address, ''), ' '), 1) < 4
  );
  IF v_address_short THEN
    v_score := v_score + 15;
    v_flags := v_flags || '["short_address"]'::JSONB;
  END IF;

  -- Previous RTO history for this phone
  SELECT COUNT(*) INTO v_prev_rto_count
  FROM orders_master
  WHERE customer_phone = p_phone AND rto_status IS NOT NULL;
  IF v_prev_rto_count >= 2 THEN
    v_score := v_score + 25;
    v_flags := v_flags || '["repeat_rto"]'::JSONB;
  END IF;

  -- High value COD
  IF p_total > 2000 THEN
    v_score := v_score + 10;
    v_flags := v_flags || '["high_value_cod"]'::JSONB;
  END IF;

  RETURN QUERY SELECT v_score, v_flags;
END;
$$ LANGUAGE plpgsql;

-- Acquire lead lock
CREATE OR REPLACE FUNCTION acquire_lead_lock(
  p_order_id UUID,
  p_agent TEXT,
  p_lock_minutes INTEGER DEFAULT 15
) RETURNS BOOLEAN AS $$
DECLARE
  v_locked BOOLEAN;
BEGIN
  UPDATE orders_master
  SET lead_locked_by = p_agent,
      lead_locked_at = NOW()
  WHERE id = p_order_id
    AND (lead_locked_by IS NULL OR lead_locked_at < NOW() - (p_lock_minutes || ' minutes')::INTERVAL)
  RETURNING TRUE INTO v_locked;

  RETURN COALESCE(v_locked, FALSE);
END;
$$ LANGUAGE plpgsql;

-- Release lead lock
CREATE OR REPLACE FUNCTION release_lead_lock(
  p_order_id UUID,
  p_agent TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE orders_master
  SET lead_locked_by = NULL,
      lead_locked_at = NULL
  WHERE id = p_order_id
    AND lead_locked_by = p_agent;
END;
$$ LANGUAGE plpgsql;

-- Promote to repeat queue
CREATE OR REPLACE FUNCTION maybe_promote_to_repeat_queue(
  p_phone TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE orders_master
  SET is_repeat_customer = TRUE,
      repeat_order_number = sub.rn
  FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) AS rn
    FROM orders_master
    WHERE customer_phone = p_phone
      AND order_status NOT IN ('cancelled')
  ) sub
  WHERE orders_master.id = sub.id AND sub.rn > 1;
END;
$$ LANGUAGE plpgsql;

-- Restock from RTO QC pass
CREATE OR REPLACE FUNCTION restock_rto_qc_pass(
  p_order_id UUID,
  p_inspector TEXT
) RETURNS VOID AS $$
DECLARE
  v_item JSONB;
  v_sku TEXT;
BEGIN
  FOR v_item IN SELECT jsonb_array_elements(line_items) FROM orders_master WHERE id = p_order_id
  LOOP
    v_sku := v_item->>'sku';
    IF v_sku IS NOT NULL THEN
      UPDATE inventory_master
      SET current_stock = current_stock + COALESCE((v_item->>'quantity')::INTEGER, 1),
          updated_at = NOW()
      WHERE sku = v_sku;

      INSERT INTO stock_inward_logs (sku, quantity, inward_type, notes, created_by)
      VALUES (v_sku, COALESCE((v_item->>'quantity')::INTEGER, 1), 'rto_restock', 'RTO QC Pass restock for order ' || p_order_id, p_inspector);
    END IF;
  END LOOP;

  INSERT INTO rto_inventory_reconciliation (order_id, qc_status, restocked, inspected_by, received_at)
  VALUES (p_order_id, 'pass', TRUE, p_inspector, NOW());

  UPDATE orders_master SET rto_qc_status = 'pass', updated_at = NOW() WHERE id = p_order_id;
END;
$$ LANGUAGE plpgsql;

-- Get excluded pincodes (RTO rate >= 30% with >= 10 shipped)
CREATE OR REPLACE FUNCTION get_excluded_pincodes()
RETURNS TABLE(pincode TEXT, total_shipped INTEGER, total_rto INTEGER, rto_rate NUMERIC) AS $$
BEGIN
  RETURN QUERY
  SELECT
    om.shipping_zip,
    COUNT(*)::INTEGER AS total_shipped,
    COUNT(*) FILTER (WHERE om.rto_status IS NOT NULL)::INTEGER AS total_rto,
    ROUND(COUNT(*) FILTER (WHERE om.rto_status IS NOT NULL)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 2) AS rto_rate
  FROM orders_master om
  WHERE om.shipping_zip IS NOT NULL
    AND om.order_status IN ('shipped', 'delivered', 'rto')
  GROUP BY om.shipping_zip
  HAVING COUNT(*) >= 10
    AND (COUNT(*) FILTER (WHERE om.rto_status IS NOT NULL)::NUMERIC / NULLIF(COUNT(*), 0) * 100) >= 30
  ORDER BY rto_rate DESC;
END;
$$ LANGUAGE plpgsql;

-- Auto-update updated_at on orders_master
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orders_updated
  BEFORE UPDATE ON orders_master
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

-- Seed default inventory items
INSERT INTO inventory_master (sku, product_name, category, unit, current_stock, reorder_level, bom_components)
VALUES
  ('FG_250G', 'Arjuna Tea 250g Pack', 'FG', 'pcs', 0, 100, '[]'),
  ('MONO_250G', 'Mono Carton 250g', 'PKG', 'pcs', 0, 200, '[]'),
  ('BOX_P1', 'Shipping Box P1 (1-pack)', 'PKG', 'pcs', 0, 200, '[]'),
  ('BOX_P2', 'Shipping Box P2 (2-pack)', 'PKG', 'pcs', 0, 100, '[]'),
  ('BOX_P3', 'Shipping Box P3 (3-pack)', 'PKG', 'pcs', 0, 50, '[]'),
  ('TAPE', 'Packing Tape Roll', 'PKG', 'rolls', 0, 20, '[]'),
  ('BUBBLE', 'Bubble Wrap Sheet', 'PKG', 'sheets', 0, 100, '[]'),
  ('INSERT', 'Product Insert Card', 'PKG', 'pcs', 0, 500, '[]')
ON CONFLICT (sku) DO NOTHING;
