-- ============================================================
-- Jaadu Diet CRM — Views (run after schema.sql)
-- These power the Aman CRM, CC CRM, and Executive dashboards
-- ============================================================

-- 1. AMAN FRESH LEADS (InHouse, new/pending, not locked by others)
CREATE OR REPLACE VIEW v_aman_fresh_leads AS
SELECT
  id, shopify_order_id, order_name, customer_name, customer_phone,
  shipping_address1, shipping_address2,
  shipping_city, shipping_province, shipping_zip,
  total_price, payment_method, line_items,
  risk_score, risk_flags, address_is_short,
  call_attempts, last_call_at,
  lead_locked_by, lead_locked_at,
  utm_source, utm_campaign,
  shopify_created_at, created_at,
  EXTRACT(EPOCH FROM (NOW() - created_at))/60 AS age_minutes
FROM orders_master
WHERE assigned_to = 'InHouse'
  AND confirmation_status = 'pending'
  AND payment_method = 'COD'
  AND COALESCE(order_status, 'new') = 'new'
  AND shipped_at IS NULL
  AND awb_number IS NULL
  AND is_duplicate = FALSE
  AND is_repeat_customer = FALSE
  AND LOWER(customer_name) NOT IN ('test test', 'test', 'test order', 'dummy')
ORDER BY risk_score DESC, created_at ASC;

-- 2. CC FRESH LEADS (Call Center)
CREATE OR REPLACE VIEW v_cc_fresh_leads AS
SELECT
  id, shopify_order_id, order_name, customer_name, customer_phone,
  shipping_address1, shipping_address2,
  shipping_city, shipping_province, shipping_zip,
  total_price, payment_method, line_items,
  risk_score, risk_flags, address_is_short,
  call_attempts, last_call_at,
  lead_locked_by, lead_locked_at,
  utm_source, utm_campaign,
  shopify_created_at, created_at,
  EXTRACT(EPOCH FROM (NOW() - created_at))/60 AS age_minutes,
  callback_at, callback_note
FROM orders_master o
WHERE assigned_to = 'CC'
  AND confirmation_status = 'pending'
  AND payment_method = 'COD'
  AND COALESCE(order_status, 'new') = 'new'
  AND shipped_at IS NULL
  AND awb_number IS NULL
  AND is_duplicate = FALSE
  AND is_repeat_customer = FALSE
  AND dnc = FALSE
  AND LOWER(o.customer_name) NOT IN ('test test', 'test', 'test order', 'dummy')
  AND (callback_at IS NULL OR callback_at <= NOW())
  AND NOT EXISTS (
    SELECT 1 FROM orders_master p
    WHERE p.customer_phone = o.customer_phone
      AND p.id <> o.id
      AND p.created_at < o.created_at
      AND COALESCE(p.order_status, 'new') <> 'cancelled'
  )
ORDER BY (callback_at IS NOT NULL) DESC, created_at ASC;

-- 3. AMAN REPEAT QUEUE
CREATE OR REPLACE VIEW v_aman_repeat_queue AS
SELECT
  id, shopify_order_id, order_name, customer_name, customer_phone,
  shipping_address1, shipping_city, shipping_zip,
  total_price, payment_method,
  is_repeat_customer, repeat_order_number, loyalty_discount_pct,
  call_attempts, last_call_at,
  lead_locked_by, lead_locked_at,
  shopify_created_at, created_at
FROM orders_master
WHERE assigned_to = 'InHouse'
  AND is_repeat_customer = TRUE
  AND confirmation_status = 'pending'
  AND payment_method = 'COD'
  AND COALESCE(order_status, 'new') = 'new'
  AND shipped_at IS NULL
  AND awb_number IS NULL
ORDER BY repeat_order_number DESC, created_at ASC;

-- 4. AMAN NDR RECOVERY
CREATE OR REPLACE VIEW v_aman_ndr_recovery AS
SELECT
  id, shopify_order_id, order_name, customer_name, customer_phone,
  shipping_address1, shipping_city, shipping_zip,
  total_price, awb_number, courier_name,
  ndr_status, ndr_count, ndr_last_reason, ndr_last_at,
  lead_locked_by, lead_locked_at,
  created_at, shipped_at
