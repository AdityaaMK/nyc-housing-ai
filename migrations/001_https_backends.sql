-- Additive HTTPS API, version 1. Requires the existing scoring schema.
-- Apply with scripts/migrate-https.js in one transaction after a verified backup.
-- No listing/tour data, table grants, or RLS policies are changed.
CREATE OR REPLACE FUNCTION public.housing_schema_version() RETURNS integer
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
    PERFORM id, url, title, price, bedrooms, bathrooms, discovered_at, is_evaluated,
        red_flags, pros, suitability_score, true_gross_rent, effective_monthly_rent, rent_terms, is_fee, fee_estimate,
        is_notified, status, location_area, neighborhood, is_preferred, source,
        normalized_address, cross_posted_sources, id_hash, commute_minutes,
        commute_summary, manhattan_commute_minutes, manhattan_arrival_station, manhattan_commute_summary,
        broker_email, building_health, applied_at, nudge_notified,
        nudged_at, nudge_count, evaluation_status, evaluation_attempts,
        evaluation_next_at, evaluation_last_error, evaluation_completed_at,
        evaluation_claim_token, evaluation_claim_expires_at FROM public.listings LIMIT 0;
    PERFORM id, listing_address, broker_email, broker_name, proposed_time,
        proposed_datetime, special_instructions, status, created_at FROM public.tour_schedules LIMIT 0;
    IF NOT EXISTS (SELECT 1 FROM public.evaluation_control WHERE id = 1) THEN
        RAISE EXCEPTION 'Missing evaluation control';
    END IF;
    PERFORM next_request_at, pause_until FROM public.evaluation_control LIMIT 0;
    RETURN 1;
END $$;

CREATE OR REPLACE FUNCTION public.housing_queue_recover() RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE at_time timestamptz; affected integer;
BEGIN
    PERFORM id FROM public.evaluation_control WHERE id = 1 FOR UPDATE;
    at_time := clock_timestamp();
    UPDATE public.listings SET
        evaluation_status = CASE WHEN evaluation_attempts >= 3 THEN 'failed' ELSE 'retry_wait' END,
        evaluation_next_at = CASE WHEN evaluation_attempts >= 3 THEN NULL
            WHEN evaluation_attempts = 1 THEN at_time + interval '1 minute' ELSE at_time + interval '5 minutes' END,
        evaluation_last_error = 'Evaluation interrupted; claim expired.',
        evaluation_claim_token = NULL, evaluation_claim_expires_at = NULL
    WHERE evaluation_status = 'processing' AND evaluation_claim_expires_at <= at_time AND is_evaluated = false;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected;
END $$;

CREATE OR REPLACE FUNCTION public.housing_queue_pause_until() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
    SELECT pause_until FROM public.evaluation_control WHERE id = 1;
$$;

CREATE OR REPLACE FUNCTION public.housing_queue_claim(p_exclude text[] DEFAULT '{}', p_no_retries boolean DEFAULT false)
RETURNS SETOF public.listings
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE at_time timestamptz; chosen text;
BEGIN
    PERFORM public.housing_queue_recover();
    at_time := clock_timestamp();
    IF EXISTS (SELECT 1 FROM public.evaluation_control WHERE id = 1 AND pause_until > at_time) THEN RETURN; END IF;
    SELECT id INTO chosen FROM public.listings
    WHERE is_evaluated = false AND COALESCE(status, 'inbox') <> 'passed'
        AND evaluation_status IN ('pending', 'retry_wait') AND evaluation_attempts < 3
        AND (evaluation_next_at IS NULL OR evaluation_next_at <= at_time)
        AND (NOT p_no_retries OR evaluation_attempts = 0)
        AND NOT (id = ANY(COALESCE(p_exclude, '{}'::text[])))
    ORDER BY COALESCE(evaluation_next_at, discovered_at), discovered_at, id
    LIMIT 1 FOR UPDATE SKIP LOCKED;
    RETURN QUERY UPDATE public.listings SET evaluation_status = 'processing',
        evaluation_attempts = evaluation_attempts + 1, evaluation_claim_token = gen_random_uuid()::text,
        evaluation_claim_expires_at = at_time + interval '5 minutes', evaluation_next_at = NULL
    WHERE id = chosen RETURNING *;
