ALTER TABLE orders_master ADD COLUMN IF NOT EXISTS shopify_prepaid_sync TEXT;
ALTER TABLE orders_master ADD COLUMN IF NOT EXISTS shopify_prepaid_sync_detail TEXT;
ALTER TABLE orders_master ADD COLUMN IF NOT EXISTS shopify_prepaid_synced_at TIMESTAMPTZ;