FROM orders_master
WHERE ndr_status IS NOT NULL
  AND ndr_status NOT IN ('resolved', 'rto_initiated')
  AND order_status = 'shipped'
ORDER BY ndr_count DESC, ndr_last_at ASC;

-- 5. ADDRESS FIX QUEUE
CREATE OR REPLACE VIEW v_address_fix_queue AS
SELECT
  id, shopify_order_id, order_name, customer_name, customer_phone,
  shipping_address1, shipping_address2, shipping_city,
  shipping_province, shipping_zip,
  address_is_short, address_fixed, address_locked,
  total_price, payment_method,
  lead_locked_by, lead_locked_at,
  created_at
FROM orders_master
WHERE address_is_short = TRUE
  AND address_fixed = FALSE
  AND address_locked = FALSE
  AND order_status NOT IN ('cancelled', 'delivered', 'rto')
ORDER BY created_at ASC;

-- 6. DUPLICATE REVIEW
CREATE OR REPLACE VIEW v_duplicate_review AS
SELECT
  id, shopify_order_id, order_name, customer_name, customer_phone,
  total_price, payment_method, line_items,
  is_duplicate, duplicate_of_order,
  order_status, confirmation_status,
  created_at
FROM orders_master
WHERE is_duplicate = TRUE
  AND order_status NOT IN ('cancelled')
ORDER BY created_at DESC;

-- 7. KPI RIBBON (summary stats for dashboard header)
CREATE OR REPLACE VIEW v_kpi_ribbon AS
SELECT
  COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE) AS today_orders,
  COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE AND confirmation_status = 'confirmed') AS today_confirmed,
  COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE AND confirmation_status = 'cancelled') AS today_cancelled,
  COUNT(*) FILTER (WHERE confirmation_status = 'pending' AND order_status = 'new') AS pending_total,
  COUNT(*) FILTER (WHERE confirmation_status = 'pending' AND assigned_to = 'InHouse') AS pending_inhouse,
  COUNT(*) FILTER (WHERE confirmation_status = 'pending' AND assigned_to = 'CC') AS pending_cc,
  COUNT(*) FILTER (WHERE ndr_status IS NOT NULL AND ndr_status NOT IN ('resolved', 'rto_initiated')) AS active_ndr,
  COUNT(*) FILTER (WHERE address_is_short = TRUE AND address_fixed = FALSE) AS pending_address_fix,
  COUNT(*) FILTER (WHERE is_duplicate = TRUE AND order_status NOT IN ('cancelled')) AS pending_duplicates,
  ROUND(
    COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE AND confirmation_status = 'confirmed')::NUMERIC /
    NULLIF(COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE), 0) * 100, 1
  ) AS today_confirm_rate,
  SUM(total_price) FILTER (WHERE DATE(created_at) = CURRENT_DATE AND confirmation_status = 'confirmed') AS today_confirmed_value,
  COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE AND converted_to_prepaid = TRUE) AS today_prepaid_conversions
FROM orders_master;

-- 8. DAILY ORDER SUMMARY
CREATE OR REPLACE VIEW v_daily_order_summary AS
SELECT
  DATE(created_at) AS order_date,
  COUNT(*) AS total_orders,
  COUNT(*) FILTER (WHERE confirmation_status = 'confirmed') AS confirmed,
  COUNT(*) FILTER (WHERE confirmation_status = 'cancelled') AS cancelled,
  COUNT(*) FILTER (WHERE confirmation_status = 'pending') AS pending,
  COUNT(*) FILTER (WHERE payment_method = 'COD') AS cod_orders,
  COUNT(*) FILTER (WHERE payment_method = 'PREPAID' OR converted_to_prepaid = TRUE) AS prepaid_orders,
  SUM(total_price) AS total_value,
  SUM(total_price) FILTER (WHERE confirmation_status = 'confirmed') AS confirmed_value,
  ROUND(
    COUNT(*) FILTER (WHERE confirmation_status = 'confirmed')::NUMERIC /
    NULLIF(COUNT(*), 0) * 100, 1
  ) AS confirm_rate
