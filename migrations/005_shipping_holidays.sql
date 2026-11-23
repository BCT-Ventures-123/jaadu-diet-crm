-- Days the warehouse does not ship (bank holidays), added by the admin. Sundays are handled in code.
-- Additive only: a new table, no existing table or column is touched.
CREATE TABLE IF NOT EXISTS shipping_holidays (
  holiday_date DATE PRIMARY KEY,
  note         TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
