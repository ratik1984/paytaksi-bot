-- Patch: add cancellation fields for rides (safe / additive)
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;

-- Optional helpful index for admin/queries
CREATE INDEX IF NOT EXISTS rides_cancelled_at_idx ON rides(cancelled_at);