FROM orders_master
GROUP BY DATE(created_at)
ORDER BY order_date DESC
LIMIT 30;

-- 9. HOURLY CALLING TRACKER
CREATE OR REPLACE VIEW v_hourly_calling_tracker AS
SELECT
  DATE(confirmed_at) AS call_date,
  EXTRACT(HOUR FROM confirmed_at) AS call_hour,
  assigned_to,
  assigned_agent,
  COUNT(*) AS calls_made,
  COUNT(*) FILTER (WHERE confirmation_status = 'confirmed') AS confirmed,
  COUNT(*) FILTER (WHERE confirmation_status = 'cancelled') AS cancelled,
  ROUND(AVG(EXTRACT(EPOCH FROM (confirmed_at - created_at))/60)::NUMERIC, 1) AS avg_speed_to_call_min
FROM orders_master
WHERE confirmed_at IS NOT NULL
  AND DATE(confirmed_at) >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY DATE(confirmed_at), EXTRACT(HOUR FROM confirmed_at), assigned_to, assigned_agent
ORDER BY call_date DESC, call_hour DESC;

-- 10. CHANNEL ATTRIBUTION
CREATE OR REPLACE VIEW v_channel_attribution AS
SELECT
  COALESCE(utm_source, 'direct') AS source,
  COALESCE(utm_medium, 'none') AS medium,
  COALESCE(utm_campaign, 'none') AS campaign,
  COUNT(*) AS total_orders,
  COUNT(*) FILTER (WHERE confirmation_status = 'confirmed') AS confirmed,
  SUM(total_price) AS total_value,
  ROUND(
    COUNT(*) FILTER (WHERE confirmation_status = 'confirmed')::NUMERIC /
    NULLIF(COUNT(*), 0) * 100, 1
  ) AS confirm_rate
FROM orders_master
WHERE DATE(created_at) >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY utm_source, utm_medium, utm_campaign
ORDER BY total_orders DESC;

-- 11. SPEED TO CALL MATRIX
CREATE OR REPLACE VIEW v_speed_to_call_matrix AS
SELECT
  assigned_to,
  CASE
    WHEN EXTRACT(EPOCH FROM (confirmed_at - created_at))/60 <= 5 THEN '0-5 min'
    WHEN EXTRACT(EPOCH FROM (confirmed_at - created_at))/60 <= 15 THEN '5-15 min'
    WHEN EXTRACT(EPOCH FROM (confirmed_at - created_at))/60 <= 30 THEN '15-30 min'
    WHEN EXTRACT(EPOCH FROM (confirmed_at - created_at))/60 <= 60 THEN '30-60 min'
    ELSE '60+ min'
  END AS speed_bucket,
  COUNT(*) AS call_count,
  COUNT(*) FILTER (WHERE confirmation_status = 'confirmed') AS confirmed,
  ROUND(
    COUNT(*) FILTER (WHERE confirmation_status = 'confirmed')::NUMERIC /
    NULLIF(COUNT(*), 0) * 100, 1
  ) AS confirm_rate
FROM orders_master
WHERE confirmed_at IS NOT NULL
  AND DATE(created_at) >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY assigned_to, speed_bucket
ORDER BY assigned_to, speed_bucket;

-- 12. SHEET EXPORT PENDING
CREATE OR REPLACE VIEW v_sheet_export_pending AS
SELECT
  id, shopify_order_id, order_name, customer_name, customer_phone,
  shipping_address1, shipping_address2, shipping_city, shipping_province, shipping_zip,
  total_price, payment_method, confirmation_status, order_status,
  assigned_to, assigned_agent,
  awb_number, courier_name,
  created_at, confirmed_at, shipped_at
FROM orders_master
WHERE synced_to_sheet = FALSE
  AND confirmation_status IN ('confirmed', 'cancelled')
ORDER BY created_at ASC;

-- 13. NDR / RTO TRACKING
CREATE OR REPLACE VIEW v_ndr_rto_tracking AS
SELECT
  id, shopify_order_id, order_name, customer_name, customer_phone,
  shipping_city, shipping_zip,
  awb_number, courier_name,
  ndr_status, ndr_count, ndr_last_reason, ndr_last_at,
  rto_status, rto_initiated_at, rto_delivered_at,
  rto_qc_status, rto_qc_notes,
  total_price, payment_method,
  shipped_at, created_at
