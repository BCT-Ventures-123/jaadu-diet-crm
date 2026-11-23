-- Marks when a lead was sent back to calling, so the 7-day "unreachable" clock restarts from that moment.
ALTER TABLE orders_master ADD COLUMN IF NOT EXISTS requeued_at TIMESTAMPTZ;