END $$;

CREATE OR REPLACE FUNCTION public.housing_queue_fail(p_id text, p_token text, p_error text) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE at_time timestamptz := clock_timestamp(); affected integer;
BEGIN
    UPDATE public.listings SET
        evaluation_status = CASE WHEN evaluation_attempts >= 3 THEN 'failed' ELSE 'retry_wait' END,
        evaluation_next_at = CASE WHEN evaluation_attempts >= 3 THEN NULL
            WHEN evaluation_attempts = 1 THEN at_time + interval '1 minute' ELSE at_time + interval '5 minutes' END,
        evaluation_last_error = p_error, evaluation_claim_token = NULL, evaluation_claim_expires_at = NULL
    WHERE id = p_id AND evaluation_claim_token = p_token AND evaluation_status = 'processing'
        AND evaluation_claim_expires_at > clock_timestamp() AND is_evaluated = false;
    GET DIAGNOSTICS affected = ROW_COUNT; RETURN affected;
END $$;

CREATE OR REPLACE FUNCTION public.housing_queue_release(p_id text, p_token text, p_error text, p_next_at timestamptz DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE affected integer;
BEGIN
    UPDATE public.listings SET evaluation_status = CASE WHEN p_next_at IS NULL THEN 'pending' ELSE 'retry_wait' END,
        evaluation_next_at = p_next_at, evaluation_attempts = evaluation_attempts - 1,
        evaluation_last_error = p_error, evaluation_claim_token = NULL, evaluation_claim_expires_at = NULL
    WHERE id = p_id AND evaluation_claim_token = p_token AND evaluation_status = 'processing'
        AND evaluation_claim_expires_at > clock_timestamp() AND is_evaluated = false;
    GET DIAGNOSTICS affected = ROW_COUNT; RETURN affected;
END $$;

CREATE OR REPLACE FUNCTION public.housing_queue_complete(p_id text, p_token text, p_price integer, p_evaluation jsonb, p_health text)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE affected integer;
BEGIN
    UPDATE public.listings SET id_hash = COALESCE(id_hash, md5(id)), price = p_price,
        true_gross_rent = floor((p_evaluation->>'true_gross_rent')::numeric + 0.5)::integer,
        effective_monthly_rent = (p_evaluation->>'effective_monthly_rent')::numeric,
        rent_terms = p_evaluation->>'rent_terms',
        is_fee = (p_evaluation->>'is_fee')::boolean, fee_estimate = p_evaluation->>'fee_estimate',
        red_flags = p_evaluation->>'red_flags', pros = p_evaluation->>'pros',
        suitability_score = floor((p_evaluation->>'suitability_score')::numeric + 0.5)::integer,
        neighborhood = p_evaluation->>'neighborhood', is_preferred = (p_evaluation->>'is_preferred_neighborhood')::boolean,
        commute_minutes = floor((p_evaluation->>'commute_minutes')::numeric + 0.5)::integer,
        commute_summary = p_evaluation->>'commute_summary', building_health = p_health,
        manhattan_commute_minutes = (p_evaluation->>'manhattan_commute_minutes')::real,
        manhattan_arrival_station = p_evaluation->>'manhattan_arrival_station',
        manhattan_commute_summary = p_evaluation->>'manhattan_commute_summary',
        location_area = p_evaluation->>'location_area', is_evaluated = true,
        evaluation_status = 'completed', evaluation_completed_at = clock_timestamp(),
        evaluation_next_at = NULL, evaluation_last_error = NULL, evaluation_claim_token = NULL, evaluation_claim_expires_at = NULL
    WHERE id = p_id AND evaluation_claim_token = p_token AND evaluation_status = 'processing'
        AND evaluation_claim_expires_at > clock_timestamp() AND is_evaluated = false;
    GET DIAGNOSTICS affected = ROW_COUNT; RETURN affected;
END $$;

CREATE OR REPLACE FUNCTION public.housing_queue_pause(p_ms double precision DEFAULT 300000) RETURNS timestamptz
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE result timestamptz;
BEGIN
    UPDATE public.evaluation_control SET pause_until = greatest(pause_until,
        clock_timestamp() + greatest(300000, p_ms) * interval '1 millisecond')
    WHERE id = 1 RETURNING pause_until INTO result;
    RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.housing_queue_reserve() RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE at_time timestamptz; affected integer;
BEGIN
    PERFORM id FROM public.evaluation_control WHERE id = 1 FOR UPDATE;
    at_time := clock_timestamp();
    UPDATE public.evaluation_control SET next_request_at = at_time + interval '5 seconds'
    WHERE id = 1 AND (next_request_at IS NULL OR next_request_at <= at_time)
        AND (pause_until IS NULL OR pause_until <= at_time);
    GET DIAGNOSTICS affected = ROW_COUNT; RETURN affected = 1;
END $$;

CREATE OR REPLACE FUNCTION public.housing_record_nudge(p_id text) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE affected integer;
BEGIN
    UPDATE public.listings SET nudged_at = CURRENT_TIMESTAMP, nudge_count = COALESCE(nudge_count, 0) + 1 WHERE id = p_id;
    GET DIAGNOSTICS affected = ROW_COUNT; RETURN affected;
END $$;

CREATE OR REPLACE FUNCTION public.housing_mark_applied(p_action text) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE affected integer;
BEGIN
    UPDATE public.listings SET status = 'applied', applied_at = CURRENT_TIMESTAMP WHERE id = p_action OR id_hash = p_action;
    GET DIAGNOSTICS affected = ROW_COUNT; RETURN affected;
END $$;

CREATE OR REPLACE FUNCTION public.housing_pending_nudges() RETURNS SETOF public.listings
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
    SELECT * FROM public.listings WHERE status = 'applied' AND broker_email IS NOT NULL
        AND (nudge_notified IS NULL OR nudge_notified = false) AND (nudge_count IS NULL OR nudge_count = 0)
        AND applied_at IS NOT NULL AND applied_at <= CURRENT_TIMESTAMP - interval '24 hours'
    ORDER BY applied_at, id LIMIT 5;
$$;

CREATE OR REPLACE FUNCTION public.housing_record_duplicate(p_address text, p_url text, p_source text)
RETURNS SETOF public.listings LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE existing public.listings; sources jsonb;
BEGIN
    SELECT * INTO existing FROM public.listings WHERE normalized_address = p_address ORDER BY id LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    IF existing.url IS DISTINCT FROM p_url THEN
        BEGIN sources := COALESCE(existing.cross_posted_sources, '[]')::jsonb;
        EXCEPTION WHEN invalid_text_representation THEN sources := '[]'::jsonb; END;
        IF jsonb_typeof(sources) <> 'array' THEN sources := '[]'::jsonb; END IF;
        IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(sources) s WHERE s->>'url' = p_url) THEN
            UPDATE public.listings SET cross_posted_sources = (sources || jsonb_build_object(
                'source', p_source, 'url', p_url, 'discovered_at', clock_timestamp()))::text WHERE id = existing.id;
        END IF;
    END IF;
    RETURN NEXT existing;
END $$;

-- PostgreSQL defaults new functions to PUBLIC EXECUTE. Revoke explicitly, including
-- Supabase's possible default grants, before the transaction commits.
DO $$
DECLARE fn regprocedure;
BEGIN
    FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = ANY(ARRAY[
            'housing_schema_version', 'housing_queue_recover', 'housing_queue_pause_until', 'housing_queue_claim',
            'housing_queue_fail', 'housing_queue_release', 'housing_queue_complete', 'housing_queue_pause',
            'housing_queue_reserve', 'housing_record_nudge', 'housing_mark_applied', 'housing_pending_nudges', 'housing_record_duplicate'])
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END $$;
SELECT public.housing_schema_version();
NOTIFY pgrst, 'reload schema';