FROM orders_master
WHERE ndr_status IS NOT NULL OR rto_status IS NOT NULL
ORDER BY COALESCE(ndr_last_at, rto_initiated_at) DESC;

-- 14. LOGISTICS SUMMARY
CREATE OR REPLACE VIEW v_logistics_summary AS
SELECT
  courier_name,
  COUNT(*) AS total_shipped,
  COUNT(*) FILTER (WHERE order_status = 'delivered') AS delivered,
  COUNT(*) FILTER (WHERE order_status = 'shipped' AND ndr_status IS NULL) AS in_transit,
  COUNT(*) FILTER (WHERE ndr_status IS NOT NULL AND rto_status IS NULL) AS ndr_active,
  COUNT(*) FILTER (WHERE rto_status IS NOT NULL) AS rto,
  ROUND(
    COUNT(*) FILTER (WHERE rto_status IS NOT NULL)::NUMERIC /
    NULLIF(COUNT(*), 0) * 100, 1
  ) AS rto_rate,
  ROUND(AVG(
    CASE WHEN delivered_at IS NOT NULL
    THEN EXTRACT(EPOCH FROM (delivered_at - shipped_at))/86400 END
  )::NUMERIC, 1) AS avg_delivery_days
FROM orders_master
WHERE awb_number IS NOT NULL
GROUP BY courier_name
ORDER BY total_shipped DESC;

-- 15. LOGISTICS STUCK IN TRANSIT (>7 days no update)
CREATE OR REPLACE VIEW v_logistics_stuck_transit AS
SELECT
  id, shopify_order_id, order_name, customer_name, customer_phone,
  awb_number, courier_name,
  shipped_at,
  EXTRACT(DAY FROM (NOW() - shipped_at)) AS days_in_transit,
  order_status, ndr_status
FROM orders_master
WHERE order_status = 'shipped'
  AND shipped_at < NOW() - INTERVAL '7 days'
  AND ndr_status IS NULL
  AND delivered_at IS NULL
ORDER BY shipped_at ASC;

-- 16. REFUND DESK
CREATE OR REPLACE VIEW v_refund_desk AS
SELECT
  r.id, r.order_id, r.refund_amount, r.refund_reason, r.refund_method,
  r.bank_details, r.status, r.requested_by, r.approved_by,
  r.processed_at, r.utr_number, r.notes,
  r.created_at,
  o.shopify_order_id, o.order_name, o.customer_name, o.customer_phone,
  o.total_price, o.payment_method
FROM manual_refunds_queue r
JOIN orders_master o ON r.order_id = o.id
ORDER BY
  CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
  r.created_at ASC;

-- 17. INVENTORY DASHBOARD
CREATE OR REPLACE VIEW v_inventory_dashboard AS
SELECT
  im.sku, im.product_name, im.category, im.unit,
  im.current_stock, im.reserved_stock,
  im.current_stock - im.reserved_stock AS available_stock,
  im.reorder_level,
  CASE WHEN (im.current_stock - im.reserved_stock) <= im.reorder_level THEN TRUE ELSE FALSE END AS needs_reorder,
  im.updated_at,
  COALESCE(inw.last_inward, im.updated_at) AS last_inward,
  COALESCE(outw.last_outward, im.updated_at) AS last_outward
FROM inventory_master im
LEFT JOIN (
  SELECT sku, MAX(created_at) AS last_inward FROM stock_inward_logs GROUP BY sku
) inw ON im.sku = inw.sku
LEFT JOIN (
  SELECT sku, MAX(created_at) AS last_outward FROM stock_outward_logs GROUP BY sku
) outw ON im.sku = outw.sku
ORDER BY needs_reorder DESC, im.sku;

-- 18. COD REMITTANCE SUMMARY
CREATE OR REPLACE VIEW v_cod_remittance_summary AS
SELECT
  courier_name,
  COUNT(*) AS total_remittances,
  SUM(expected_amount) AS total_expected,
  SUM(received_amount) AS total_received,
  SUM(discrepancy) AS total_discrepancy,
  COUNT(*) FILTER (WHERE status = 'discrepancy') AS unresolved_discrepancies,
  SUM(order_count) AS total_orders_remitted
