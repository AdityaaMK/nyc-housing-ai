-- Apply to the existing housing database after approval. No records are imported or deleted.
BEGIN;
ALTER TABLE public.tour_schedules ADD COLUMN IF NOT EXISTS proposed_datetime TEXT;

-- The app uses its PostgreSQL backend connection. Anonymous Data API access is not needed.
ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tour_schedules ENABLE ROW LEVEL SECURITY;
COMMIT;