FROM cod_remittances_ledger
GROUP BY courier_name
ORDER BY total_expected DESC;

-- 19. WEIGHT DISPUTES
CREATE OR REPLACE VIEW v_weight_disputes AS
SELECT
  w.id, w.order_id, w.awb_number, w.courier_name,
  w.weight_charged_gm, w.weight_actual_gm, w.weight_diff_gm,
  w.excess_charge, w.dispute_status, w.resolution_notes,
  w.created_at, w.resolved_at,
  o.order_name, o.customer_name
FROM weight_disputes_ledger w
JOIN orders_master o ON w.order_id = o.id
ORDER BY
  CASE w.dispute_status WHEN 'open' THEN 0 WHEN 'escalated' THEN 1 ELSE 2 END,
  w.created_at DESC;

-- 20. RTO DETAILED LIFECYCLE
CREATE OR REPLACE VIEW v_rto_detailed_lifecycle AS
SELECT
  id, shopify_order_id, order_name, customer_name, customer_phone,
  awb_number, courier_name,
  rto_status,
  rto_initiated_at,
  rto_delivered_at,
  rto_qc_status,
  rto_qc_notes,
  EXTRACT(DAY FROM (COALESCE(rto_delivered_at, NOW()) - rto_initiated_at)) AS rto_transit_days,
  total_price, payment_method
FROM orders_master
WHERE rto_status IS NOT NULL
ORDER BY rto_initiated_at DESC;

-- 21. PACKAGING SHRINKAGE MONTHLY
CREATE OR REPLACE VIEW v_packaging_shrinkage_monthly AS
SELECT
  DATE_TRUNC('month', shift_date) AS month,
  scrap_type,
  SUM(quantity) AS total_scrapped,
  COUNT(DISTINCT shift_date) AS days_with_scrap,
  ROUND(SUM(quantity)::NUMERIC / NULLIF(COUNT(DISTINCT shift_date), 0), 1) AS avg_per_day
FROM packaging_scrap_logs
GROUP BY DATE_TRUNC('month', shift_date), scrap_type
ORDER BY month DESC, total_scrapped DESC;

-- 22. AD EXCLUSION PINCODES
CREATE OR REPLACE VIEW v_ad_exclusion_pincodes AS
SELECT
  shipping_zip AS pincode,
  COUNT(*) AS total_shipped,
  COUNT(*) FILTER (WHERE rto_status IS NOT NULL) AS total_rto,
  ROUND(
    COUNT(*) FILTER (WHERE rto_status IS NOT NULL)::NUMERIC /
    NULLIF(COUNT(*), 0) * 100, 2
  ) AS rto_rate
FROM orders_master
WHERE shipping_zip IS NOT NULL
  AND order_status IN ('shipped', 'delivered', 'rto')
GROUP BY shipping_zip
HAVING COUNT(*) >= 10
  AND (COUNT(*) FILTER (WHERE rto_status IS NOT NULL)::NUMERIC / NULLIF(COUNT(*), 0) * 100) >= 30
ORDER BY rto_rate DESC;

-- 23. WA / IVR RIBBON (from sheet sync)
CREATE OR REPLACE VIEW v_wa_ribbon AS
SELECT
  COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE) AS today_wa_responses,
  COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE AND confirmation_status = 'confirmed') AS wa_confirmed_today,
  COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE AND confirmation_status = 'cancelled') AS wa_cancelled_today
FROM orders_master
WHERE confirmation_status != 'pending';

-- 24. IVR RIBBON
CREATE OR REPLACE VIEW v_ivr_ribbon AS
SELECT
  COUNT(*) FILTER (WHERE DATE(last_call_at) = CURRENT_DATE) AS today_ivr_calls,
  COUNT(*) FILTER (WHERE DATE(last_call_at) = CURRENT_DATE AND call_attempts > 0) AS ivr_attempted_today
FROM orders_master
WHERE last_call_at IS NOT NULL;
